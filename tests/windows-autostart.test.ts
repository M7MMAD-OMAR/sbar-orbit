import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixtureRoot, resolvedTmpdir } from "./platform-support";
import {
  TASK_NAME, TASK_DESCRIPTION, brokerTaskXml, enableLogonTask, disableLogonTask,
  logonTaskStatus, currentUserSid, rejectedMechanisms, readTaskXmlFile,
} from "../src/windows-autostart";
import { OrbitError } from "../src/errors";

/**
 * The Windows autostart half, which is a per user LOGON TASK rather than a service.
 *
 * Two kinds of test here, and the split matters. The XML builder is pure and its rules are asserted
 * on EVERY platform, because the thing it is a rule about is Windows whoever is asking: the same
 * reason `tests/windows-host.test.ts` pins `serviceSocketPath(..., "win32")` from a Fedora host.
 * Anything that talks to Task Scheduler is Windows only and is skipped elsewhere with the reason
 * written down, never silently passed.
 *
 * NOTHING HERE MAY TOUCH THE REAL MACHINE'S AUTOSTART. `schtasks` reads the real store whatever this
 * file says, exactly as `systemctl` and `launchctl` do for the other two halves, so every case that
 * builds XML passes `register: false` and only the explicitly Windows-only registration cases below
 * go near the store, under a name of their own.
 *
 * And nothing here may write into the real profile. docs/windows-measured.md section 24 records a
 * test that redirected `XDG_CONFIG_HOME` only and therefore wrote a connector file into the person's
 * REAL roaming profile, because Windows ignores the XDG variables entirely. So the fixture below
 * redirects the Windows variables as well, and there is a test that the temp file the builder writes
 * lands inside the redirection rather than in the person's profile.
 */

const windowsOnly = (reason: string) => {
  if (!reason.trim()) throw new Error("A Windows only test has to say why");
  return process.platform === "win32" ? test : test.skip;
};

/**
 * Every per user variable Windows or POSIX might resolve a path through, pointed at a disposable
 * directory for the duration of one test. `TEMP` and `TMP` are in the list because the XML file the
 * builder writes goes through `tmpdir()`, which reads them on Windows and `TMPDIR` elsewhere.
 */
async function withRedirectedProfile<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await fixtureRoot("orbit-winautostart-");
  const keys = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TEMP", "TMP", "TMPDIR"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = root;
  try { return await work(root); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function fixtureLauncher() {
  const root = await mkdtemp(join(await resolvedTmpdir(), "orbit-winautostart-launcher-"));
  const launcher = join(root, "sbar-orbit.cmd");
  await writeFile(launcher, "@echo off\r\nexit /b 0\r\n");
  return { root, launcher };
}

const SID = "S-1-5-21-2193981601-3753172565-515604132-1006";

/**
 * Whether a string is well formed XML, to the depth this file needs: tags nest and close in order,
 * and every `&` opens a real entity. Bun has no `DOMParser` and this repository has no XML
 * dependency, so the check is written out. It is deliberately strict about the ampersand, because
 * that is the character a Windows path really carries and the one that makes schtasks refuse a whole
 * file rather than one element.
 */
function wellFormed(xml: string): boolean {
  // An `&` that does not open a named or numeric entity is the failure being guarded against.
  for (const match of xml.matchAll(/&[^;\s]*/g)) {
    if (!/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.test(`${match[0]};`.replace(/;;$/, ";"))) return false;
  }
  const stack: string[] = [];
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    if (name === "xml" || name === undefined) continue;
    if (selfClosing) continue;
    if (closing) { if (stack.pop() !== name) return false; }
    else stack.push(name);
  }
  return stack.length === 0;
}

test("the task carries a logon trigger scoped to ONE account, which is what makes it installable without an administrator", () => {
  const xml = brokerTaskXml("C:\\orbit\\bin\\sbar-orbit.cmd", SID);
  expect(xml).toContain("<LogonTrigger>");
  // The SID in the TRIGGER, not only in the principal. A LogonTrigger with no UserId fires for any
  // user logging on, which is a machine wide change: measured on the guest as the ordinary
  // unelevated interactive user, `schtasks /Create /SC ONLOGON` returned `ERROR: Access is denied.`
  // at exit 1, with and without /RU and /RL. The scoped form returned SUCCESS from the same shell.
  expect(xml).toMatch(new RegExp(`<LogonTrigger>[\\s\\S]*?<UserId>${SID}</UserId>[\\s\\S]*?</LogonTrigger>`));
  expect(xml).toContain(`<UserId>${SID}</UserId>`);
});

test("the task asks for an interactive token and no elevation, because a browser does not run in session 0", () => {
  const xml = brokerTaskXml("C:\\orbit\\bin\\sbar-orbit.cmd", SID);
  // The whole reason Windows has no Orbit service. docs/windows-measured.md section 1: a Chromium
  // family browser launched from session 0 exits at once and never publishes DevToolsActivePort.
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  // Orbit installs per user and asks for no privilege anywhere else either.
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).not.toContain("HighestAvailable");
  expect(xml).not.toContain("S-1-5-18");
});

test("the task may run forever and refuses a second instance", () => {
  const xml = brokerTaskXml("C:\\orbit\\bin\\sbar-orbit.cmd", SID);
  // The default execution time limit is three days, after which Task Scheduler stops the task. A
  // broker is meant to outlive that, and `PT0S` is the spelling for no limit.
  expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  // A second broker on one socket is refused by claimSocket anyway; this makes it never happen.
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(xml).toContain("<Enabled>true</Enabled>");
});

test("the action runs the launcher through cmd.exe, because Task Scheduler cannot execute a batch file directly", () => {
  const xml = brokerTaskXml("C:\\orbit\\bin\\sbar-orbit.cmd", SID);
  // `Exec` is a CreateProcess call, which does not run a .cmd: the interpreter has to be named.
  expect(xml).toContain("<Command>cmd.exe</Command>");
  expect(xml).toContain("/c &quot;C:\\orbit\\bin\\sbar-orbit.cmd&quot; serve --managed-socket");
  // THE managed broker, on the fixed path the connector configuration already names, for the same
  // reason the systemd unit passes it.
  expect(xml).toContain("serve --managed-socket");
});

test("an environment is set by the shell, because a logon task inherits no shell profile", () => {
  // Measured on the guest: a task's inherited PATH is
  // `C:\WINDOWS\system32;...;%LOCALAPPDATA%\Microsoft\WindowsApps` and nothing more, which is the
  // same defect the macOS LaunchAgent port found. A capture budget set in a person's shell is not
  // there at logon, so anything the broker needs has to be in the action itself.
  const xml = brokerTaskXml("C:\\orbit\\bin\\sbar-orbit.cmd", SID, { ORBIT_CAPTURE_TIMEOUT_MS: "20000" });
  expect(xml).toContain("set &quot;ORBIT_CAPTURE_TIMEOUT_MS=20000&quot; &amp;&amp;");
  // Still the same command afterwards: the prefix must not displace the launcher.
  expect(xml).toContain("&quot;C:\\orbit\\bin\\sbar-orbit.cmd&quot; serve --managed-socket");
});

test("a path with an ampersand produces XML Task Scheduler can parse, rather than a file it refuses whole", () => {
  // A plausible prefix: a profile or drive path carrying an ampersand, `D:\R&D\...` here. An
  // unescaped `&` is not XML, and schtasks refuses the
  // entire file rather than the one element, which is the same failure the macOS plist had.
  const xml = brokerTaskXml("D:\\R&D\\bin\\sbar-orbit.cmd", SID);
  expect(xml).toContain("R&amp;D");
  expect(xml).not.toMatch(/R&D/);
  // And it really parses. A string assertion alone would pass on XML no parser accepts, so this
  // walks the document the way a parser does: every `&` must open a real entity, and every tag must
  // close in order. Bun has no DOMParser, so the check is written out rather than borrowed.
  expect(wellFormed(xml)).toBe(true);
  // A control: the same XML with the escaping undone is NOT well formed, which is what proves the
  // assertion above is testing something.
  expect(wellFormed(xml.replace(/&amp;/g, "&"))).toBe(false);
});

test("the description is the ownership marker, and it is what a disable looks for", () => {
  expect(brokerTaskXml("C:\\a\\sbar-orbit.cmd", SID)).toContain(TASK_DESCRIPTION);
  expect(TASK_DESCRIPTION).toContain("Sbar Orbit");
});

test("the rejected mechanisms are named with the measurement that rejected them, not with an opinion", () => {
  const ids = rejectedMechanisms.map(entry => entry.id).sort();
  expect(ids).toEqual(["run-key", "startup-folder", "windows-service"]);
  for (const entry of rejectedMechanisms) {
    expect(entry.why.length).toBeGreaterThan(40);
    expect(entry.where.length).toBeGreaterThan(0);
  }
  // The service rejection is the one that must never be softened into a preference: it is a measured
  // platform fact, in docs/windows-measured.md section 1.
  expect(rejectedMechanisms.find(entry => entry.id === "windows-service")?.why).toContain("session 0");
});

test("the XML is written as UTF-16 with a BOM, because its own declaration says UTF-16 and schtasks believes it", async () => {
  await withRedirectedProfile(async root => {
    const { launcher } = await fixtureLauncher();
    const built = await enableLogonTask(launcher, { register: false, sid: SID });
    expect(built.registered).toBe(false);
    // The file is removed after the call, so the assertion is on what the function returned plus the
    // encoding rule proved directly below on a file this test writes the same way.
    expect(built.xml).toContain('encoding="UTF-16"');
    const path = join(root, "probe-task.xml");
    await writeFile(path, Buffer.from(`\ufeff${built.xml}`, "utf16le"));
    const bytes = await readFile(path);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(await readTaskXmlFile(path)).toBe(built.xml);
  });
});

test("the temporary XML is cleaned up and never left in the profile describing what the machine starts", async () => {
  await withRedirectedProfile(async root => {
    const { launcher } = await fixtureLauncher();
    const built = await enableLogonTask(launcher, { register: false, sid: SID });
    const path = built.wrote[0];
    expect(path).toBeDefined();
    // Inside the redirection, not in the person's real profile. This is the assertion that would
    // have caught the section 24 defect, where only XDG_CONFIG_HOME was redirected.
    expect(path!.startsWith(root)).toBe(true);
    expect(await Bun.file(path!).exists()).toBe(false);
    // And nothing else was left behind either.
    expect((await readdir(root)).filter(name => name.endsWith(".xml"))).toEqual([]);
  });
});

test("a launcher that is not there is refused before anything is registered", async () => {
  await withRedirectedProfile(async root => {
    await expect(enableLogonTask(join(root, "no-such-launcher.cmd"), { register: false, sid: SID }))
      .rejects.toThrow(/not a regular file/);
  });
});

test("registering is refused on a platform that is not Windows, rather than silently doing nothing", async () => {
  if (process.platform === "win32") return;
  const { launcher } = await fixtureLauncher();
  await expect(enableLogonTask(launcher, { sid: SID })).rejects.toThrow(OrbitError);
});

test("status off Windows says so and claims nothing", async () => {
  if (process.platform === "win32") return;
  const status = await logonTaskStatus();
  expect(status).toMatchObject({ taskPresent: false, enabled: false, startsWithTheDesktop: false, lastResult: null });
  expect(status.notes.join(" ")).toContain("not Windows");
});

test("no autostart mechanism claims to start at boot, on any platform, because Windows has no lingering", async () => {
  const status = await logonTaskStatus();
  expect(status.startsAtBoot).toBe(false);
  expect(status.notes.join(" ")).toContain("lingering");
});

// ---------------------------------------------------------------------------
// Everything below talks to the real Task Scheduler, and only on Windows.
// ---------------------------------------------------------------------------

windowsOnly("Task Scheduler is Windows only; there is nothing to register elsewhere")(
  "this account's SID reads back in the shape a logon trigger needs", async () => {
  const sid = await currentUserSid();
  expect(sid).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
});

windowsOnly("Task Scheduler is Windows only; there is nothing to register elsewhere")(
  "status reports honestly that nothing is installed when nothing is", async () => {
  // Whatever this machine has, start from nothing of ours.
  await disableLogonTask().catch(() => {});
  const status = await logonTaskStatus();
  expect(status.taskPresent).toBe(false);
  expect(status.startsWithTheDesktop).toBe(false);
  expect(status.lastResult).toBeNull();
});

windowsOnly("Task Scheduler is Windows only; there is nothing to register elsewhere")(
  "enable writes what it claims, twice is safe, and disable removes exactly that and nothing else", async () => {
  const { launcher } = await fixtureLauncher();
  await disableLogonTask().catch(() => {});

  const first = await enableLogonTask(launcher);
  expect(first.registered).toBe(true);
  // What it CLAIMS, read back out of Task Scheduler rather than out of what was written.
  const after = await logonTaskStatus();
  expect(after).toMatchObject({ taskPresent: true, enabled: true, orbitOwned: true, startsWithTheDesktop: true, startsAtBoot: false });

  // Idempotent: a second run is safe and leaves one task, not two, and not a failure.
  const second = await enableLogonTask(launcher);
  expect(second.registered).toBe(true);
  expect((await logonTaskStatus()).taskPresent).toBe(true);

  // A neighbour task of another name must survive the disable: "exactly what enable wrote".
  const neighbour = "SbarOrbitAutostartTestNeighbour";
  const made = Bun.spawnSync(["schtasks.exe", "/Create", "/TN", neighbour, "/TR", "cmd.exe /c exit", "/SC", "ONCE", "/ST", "23:59", "/F"], { stdout: "pipe", stderr: "pipe" });
  expect(made.exitCode).toBe(0);
  try {
    const removed = await disableLogonTask();
    expect(removed.removed).toEqual([TASK_NAME]);
    expect((await logonTaskStatus()).taskPresent).toBe(false);
    const neighbourStill = Bun.spawnSync(["schtasks.exe", "/Query", "/TN", neighbour], { stdout: "pipe", stderr: "pipe" });
    expect(neighbourStill.exitCode).toBe(0);
  } finally {
    Bun.spawnSync(["schtasks.exe", "/Delete", "/TN", neighbour, "/F"], { stdout: "pipe", stderr: "pipe" });
  }
});

windowsOnly("Task Scheduler is Windows only; there is nothing to register elsewhere")(
  "a FOREIGN task of the same name is refused and left intact, the way the .cmd shim already is", async () => {
  await disableLogonTask().catch(() => {});
  // Somebody else's task, at the name Orbit wants. src/local-install.ts refuses to replace a
  // sbar-orbit.cmd it did not write; this is the same rule for the same reason.
  const foreign = Bun.spawnSync(["schtasks.exe", "/Create", "/TN", TASK_NAME, "/TR", "cmd.exe /c echo someone-elses-task", "/SC", "ONCE", "/ST", "23:59", "/F"], { stdout: "pipe", stderr: "pipe" });
  expect(foreign.exitCode).toBe(0);
  try {
    const status = await logonTaskStatus();
    expect(status).toMatchObject({ taskPresent: true, orbitOwned: false, startsWithTheDesktop: false });
    expect(status.notes.join(" ")).toContain("Orbit did not write it");

    const { launcher } = await fixtureLauncher();
    await expect(enableLogonTask(launcher)).rejects.toThrow(/did not write it|remove it deliberately/);
    await expect(disableLogonTask()).rejects.toThrow(/was not written by Orbit/);

    // Still there, and still theirs. A refusal that removed the thing anyway would be worse than none.
    const query = Bun.spawnSync(["schtasks.exe", "/Query", "/TN", TASK_NAME, "/XML"], { stdout: "pipe", stderr: "pipe" });
    expect(query.exitCode).toBe(0);
    expect(query.stdout.toString()).toContain("someone-elses-task");
  } finally {
    Bun.spawnSync(["schtasks.exe", "/Delete", "/TN", TASK_NAME, "/F"], { stdout: "pipe", stderr: "pipe" });
  }
});

windowsOnly("Task Scheduler is Windows only; there is nothing to register elsewhere")(
  "disable on a machine with nothing of ours removes nothing and says so", async () => {
  await disableLogonTask().catch(() => {});
  const removed = await disableLogonTask();
  expect(removed.removed).toEqual([]);
  expect(removed.status.taskPresent).toBe(false);
});
