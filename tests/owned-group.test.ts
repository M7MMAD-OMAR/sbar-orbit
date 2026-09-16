import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the Python subreaper and its /proc walk, which a Windows job object replaces outright");
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ownsGroup, sweepOwnedGroup } from "../src/owned-group";
import { tmpdir } from "node:os";

// A supervisor asked to stop reaps its own tree, which tests/native-crash.test.ts already covers.
// These cover the other death: the supervisor is killed outright, runs nothing on the way out, and
// leaves a running application that is nobody's child. No display and no compositor are involved,
// so this runs on any Linux host inside the Orbit budget.
const alive = (pid: number) => Bun.file(`/proc/${pid}/stat`).exists();
const stubborn = "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(120)\n";

async function supervise(directory: string, code: string, runtime = directory) {
  const report = join(directory, `report-${crypto.randomUUID()}.json`);
  const child = Bun.spawn(["/usr/bin/python3", "src/native/supervise.py", report, "/usr/bin/python3", "-c", code],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_RUNTIME_DIR: runtime } });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const application = JSON.parse(await readFile(report, "utf8")).pid;
      if (application) return { child, application: Number(application) };
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("Supervisor never reported an application");
}

test("an application outlives a supervisor that is killed, and the sweep ends it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-owned-group-"));
  const { child, application } = await supervise(directory, stubborn);
  try {
    child.kill("SIGKILL");
    await child.exited;
    // The gap this closes: nothing in the supervisor ran, so the application is still there.
    await Bun.sleep(200);
    expect(await alive(application)).toBe(true);
    expect(await ownsGroup(application, directory)).toBe(true);

    const swept = await sweepOwnedGroup(application, directory);
    // It ignores a graceful stop, so the sweep has to escalate rather than report success and leave.
    expect(swept).toEqual({ swept: true, escalated: true });
    expect(await alive(application)).toBe(false);
    expect(await ownsGroup(application, directory)).toBe(false);
    // Nothing is left to do on a second pass, and a reused identifier must not be signalled.
    expect(await sweepOwnedGroup(application, directory)).toEqual({ swept: false, escalated: false });
  } finally {
    try { process.kill(-application, "SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("a group that stops on request is not escalated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-owned-group-polite-"));
  const { child, application } = await supervise(directory, "import time\ntime.sleep(120)\n");
  try {
    child.kill("SIGKILL");
    await child.exited;
    expect(await sweepOwnedGroup(application, directory)).toEqual({ swept: true, escalated: false });
    expect(await alive(application)).toBe(false);
  } finally {
    try { process.kill(-application, "SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("a process from another session is neither owned nor signalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-owned-group-other-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "orbit-owned-group-elsewhere-"));
  const { child, application } = await supervise(elsewhere, stubborn);
  try {
    child.kill("SIGKILL");
    await child.exited;
    // Same machine, same user, same shape. The private runtime directory is the only thing that
    // says which session it came from, and it says this one is not ours.
    expect(await ownsGroup(application, directory)).toBe(false);
    expect(await sweepOwnedGroup(application, directory)).toEqual({ swept: false, escalated: false });
    expect(await alive(application)).toBe(true);
  } finally {
    try { process.kill(-application, "SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
}, 20000);

test("a process that does not lead its own group is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-owned-group-member-"));
  // No new session, so it stays in this test runner's group. Signalling that group would reach the
  // test runner and everything beside it, which is exactly what the leader check exists to prevent.
  const member = Bun.spawn(["/usr/bin/python3", "-c", "import time\ntime.sleep(30)\n"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: directory } });
  try {
    expect(await ownsGroup(member.pid, directory)).toBe(false);
    expect(await sweepOwnedGroup(member.pid, directory)).toEqual({ swept: false, escalated: false });
    expect(await alive(member.pid)).toBe(true);
  } finally {
    member.kill("SIGKILL");
    await member.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("identifiers that could reach something else are refused before any signal", async () => {
  for (const pid of [0, 1, -1, 1.5, Number.NaN]) expect(await ownsGroup(pid, "/tmp")).toBe(false);
  expect(await ownsGroup(process.pid, "relative/path")).toBe(false);
});
