import { test, expect } from "bun:test";
import { expectDeclaredImage } from "./frame-format";
import { readFile, readdir } from "node:fs/promises";
import { call, startBroker } from "../src/ipc";

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
  const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]);
  const parents = new Map<number, number[]>();
  for (const line of listed.stdout.toString().split(/\r?\n/)) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined || Number.isNaN(parent)) continue;
    parents.set(parent, [...(parents.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (pid: number) => { for (const child of parents.get(pid) ?? []) { found.push(child); walk(child); } };
  walk(root);
  return found;
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
  const brokerProcess = Bun.spawn([process.execPath, "src/cli.ts", "serve"], { stdout: "pipe", stderr: "pipe" });
  const reader = brokerProcess.stdout.getReader();
  const errors = new Response(brokerProcess.stderr).text();
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
    brokerProcess.kill("SIGKILL");
    await brokerProcess.exited;
    let survivors: number[] = owned;
    for (let i = 0; i < 150; i++) {
      survivors = (await Promise.all(owned.map(async pid => await alive(pid) ? pid : null))).filter((pid): pid is number => pid !== null);
      if (!survivors.length) break;
      await Bun.sleep(30);
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
    if (brokerProcess.exitCode === null) brokerProcess.kill("SIGKILL");
    await brokerProcess.exited;
    reader.releaseLock();
    await errors;
  }
}, 20000);
