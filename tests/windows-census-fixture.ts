import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Pointer } from "bun:ffi";
import { windowsWitnessApi, type WitnessIdentity } from "./windows-process-witness";

const wide = (value: string) => Buffer.from(value + "\0", "utf16le");
const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export class CensusFixtureError extends AggregateError {
  constructor(primary: unknown, cleanup: unknown, readonly close: () => Promise<void>) {
    super([primary, cleanup], "Fixture preparation and owned cleanup failed");
  }
}

/** Actual owned child, with creator handles closed before any exit is permitted. */
export async function createCensusChild(captureDeadline = performance.now() + 10000) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 fixture is not measured on this platform");
  const { dlopen, ptr } = await import("bun:ffi");
  const api = dlopen("kernel32.dll", {
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "bool", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
    ResumeThread: { args: ["ptr"], returns: "u32" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "bool" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "bool" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
    TerminateJobObject: { args: ["ptr", "u32"], returns: "bool" },
    QueryInformationJobObject: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "bool" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
  const witnessApi = await windowsWitnessApi();
  const root = await mkdtemp(join(tmpdir(), "orbit-census-child-"));
  const ready = join(root, "ready"), release = join(root, "release"), script = join(root, "child.ts");
  let processHandle: number | undefined, threadHandle: number | undefined, parentHandle: number | undefined;
  let job: Pointer | null = null, assigned = false, cleaned = false;
  let exitConfirmed = false;
  const failures: string[] = [];
  const cleanupReceipt = { directoryRemoved: false, creatorHandlesClosed: false, parentHandleClosed: false, jobHandleClosed: false, activeProcesses: -1, elapsedMilliseconds: -1 };
  const fail = (operation: string): never => { throw new Error(`${operation} failed, error ${api.GetLastError()}`); };
  const closeCreator = () => {
    for (const kind of ["thread", "process"] as const) {
      const handle = kind === "thread" ? threadHandle : processHandle;
      if (handle === undefined) continue;
      if (!api.CloseHandle(handle as Pointer)) { failures.push(`CloseHandle creator ${kind}`); continue; }
      if (kind === "thread") threadHandle = undefined; else processHandle = undefined;
    }
    if (threadHandle !== undefined || processHandle !== undefined) throw new Error("Creator handle closure is unknown");
  };
  const jobEmpty = () => {
    if (!job) throw new Error("Owned job handle is unavailable");
    const accounting = new Uint8Array(48);
    if (!api.QueryInformationJobObject(job, 1, ptr(accounting), accounting.length, null)) fail("Owned fixture job accounting");
    return new DataView(accounting.buffer).getUint32(40, true) === 0;
  };
  const waitEmpty = async (milliseconds: number) => {
    const started = performance.now();
    const deadline = started + milliseconds;
    while (!jobEmpty()) {
      if (performance.now() >= deadline) throw new Error("Owned fixture job exit is unknown at deadline");
      await Bun.sleep(5);
    }
    return { activeProcesses: 0, elapsedMilliseconds: performance.now() - started, deadlineMilliseconds: milliseconds };
  };
  const close = async () => {
    if (cleaned) return;
    const cleanupStarted = performance.now();
    const errors: unknown[] = [];
    try {
      if (!exitConfirmed) {
        if (assigned && job) { if (!api.TerminateJobObject(job, 1)) fail("Terminate owned fixture job"); await waitEmpty(2000); }
        else if (processHandle !== undefined) {
          if (!api.TerminateProcess(processHandle as Pointer, 1)) fail("Terminate unassigned owned fixture child");
          if (api.WaitForSingleObject(processHandle as Pointer, 2000) !== 0) throw new Error("Unassigned owned child exit is unknown");
        }
        exitConfirmed = true;
      }
    } catch (error) { errors.push(error); }
    if (exitConfirmed) { try { closeCreator(); } catch (error) { errors.push(error); } }
    if (parentHandle !== undefined) {
      try { witnessApi.close(parentHandle); parentHandle = undefined; } catch (error) { errors.push(error); }
    }
    if (job && exitConfirmed) { if (api.CloseHandle(job)) job = null; else errors.push(new Error("Owned fixture job CloseHandle failed")); }
    if (errors.length) throw new AggregateError(errors, "Owned fixture cleanup remains retryable");
    await rm(root, { recursive: true, force: true });
    cleaned = true;
    Object.assign(cleanupReceipt, { directoryRemoved: true, creatorHandlesClosed: processHandle === undefined && threadHandle === undefined,
      parentHandleClosed: parentHandle === undefined, jobHandleClosed: job === null, activeProcesses: 0,
      elapsedMilliseconds: performance.now() - cleanupStarted });
  };
  try {
    await writeFile(script, `const ready=${JSON.stringify(ready)},release=${JSON.stringify(release)};await Bun.write(ready,String(process.pid));const deadline=performance.now()+12000;while(!(await Bun.file(release).exists())){if(performance.now()>deadline)process.exit(9);await Bun.sleep(5);}process.exit(0);`);
    job = api.CreateJobObjectW(null, null) as Pointer | null;
    if (!job) fail("Create owned fixture job");
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true);
    if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.length)) fail("Set owned fixture kill-on-close");
    const startup = new Uint8Array(104), info = new Uint8Array(24);
    new DataView(startup.buffer).setUint32(0, startup.length, true);
    const application = wide(process.execPath), command = wide(`${quote(process.execPath)} ${quote(script)}`), cwd = wide(root);
    const environment = wide(Object.entries({ PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: root, TMP: root })
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\0") + "\0");
    if (!api.CreateProcessW(ptr(application), ptr(command), null, null, false, 0x08000004 | 0x400,
      ptr(environment), ptr(cwd), ptr(startup), ptr(info))) fail("Create owned suspended fixture child");
    const view = new DataView(info.buffer);
    processHandle = Number(view.getBigUint64(0, true)); threadHandle = Number(view.getBigUint64(8, true));
    const pid = view.getUint32(16, true);
    if (!Number.isSafeInteger(processHandle) || !Number.isSafeInteger(threadHandle) || !pid) throw new Error("Native creator identity cannot be represented");
    if (!api.AssignProcessToJobObject(job, processHandle as Pointer)) fail("Assign owned fixture child");
    assigned = true;
    const identity = Object.freeze(witnessApi.identity(processHandle));
    if (!/^\d+$/.test(identity.creationTicks) || BigInt(identity.creationTicks) <= 0n || identity.image !== win32.basename(process.execPath))
      throw new Error("Live fixture identity is unknown");
    if (api.ResumeThread(threadHandle as Pointer) === 0xffffffff) fail("Resume owned fixture child");
    const deadline = Math.min(captureDeadline, performance.now() + 4000);
    while (!(await Bun.file(ready).exists())) { if (performance.now() >= deadline) throw new Error("Owned child readiness is unknown"); await Bun.sleep(5); }
    if ((await readFile(ready, "utf8")) !== String(pid)) throw new Error("Owned child readiness PID differs");
    const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`],
      { timeout: Math.max(1, Math.min(4000, captureDeadline - performance.now())) });
    if (listed.exitCode !== 0 || listed.stdout.toString().trim() !== `${pid} ${process.pid}`) throw new Error("Actual root-parent identity is unknown");
    parentHandle = witnessApi.open(process.pid);
    let parentIdentity: WitnessIdentity;
    try { parentIdentity = Object.freeze(witnessApi.identity(parentHandle)); }
    finally { witnessApi.close(parentHandle); parentHandle = undefined; }
    if (performance.now() >= captureDeadline) throw new Error("Fixture capture deadline expired");
    if (witnessApi.state(processHandle).state !== "alive") throw new Error("Fixture child was not alive at census row capture");
    closeCreator();
    const live = Object.freeze({ pid, parentPid: process.pid, ...identity, parentIdentity, creatorProcessClosed: true, creatorThreadClosed: true });
    return { live, witnessApi, release: async () => { await writeFile(release, "exit", { flag: "wx" }); },
      waitExited: () => waitEmpty(3000), close, failures, cleanupReceipt };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new CensusFixtureError(error, cleanup, close); }
    throw error;
  }
}

export function assertSameIdentity(actual: WitnessIdentity, expected: WitnessIdentity) {
  if (actual.creationTicks !== expected.creationTicks || actual.image !== expected.image) throw new Error("Owned fixture creation identity changed");
}
