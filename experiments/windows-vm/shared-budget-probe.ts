/**
 * The shared budget question, narrowed.
 *
 * The first run said a process could OPEN a named job and READ its limits, but could not assign
 * itself: `AssignProcessToJobObject` returned error 6, ERROR_INVALID_HANDLE. Two candidate causes,
 * and they lead to opposite designs, so this separates them:
 *
 *   A. `GetCurrentProcess()` returns the pseudo handle (HANDLE)-1, and that value does not survive
 *      bun:ffi's pointer conversion. A bug in the probe.
 *   B. The process is already inside a job Windows put it in, and nesting is refusing. A real
 *      constraint, and the thing that would decide whether a shared budget is possible at all.
 *
 * `OpenProcess` on our own pid returns a real handle, which tells A from B. `IsProcessInJob` with a
 * NULL job asks whether we are in ANY job, which confirms or kills B.
 */

import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";

const { i32, u32, bool, ptr: pointer, cstring } = FFIType;

const k32 = dlopen(`kernel32.${suffix}`, {
  CreateJobObjectA: { args: [pointer, cstring], returns: pointer },
  OpenJobObjectA: { args: [u32, bool, cstring], returns: pointer },
  SetInformationJobObject: { args: [pointer, i32, pointer, u32], returns: bool },
  QueryInformationJobObject: { args: [pointer, i32, pointer, u32, pointer], returns: bool },
  AssignProcessToJobObject: { args: [pointer, pointer], returns: bool },
  IsProcessInJob: { args: [pointer, pointer, pointer], returns: bool },
  GetCurrentProcess: { args: [], returns: pointer },
  GetCurrentProcessId: { args: [], returns: u32 },
  OpenProcess: { args: [u32, bool, u32], returns: pointer },
  CloseHandle: { args: [pointer], returns: bool },
  GetLastError: { args: [], returns: u32 },
}).symbols;

const h = (value: unknown) => (typeof value === "bigint" ? Number(value) : value) as Pointer;
const out: Record<string, unknown> = { bun: Bun.version };
const role = process.argv[2] ?? "creator";
out.role = role;

const PROCESS_ALL_ACCESS = 0x1f0fff;
const JOB_OBJECT_ALL_ACCESS = 0x1f001f;
const name = Buffer.from("Local\\sbar-orbit-budget-probe2\0", "utf8");

// Are we already inside a job? A NULL job handle asks exactly that.
const pseudo = h(k32.GetCurrentProcess());
out.pseudoHandleValue = String(pseudo);
const real = h(k32.OpenProcess(PROCESS_ALL_ACCESS, false, k32.GetCurrentProcessId()));
out.realHandleOpened = real !== 0;

const flag = new Uint8Array(4);
if (k32.IsProcessInJob(real, null, ptr(flag))) out.alreadyInSomeJob = flag[0] === 1;
else out.isProcessInJobFailed = k32.GetLastError();

if (role === "creator") {
  const job = h(k32.CreateJobObjectA(null, name));
  out.namedJobCreated = job !== 0;
  const extended = new Uint8Array(144);
  const view = new DataView(extended.buffer);
  // No KILL_ON_JOB_CLOSE: a shared budget outlives whoever declared it.
  view.setUint32(16, 0x200 | 0x8, true);
  view.setUint32(40, 1536, true);
  view.setBigUint64(120, BigInt(2 * 1024 * 1024 * 1024), true);
  out.limitsSet = k32.SetInformationJobObject(job, 9, ptr(extended), 144);

  // The discriminator: the same call, with a real handle instead of the pseudo handle.
  out.assignWithPseudoHandle = k32.AssignProcessToJobObject(job, pseudo);
  if (!out.assignWithPseudoHandle) out.pseudoError = k32.GetLastError();
  out.assignWithRealHandle = k32.AssignProcessToJobObject(job, real);
  if (!out.assignWithRealHandle) out.realError = k32.GetLastError();

  const after = new Uint8Array(4);
  if (k32.IsProcessInJob(real, job, ptr(after))) out.creatorNowInNamedJob = after[0] === 1;

  const joiner = Bun.spawnSync([process.execPath, import.meta.path, "joiner"], { stdout: "pipe", stderr: "pipe" });
  out.joiner = joiner.stdout.toString().trim() || `no output: ${joiner.stderr.toString().slice(0, 400)}`;

  // Does the pool see both processes? That is the whole point of a shared budget.
  const basic = new Uint8Array(48);
  if (k32.QueryInformationJobObject(job, 1, ptr(basic), 48, null)) {
    const v = new DataView(basic.buffer);
    out.poolTotalProcesses = v.getUint32(36, true);
    out.poolActiveProcesses = v.getUint32(40, true);
  }
  const list = new Uint8Array(8 + 8 * 64);
  new DataView(list.buffer).setUint32(0, 64, true);
  if (k32.QueryInformationJobObject(job, 3, ptr(list), list.byteLength, null)) {
    out.poolListedPids = new DataView(list.buffer).getUint32(4, true);
  }
  k32.CloseHandle(job);
} else {
  const opened = h(k32.OpenJobObjectA(JOB_OBJECT_ALL_ACCESS, false, name));
  out.openedByName = opened !== 0;
  if (opened) {
    out.assignWithRealHandle = k32.AssignProcessToJobObject(opened, real);
    if (!out.assignWithRealHandle) out.realError = k32.GetLastError();
    const inJob = new Uint8Array(4);
    if (k32.IsProcessInJob(real, opened, ptr(inJob))) out.joinerNowInNamedJob = inJob[0] === 1;
    const extended = new Uint8Array(144);
    if (k32.QueryInformationJobObject(opened, 9, ptr(extended), 144, null)) {
      const v = new DataView(extended.buffer);
      out.readActiveProcessLimit = v.getUint32(40, true);
      out.readJobMemoryLimitMiB = Math.round(Number(v.getBigUint64(120, true)) / 1048576);
    }
    k32.CloseHandle(opened);
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

k32.CloseHandle(real);
console.log(JSON.stringify(out, null, 2));
