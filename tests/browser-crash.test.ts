import { test, expect } from "bun:test";
import { expectDeclaredImage } from "./frame-format";
import { readFile, readdir } from "node:fs/promises";
import { call, startBroker } from "../src/ipc";
import { descendantsFromTable } from "../src/process-tree";
import { captureProcessWitnesses, windowsWitnessApi, WitnessCaptureError } from "./windows-process-witness";

const ownedParents = new Map<number, number>();

/**
 * Every descendant of a process, per platform.
 *
 * Linux reads `/proc/<pid>/task/<tid>/children`. Windows has no `/proc`, so the same question is put
 * to the kernel through `Win32_Process`, whose `ParentProcessId` builds the same tree. macOS has no
 * `/proc` either and answers through `proc_listchildpids`, which is the same question again.
 * Writing all three rather than skipping the suite is deliberate: the property it guards, that an
 * agent's browser must not outlive the broker that owned it, is the whole reason this project
 * exists, and it is the last thing that should be left unmeasured on a new platform.
 *
 * On macOS this walk is a CROSS CHECK rather than the primary boundary. The tree there is held by a
 * process group, and a descendant walk and a group are not the same set: Chrome's helpers are in the
 * group and a process that calls `setsid` leaves it. Asking the parent/child question anyway is what
 * makes this test able to FAIL for the right reason, since a surviving browser is a descendant of
 * the dead broker whether or not it is still in anybody's group.
 */
async function descendants(pid: number, seen = new Set<number>()): Promise<number[]> {
  if (process.platform === "win32") return windowsDescendants(pid);
  // A guard on the recursion rather than on any one platform's answer. A walk that revisits a pid
  // loops forever, and the cost of finding that out is a suite that hangs rather than fails.
  if (seen.has(pid)) return [];
  seen.add(pid);
  if (process.platform === "darwin") {
    const { childProcesses } = await import("../src/macos");
    const children = childProcesses(pid).filter(child => !seen.has(child));
    return [...children, ...(await Promise.all(children.map(child => descendants(child, seen)))).flat()];
  }
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    const children = new Set<number>();
    for (const task of tasks) {
      try { for (const id of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8")).split(/\s+/).filter(Boolean)) children.add(Number(id)); }
      catch {}
    }
    return [...children, ...(await Promise.all([...children].map(child => descendants(child, seen)))).flat()];
  } catch { return []; }
}

function windowsDescendants(root: number): number[] {
  // One snapshot of the whole table, then walked in memory: asking per process would race a tree
  // that is still starting, and a browser launch creates processes while the walk runs.
  //
  // The walk itself lives in `src/process-tree.ts`. This path returns before `descendants` applies its
  // `seen` guard, because it needs a snapshot rather than one answer per process, so it was the one
  // walk in the file without a guard and it recursed until the stack ended on the Windows runner.
  const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]);
  if (listed.exitCode !== 0) throw new Error("Owned process parent snapshot failed");
  const rows = listed.stdout.toString().split(/\r?\n/);
  const owned = descendantsFromTable(rows, root);
  ownedParents.clear();
  for (const row of rows) {
    const [pid, parent] = row.trim().split(/\s+/).map(Number);
    if (pid !== undefined && parent !== undefined && owned.includes(pid)) ownedParents.set(pid, parent);
  }
  return owned;
}

/** Whether a process is still on the machine, asked the way each kernel answers it. */
async function alive(pid: number): Promise<boolean> {
  if (process.platform === "linux") return Bun.file(`/proc/${pid}/stat`).exists();
  // No `/proc` on either of the others. Signal 0 throws for a pid that is gone, which is the
  // cheapest live check that does not spawn a process per poll. On macOS this was the difference
  // between measuring reaping and reporting every process as dead the moment it was asked about,
  // because `Bun.file("/proc/...")` simply does not exist there and answers false for a live tree.
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("abrupt broker death reaps its browser tree and a fresh broker rejects stale sessions", async () => {
  const brokerProcess = Bun.spawn([process.execPath, "src/cli.ts", "serve"], { stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ORBIT_WINDOWS_CRASH_EVIDENCE: process.platform === "win32" ? "1" : "0" } });
  const reader = brokerProcess.stdout.getReader();
  let brokerStderr = "";
  const errors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of brokerProcess.stderr) brokerStderr = (brokerStderr + decoder.decode(chunk)).slice(-65536);
  })();
  const drainErrors = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([errors, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned broker stderr evidence drain is unconfirmed")), 2000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let witnesses: ReturnType<typeof captureProcessWitnesses> | undefined;
  let closeWitnesses: (() => void) | undefined;
  try {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Broker exited before startup");
      line += new TextDecoder().decode(chunk.value);
    }
    const { socket } = JSON.parse(line.split("\n")[0]!);
    const session = await call(socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const owned = await descendants(brokerProcess.pid);
    expect(owned.length).toBeGreaterThan(4);
    if (process.platform === "win32") {
      try { witnesses = captureProcessWitnesses(owned, await windowsWitnessApi()); }
      catch (error) { if (error instanceof WitnessCaptureError) closeWitnesses = error.close; throw error; }
      closeWitnesses = witnesses.close;
      console.error(JSON.stringify({ browserCrashEvidence: "before broker death", brokerPid: brokerProcess.pid,
        processes: witnesses.observe().map(item => {
          const parentPid = ownedParents.get(item.pid);
          if (parentPid === undefined) throw new Error(`Owned PID ${item.pid} parent identity is unmeasured`);
          return { ...item, parentPid };
        }) }));
      // Refresh the private job membership while its only owning handle is still in the broker.
      await call(socket, "session.observe", session);
    }
    brokerProcess.kill("SIGKILL");
    await brokerProcess.exited;
    let survivors: number[] = owned;
    const reapingAt = Date.now();
    let polls = 0;
    for (let i = 0; i < 150; i++) {
      polls++;
      survivors = (await Promise.all(owned.map(async pid => await alive(pid) ? pid : null))).filter((pid): pid is number => pid !== null);
      const witnessAlive = witnesses?.observe().some(item => item.state === "alive") ?? false;
      if (!survivors.length && !witnessAlive) break;
      await Bun.sleep(30);
    }
    if (witnesses) {
      const measured = witnesses.observe();
      console.error(JSON.stringify({ browserCrashEvidence: "after broker death", survivors, processes: measured,
        reapingMs: Date.now() - reapingAt, polls }));
      await drainErrors();
      const records = brokerStderr.split(/\r?\n/).filter(line => line.includes('"ownedBrowser":"crash evidence"'));
      for (const record of records.slice(-2)) console.error(record);
      expect(records.length).toBeGreaterThan(0);
      expect(measured.filter(item => item.state === "alive").map(item => item.pid)).toEqual([]);
    }
    expect(survivors).toEqual([]);
    await expect(call(socket, "session.observe", session)).rejects.toBeDefined();
    const fresh = await startBroker();
    try {
      await expect(call(fresh.socket, "session.observe", session)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      const replacement = await call(fresh.socket, "session.create", { backend: "browser" }) as { sessionId: string };
      const frame = await call(fresh.socket, "session.observe", replacement) as { image: string };
      expectDeclaredImage(frame, "image/jpeg");
      expect(await call(fresh.socket, "session.stop", replacement)).toMatchObject({ state: "closed" });
    } finally { await fresh.close(); }
  } finally {
    try {
      if (brokerProcess.exitCode === null) brokerProcess.kill("SIGKILL");
      await brokerProcess.exited;
      reader.releaseLock();
      await drainErrors();
    } finally { closeWitnesses?.(); }
  }
}, 20000);
