/**
 * Starting with the person's login, on macOS.
 *
 * The Linux half of this is `src/autostart.ts`: systemd user units plus an XDG autostart entry. The
 * Windows half is deliberately absent, because a Chromium family browser cannot run in session 0 and
 * the broker therefore lives in the person's own session. macOS has a real answer, and it is a
 * LaunchAgent in the `gui/$UID` domain.
 *
 * Three properties decided the design, and each has a consequence written into the plist:
 *
 *   - A LaunchAgent runs in the person's GUI session and only while they are logged in. There is no
 *     analogue of `loginctl enable-linger`, so `startsAtBoot` is false here and says so rather than
 *     being omitted. A LaunchDaemon would run at boot and would run as root in session 0, which is
 *     both more privilege than Orbit wants and the wrong session for a browser.
 *   - `launchctl bootout gui/$UID/<label>` kills the job's whole process group, measured on a macOS
 *     runner on 14 September 2026: a job with a backgrounded child showed two processes while loaded
 *     and zero after bootout. That is the second containment layer the supervisor's own sweep leans
 *     on, and it is why `AbandonProcessGroup` is deliberately ABSENT from the plist below. Setting it
 *     to true would tell launchd to leave the group alone, which is precisely the guarantee being
 *     relied on.
 *   - A LaunchAgent inherits almost no environment: no PATH worth using, no `HOME` on some versions,
 *     nothing from the person's shell. So the plist names an absolute launcher path and sets the
 *     variables the broker needs, rather than assuming a login shell ran first. This is the same
 *     defect the Linux port found on Ubuntu, where the launcher's PATH dependence broke under a
 *     systemd service that does not have one.
 *
 * Nothing here runs `sudo`, writes outside the person's home, or touches a system domain.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { OrbitError } from "./errors";

export const BROKER_LABEL = "com.sbar.orbit.broker";

export function launchAgentsDirectory(home = homedir(), env = process.env) {
  // POSIX join: this answers about a Mac even when a Windows host computes it. See src/service.ts.
  return env.ORBIT_LAUNCH_AGENTS_DIR || posix.join(home, "Library", "LaunchAgents");
}

export function launchAgentPath(home = homedir(), env = process.env) {
  return posix.join(launchAgentsDirectory(home, env), `${BROKER_LABEL}.plist`);
}

/**
 * Escape a string for XML text content.
 *
 * A home directory can contain `&` and a launcher path can contain almost anything, and a plist with
 * an unescaped ampersand is not a plist: `launchctl bootstrap` refuses the whole file with a parse
 * error that names a byte offset rather than the character. Five entities, which is the whole set
 * XML defines.
 */
function xml(value: string) {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

/**
 * The broker's LaunchAgent.
 *
 * `RunAtLoad` starts it when the agent is bootstrapped and at every login after. `KeepAlive` with
 * `SuccessfulExit false` restarts it when it fails and leaves it alone when it exits cleanly, which
 * is the same policy as the Linux unit's `Restart=on-failure`.
 *
 * `ProcessType Background`, `Nice` and the two low priority IO keys are the scheduling half of the
 * macOS budget, and they are the only half the system enforces. `LowPriorityIO` and
 * `LowPriorityBackgroundIO` keep a session's disk traffic behind the person's, which matters more on
 * a Mac than the CPU hint does: a browser profile write storm is what a person notices.
 *
 * There is no resource limit key here, deliberately. `HardResourceLimits` with a CPU value is
 * `RLIMIT_CPU`, cumulative CPU seconds since exec with a SIGKILL on breach, so it kills a healthy
 * long lived broker for the crime of staying alive while permitting a saturated core for minutes.
 * No value does both jobs, and docs/porting.md records the decision to delete it.
 */
export function brokerAgentPlist(launcher: string, socket: string, home = homedir()) {
  const entries: [string, string][] = [
    ["HOME", home],
    ["ORBIT_SOCKET", socket],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BROKER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(launcher)}</string>
    <string>serve</string>
    <string>--managed-socket</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>LowPriorityBackgroundIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${entries.map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n")}
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(posix.join(home, "Library", "Logs", "sbar-orbit", "broker.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]) {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, output: `${out}${err}`.trim() };
}

/**
 * `/bin/launchctl`, not `/usr/bin/launchctl`.
 *
 * Measured on the macOS 26.6.2 runner, 14 September 2026: `/usr/bin/launchctl` does NOT exist, and a
 * probe that checked for it reported the tool missing on a machine where `launchctl print gui/501`
 * answered fine. Written down here because the wrong path is the plausible one and it fails as a
 * missing prerequisite rather than as a bad path.
 */
export const LAUNCHCTL = "/bin/launchctl";

function guiDomain() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new OrbitError("UNSUPPORTED", "A macOS launch agent needs a uid");
  return `gui/${uid}`;
}

export type LaunchAgentStatus = {
  plistPresent: boolean;
  /** Bootstrapped into the gui domain, which is what makes it start at the next login. */
  loaded: boolean;
  running: boolean;
  /** Always false on macOS, and said rather than omitted: an agent needs a login. */
  startsAtBoot: boolean;
  startsWithTheDesktop: boolean;
  notes: string[];
};

export async function launchAgentStatus(home = homedir(), env = process.env): Promise<LaunchAgentStatus> {
  const path = launchAgentPath(home, env);
  const plistPresent = await stat(path).then(() => true).catch(() => false);
  const printed = await launchctl("print", `${guiDomain()}/${BROKER_LABEL}`);
  // `state = running` is what `launchctl print` calls a job with a live process. A loaded job that
  // is not running is a job launchd knows about and has not started or has let exit, and the two are
  // different answers to "is the broker up": the person's next command will start one either way,
  // and only `running` means it is already there.
  const running = printed.ok && /\bstate = running\b/.test(printed.output);
  const notes: string[] = [];
  notes.push("A macOS launch agent runs while you are logged in. There is no equivalent of lingering, so the broker does not start at boot before a login.");
  if (plistPresent && !printed.ok)
    notes.push("The agent file is in place and launchd has not been told about it. Run sbar-orbit service install, or launchctl bootstrap it by hand.");
  return {
    plistPresent, loaded: printed.ok, running,
    startsAtBoot: false,
    startsWithTheDesktop: plistPresent && printed.ok,
    notes,
  };
}

async function writeAtomic(path: string, contents: string, mode = 0o644) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

/**
 * Write the agent and bootstrap it. Idempotent: a second run boots the old one out first, because
 * `launchctl bootstrap` on a label that is already loaded fails with `Bootstrap failed: 5: Input/output
 * error`, which names nothing a person could act on.
 *
 * `register` exists for the same reason it does on Linux: launchctl reads the real domain whatever
 * directory this was given, so a test that writes its plist elsewhere and still bootstraps is a test
 * that changes what the person's own machine starts at login.
 */
export async function enableLaunchAgent(launcher: string, socket: string, home = homedir(), env = process.env, register = true) {
  try { if (!(await stat(launcher)).isFile()) throw new Error("not a file"); }
  catch { throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file"); }
  const path = launchAgentPath(home, env);
  await mkdir(join(home, "Library", "Logs", "sbar-orbit"), { recursive: true, mode: 0o700 }).catch(() => {});
  await writeAtomic(path, brokerAgentPlist(launcher, socket, home));
  if (!register) return { wrote: [path], bootstrapped: false, status: await launchAgentStatus(home, env) };
  // Boot out first, and ignore the failure: a label that was never loaded returns non zero, which is
  // the ordinary case on a first install rather than a problem.
  await launchctl("bootout", `${guiDomain()}/${BROKER_LABEL}`);
  const bootstrapped = await launchctl("bootstrap", guiDomain(), path);
  return { wrote: [path], bootstrapped: bootstrapped.ok, output: bootstrapped.output, status: await launchAgentStatus(home, env) };
}

/** Off means the job is out of launchd's hands and the file is gone. */
export async function disableLaunchAgent(home = homedir(), env = process.env, register = true) {
  const path = launchAgentPath(home, env);
  const removed: string[] = [];
  if (register) await launchctl("bootout", `${guiDomain()}/${BROKER_LABEL}`);
  // Only Orbit's own file, identified by the label it carries, for the same reason the Linux
  // uninstall refuses a unit it did not write.
  const contents = await readFile(path, "utf8").catch(() => null);
  if (contents !== null) {
    if (!contents.includes(BROKER_LABEL))
      throw new OrbitError("CONFIG_REQUIRED", `${path} was not written by Orbit; remove it deliberately`);
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed, status: await launchAgentStatus(home, env) };
}
