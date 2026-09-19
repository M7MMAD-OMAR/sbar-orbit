/**
 * Starting with the person's logon, on Windows.
 *
 * The Linux half of this is `src/autostart.ts`, systemd user units plus an XDG autostart entry, and
 * the macOS half is `src/macos-autostart.ts`, a LaunchAgent. This is the third, and it is the one
 * the project deliberately did not have: every Windows install so far ran with `--no-service`, so
 * `docs/support-tiers.md` recorded autostart there as not measured.
 *
 * WHY THIS IS NOT A WINDOWS SERVICE, and must never become one. Measured on the Windows 11 guest and
 * recorded in docs/windows-measured.md section 1: a Chromium family browser launched from session 0
 * as SYSTEM exits at once and never publishes `DevToolsActivePort`, with or without `--headless` and
 * with or without `--no-sandbox`. The same launch handed to the interactive session answered CDP on
 * the first attempt. A service runs in session 0. So a service would install cleanly, start cleanly,
 * and then be unable to do the one thing the broker exists for. There is no analogue of
 * `loginctl enable-linger` here either: the broker starts when the person logs on, and not before.
 *
 * WHICH PER USER MECHANISM, decided by measurement on the guest rather than by reading. Three were
 * armed together and the machine was rebooted:
 *
 *   - A SCHEDULED TASK with a logon trigger. Chosen.
 *   - The HKCU `Run` key. Armed and correct, and it did not fire on this guest's logon.
 *   - A `.cmd` in the per user Startup folder. Same: armed, correct, did not fire.
 *
 * The Run key and the Startup folder are both Explorer's doing, and on the reboot both were still
 * armed afterwards, neither was disabled in `StartupApproved`, Explorer was running as the person in
 * session 1, and neither payload wrote a line. Run by hand, the same `.cmd` the Run key names ran
 * perfectly and reached session 1. So both mechanisms are sound and neither is dependable: what they
 * depend on is Explorer's own startup sweep, which this guest's first logon after an OOBE pass did
 * not complete for them. The scheduled task does not go through Explorer at all, and it fired 21
 * seconds after boot with `Last Result: 0`.
 *
 * WHY `schtasks /Create /XML` AND NOT `/SC ONLOGON`. The obvious spelling is refused. Measured as
 * the ordinary unelevated interactive user:
 *
 *     schtasks /Create /TN OrbitAutostartProbeOnlogon /TR ... /SC ONLOGON /F
 *     ERROR: Access is denied.        (exit 1, as muhmad\orbittest, elevated: False)
 *
 * with and without `/RU` and `/RL`. `/SC ONLOGON` with no user is a trigger for ANY user logging on,
 * which is a machine wide change, and an unelevated caller may not make one. A `LogonTrigger`
 * carrying this account's own SID is a change to this one account, and that one is permitted: the
 * same task imported from XML returned `SUCCESS` at exit 0 from the same unelevated shell. Orbit
 * installs per user with no privilege on Linux and macOS, and an autostart that needed an
 * administrator would be a different product. So the XML form is not a preference, it is the only
 * form of this mechanism that fits the install this project ships.
 *
 * WHAT THE TASK MUST CARRY, each for a measured reason:
 *
 *   - `LogonType InteractiveToken` and `RunLevel LeastPrivilege`. The interactive token is the
 *     session 0 question restated: a task with a password based logon type would run in the wrong
 *     place for a browser. Least privilege because Orbit asks for none.
 *   - `ExecutionTimeLimit PT0S`, no limit. The default is three days, after which Task Scheduler
 *     stops the task, and the broker is meant to outlive that.
 *   - `MultipleInstancesPolicy IgnoreNew`. A second broker on one socket is refused by `claimSocket`
 *     anyway, and this makes that never happen rather than happen and be handled.
 *   - No `Delay`. The delay in the probe existed to stagger three mechanisms against each other.
 *
 * Nothing here elevates, writes outside the person's own account, or touches a machine wide key.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrbitError } from "./errors";

/** The task's name, and the marker that proves Orbit wrote a task before anything removes one. */
export const TASK_NAME = "SbarOrbitBroker";
export const TASK_DESCRIPTION = "Sbar Orbit local broker, started when you log in";

/**
 * Escape a string for XML text content.
 *
 * A Windows path can contain `&`, and a task XML with an unescaped ampersand is not task XML:
 * `schtasks /Create /XML` refuses the whole file. Five entities, which is the whole set XML defines.
 * Same rule and same reason as `xml()` in `src/macos-autostart.ts`.
 */
function xml(value: string) {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

/**
 * The broker's logon task.
 *
 * UTF-16 is not decoration: the declaration says `encoding="UTF-16"` and `schtasks /Create /XML`
 * reads the file according to it, so the file is written as UTF-16LE with a BOM by `enableLogonTask`.
 *
 * The command is `cmd.exe /c "<launcher>" serve --managed-socket` rather than the launcher directly.
 * `bin\sbar-orbit.cmd` is a batch file, and Task Scheduler's `Exec` is a `CreateProcess` call, which
 * does not run one: the interpreter has to be named. `/c` rather than `/k` so the shell exits with
 * the broker instead of waiting for input nothing will ever type.
 *
 * `--managed-socket` for the same reason the systemd unit passes it: this is THE broker, on the
 * fixed path the connector configuration and every later command already name.
 */
export function brokerTaskXml(launcher: string, sid: string, environment: Record<string, string> = {}) {
  // Set by the shell before the launcher runs, which is how an `Exec` action gets an environment at
  // all: a task inherits no shell profile. The same defect the macOS LaunchAgent port measured.
  const prefix = Object.entries(environment).map(([key, value]) => `set &quot;${xml(key)}=${xml(value)}&quot; &amp;&amp; `).join("");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(TASK_DESCRIPTION)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(sid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ${prefix}&quot;${xml(launcher)}&quot; serve --managed-socket</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

async function schtasks(...args: string[]) {
  const child = Bun.spawn(["schtasks.exe", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, output: `${out}${err}`.trim() };
}

/**
 * This account's SID, which is what scopes the logon trigger to one user.
 *
 * `whoami /user` rather than a .NET call, because there is no native code here and this is the
 * documented spelling that needs no privilege. The SID is asserted to look like one rather than
 * interpolated blindly: it lands inside XML that Task Scheduler will act on.
 */
export async function currentUserSid(): Promise<string> {
  const child = Bun.spawn(["whoami.exe", "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
  const output = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0) throw new OrbitError("UNSUPPORTED", "Could not read this account's SID");
  const sid = /(S-1-[0-9-]+)/.exec(output)?.[1];
  if (!sid) throw new OrbitError("UNSUPPORTED", `Could not read this account's SID from: ${output.slice(0, 200)}`);
  return sid;
}

export type LogonTaskStatus = {
  taskPresent: boolean;
  /** Registered AND enabled. A disabled task is present and will not fire, and those are different answers. */
  enabled: boolean;
  /** Whether the registered task is Orbit's own, by its description. A foreign task of this name is not ours. */
  orbitOwned: boolean;
  /** Always false, and said rather than omitted: Windows has no lingering, so a logon is required. */
  startsAtBoot: boolean;
  startsWithTheDesktop: boolean;
  /** Task Scheduler's own last result code, or null when it has never run. `0` means the last run succeeded. */
  lastResult: string | null;
  notes: string[];
};

/**
 * What is actually registered, read back from Task Scheduler rather than from what Orbit wrote.
 *
 * `/XML` rather than `/FO LIST`, because the list form does not carry the description on this build
 * in a way that survives localisation, and the description is the ownership marker. The same shape
 * the macOS half uses: the file is asked what label it carries, not assumed.
 */
/** Task Scheduler names are machine-wide even when the trigger is per-user. */
export function taskNameForUser(sid: string) {
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new OrbitError("CONFIG_REQUIRED", "Invalid Windows account SID");
  return `${TASK_NAME}-${sid}`;
}

export async function logonTaskStatus(requestedName?: string): Promise<LogonTaskStatus> {
  const notes: string[] = [];
  notes.push("A Windows logon task runs while you are logged in. Windows has no equivalent of lingering, so the broker does not start at boot before a logon.");
  if (process.platform !== "win32") {
    notes.push("This is the Windows autostart mechanism and this is not Windows.");
    return { taskPresent: false, enabled: false, orbitOwned: false, startsAtBoot: false, startsWithTheDesktop: false, lastResult: null, notes };
  }
  const taskName = requestedName ?? taskNameForUser(await currentUserSid());
  const described = await schtasks("/Query", "/TN", taskName, "/XML");
  if (!described.ok)
    return { taskPresent: false, enabled: false, orbitOwned: false, startsAtBoot: false, startsWithTheDesktop: false, lastResult: null, notes };
  const orbitOwned = described.output.includes(TASK_DESCRIPTION);
  if (!orbitOwned)
    notes.push(`A scheduled task named ${taskName} is registered and Orbit did not write it. Orbit will not change or remove it.`);
  // The verbose list is where the last result and the enabled state live. Read separately from the
  // XML so a failure to parse one does not lose the other.
  const listed = await schtasks("/Query", "/TN", taskName, "/FO", "LIST", "/V");
  const enabled = !/Scheduled Task State:\s*Disabled/i.test(listed.output);
  const lastResult = /Last Result:\s*(\S+)/.exec(listed.output)?.[1] ?? null;
  if (!enabled) notes.push(`${taskName} is registered and disabled, so it will not start at your next logon.`);
  return {
    taskPresent: true, enabled, orbitOwned,
    startsAtBoot: false,
    startsWithTheDesktop: enabled && orbitOwned,
    lastResult, notes,
  };
}

/**
 * Register the logon task. Idempotent: `/F` replaces Orbit's own, and a second run is a no-op in
 * effect because the XML is generated from the same inputs.
 *
 * It refuses to replace a task of this name that Orbit did not write, which is the precedent
 * `src/local-install.ts` set for the `.cmd` shim and `src/service.ts` set for a unit file. A person
 * who already has a `SbarOrbitBroker` task is somebody whose task this is not, and silently taking
 * the name would take over whatever it runs.
 *
 * `register` exists for the same reason it does on Linux and macOS: `schtasks` reads the real Task
 * Scheduler store whatever this function was told, so a test that skips registration is the only way
 * to exercise the XML without changing what the machine running the suite starts at logon.
 */
export async function enableLogonTask(launcher: string, options: { register?: boolean; sid?: string; environment?: Record<string, string>; startNow?: boolean; taskName?: string } = {}) {
  if (process.platform !== "win32" && options.register !== false)
    throw new OrbitError("UNSUPPORTED", "A Windows logon task can only be registered on Windows");
  const sid = options.sid ?? (options.register !== false ? await currentUserSid() : "S-1-5-21-0-0-0-1000");
  const taskName = options.taskName ?? taskNameForUser(sid);
  const file = Bun.file(launcher);
  if (!await file.exists()) throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file");
  const register = options.register !== false;
  if (register) {
    const existing = await logonTaskStatus(taskName);
    if (existing.taskPresent && !existing.orbitOwned)
      throw new OrbitError("CONFIG_REQUIRED", `A scheduled task named ${taskName} already exists and Orbit did not write it; remove it deliberately`);
  }
  const contents = brokerTaskXml(launcher, sid, options.environment ?? {});
  // UTF-16LE with a BOM, because the declaration says UTF-16 and schtasks believes it. Written with
  // a random name in the temp directory and removed afterwards: the XML is an argument to schtasks,
  // not state, and leaving it behind would leave a file describing the person's autostart lying
  // around where anything could edit it between write and read.
  const path = join(tmpdir(), `sbar-orbit-task-${crypto.randomUUID()}.xml`);
  await writeFile(path, Buffer.from(`\ufeff${contents}`, "utf16le"));
  try {
    if (!register) return { wrote: [path], registered: false, started: false, taskName, xml: contents, status: await logonTaskStatus(taskName) };
    const created = await schtasks("/Create", "/TN", taskName, "/XML", path, "/F");
    // Registration alone starts nothing. The installer requests an on-demand run
    // in the same interactive account, then verifies the broker's actual socket.
    const started = created.ok && options.startNow
      ? await schtasks("/Run", "/TN", taskName) : null;
    return { wrote: [path], registered: created.ok, started: started?.ok ?? false,
      output: started && !started.ok ? started.output : created.output,
      taskName, xml: contents, status: await logonTaskStatus(taskName) };
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

/**
 * Off means the task is out of Task Scheduler's hands.
 *
 * Only Orbit's own task goes, identified by the description it carries, for the same reason the
 * Linux uninstall refuses a unit it did not write and the macOS one refuses a plist without its
 * label. Removing nothing and saying so is the right answer for a machine that has nothing of ours.
 */
export async function disableLogonTask(options: { register?: boolean; taskName?: string } = {}) {
  const taskName = options.taskName ?? (process.platform === "win32" ? taskNameForUser(await currentUserSid()) : TASK_NAME);
  const register = options.register !== false;
  if (!register) return { removed: [], status: await logonTaskStatus(taskName) };
  const before = await logonTaskStatus(taskName);
  if (!before.taskPresent) return { removed: [], status: before };
  if (!before.orbitOwned)
    throw new OrbitError("CONFIG_REQUIRED", `The scheduled task ${taskName} was not written by Orbit; remove it deliberately`);
  const deleted = await schtasks("/Delete", "/TN", taskName, "/F");
  return { removed: deleted.ok ? [taskName] : [], output: deleted.output, status: await logonTaskStatus(taskName) };
}

/**
 * The two mechanisms this design rejected, kept as a function rather than a comment so `status` can
 * tell a person that Orbit deliberately did not write them, and so a later measurement that
 * contradicts this one has a named thing to change.
 */
export const rejectedMechanisms = [
  { id: "run-key", where: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    why: "Armed correctly and did not fire on a measured reboot of the Windows 11 guest, while still armed and not disabled in StartupApproved afterwards. The same command run by hand reached session 1 and drove a browser, so the mechanism is sound and its delivery is Explorer's, which did not run it." },
  { id: "startup-folder", where: "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    why: "Same measurement and same cause: it is the other half of Explorer's startup sweep." },
  { id: "windows-service", where: "Service Control Manager",
    why: "A service runs in session 0, and no Chromium family browser runs in session 0 at all. It would install and start and then be unable to open a browser." },
] as const;

/** Read a task's registered XML, for a report to show what is actually installed. */
export async function registeredTaskXml(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const taskName = taskNameForUser(await currentUserSid());
  const described = await schtasks("/Query", "/TN", taskName, "/XML");
  return described.ok ? described.output : null;
}

/** For a test to read back what `enableLogonTask` would write without registering anything. */
export async function readTaskXmlFile(path: string) {
  const bytes = await readFile(path);
  return bytes.toString("utf16le").replace(/^\ufeff/, "");
}
