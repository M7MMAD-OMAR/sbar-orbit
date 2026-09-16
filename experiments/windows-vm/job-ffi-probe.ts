/**
 * Two questions this answers on a real Windows host, in one run.
 *
 * 1. Does `src/windows-job.ts` work at all? Everything measured so far went through C# and
 *    PowerShell. The shipped code is `bun:ffi`, and an FFI binding that has never run is a guess.
 *
 * 2. Can a job object carry Orbit's SHARED budget semantics? On Linux the budget is one cgroup slice
 *    every Orbit process on the machine lives in: the managed broker, a test run and an installer
 *    all draw on the same pool, which is what `budgetHeadroom()` means. A job object is created by
 *    one process and is invisible to another unless it is NAMED. So: can process B open the job
 *    process A created, assign itself, and does it then carry A's limits and show in A's accounting?
 *
 * Run on the guest as the interactive user. Nothing here starts a browser.
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
  CloseHandle: { args: [pointer], returns: bool },
  GetLastError: { args: [], returns: u32 },
}).symbols;

const results: Record<string, unknown> = { bun: Bun.version, platform: process.platform };
const handle = (value: unknown) => (typeof value === "bigint" ? Number(value) : value) as Pointer;
const name = Buffer.from("Local\\sbar-orbit-budget-probe\0", "utf8");

const role = process.argv[2] ?? "creator";
results.role = role;

if (role === "creator") {
  // --- Part 1: the shipped class, exercised for real. ---
  const { WindowsJob, windowsChromeArguments } = await import("../../src/windows-job");
  try {
    const job = new WindowsJob({ memoryBytes: 2 * 1024 * 1024 * 1024, cpuCycleSharePercent: 2500, activeProcesses: 512 });
    results.windowsJobConstructed = true;
    results.cpuCapEnforced = job.cpuCapEnforced;
    // A child of our own, so nothing depends on a browser being installed.
    const child = Bun.spawn(["cmd.exe", "/c", "ping -n 20 127.0.0.1 > nul"], { stdout: "ignore", stderr: "ignore" });
    job.assign(child.pid);
    await Bun.sleep(600);
    const pids = job.processIds();
    results.assignedChildVisible = pids.includes(child.pid);
    results.jobProcessIds = pids.length;
    const accounting = job.accounting();
    results.accounting = {
      totalProcesses: accounting.totalProcesses,
      activeProcesses: accounting.activeProcesses,
      userMs: accounting.userMs,
      kernelMs: accounting.kernelMs,
      peakJobMemoryMiB: Math.round(accounting.peakJobMemoryBytes / 1048576),
    };
    job.close();
    await Bun.sleep(800);
    // KILL_ON_JOB_CLOSE: the child must be gone without anyone killing it.
    results.childKilledByJobClose = child.killed || child.exitCode !== null || !(await stillRunning(child.pid));
    results.chromeArgvHasCrashpadFlag = windowsChromeArguments("C:\\x").includes("--disable-crashpad");
  } catch (error) {
    results.windowsJobConstructed = `threw: ${(error as Error).message.slice(0, 300)}`;
  }

  // --- Part 2: a NAMED job, which is the only shape a shared budget could take. ---
  const shared = handle(k32.CreateJobObjectA(null, name));
  results.namedJobCreated = shared !== 0;
  if (shared) {
    const extended = new Uint8Array(144);
    const view = new DataView(extended.buffer);
    // No KILL_ON_JOB_CLOSE here: a shared budget must outlive the process that declared it, which is
    // the first place the Windows shape and the Linux slice disagree.
    view.setUint32(16, 0x200 | 0x8, true);
    view.setUint32(40, 1536, true);
    view.setBigUint64(120, BigInt(2 * 1024 * 1024 * 1024), true);
    results.namedJobLimitsSet = k32.SetInformationJobObject(shared, 9, ptr(extended), 144);
    // Put ourselves in it, which is what a broker would do at startup.
    results.creatorSelfAssigned = k32.AssignProcessToJobObject(shared, handle(k32.GetCurrentProcess()));
    if (!results.creatorSelfAssigned) results.creatorSelfAssignError = k32.GetLastError();

    // Hand off to a second process that only knows the NAME.
    const joiner = Bun.spawnSync([process.execPath, import.meta.path, "joiner"], { stdout: "pipe", stderr: "pipe" });
    results.joiner = joiner.stdout.toString().trim() || `no output: ${joiner.stderr.toString().slice(0, 300)}`;

    // Did the joiner's work land in OUR accounting? That is what a shared pool means.
    const basic = new Uint8Array(48);
    if (k32.QueryInformationJobObject(shared, 1, ptr(basic), 48, null)) {
      const v = new DataView(basic.buffer);
      results.sharedAccounting = {
        totalProcesses: v.getUint32(36, true),
        activeProcesses: v.getUint32(40, true),
        terminatedProcesses: v.getUint32(44, true),
      };
    }
    k32.CloseHandle(shared);
  }
} else {
  // The joiner: it has the name and nothing else, the way a second Orbit process would.
  const JOB_OBJECT_ALL_ACCESS = 0x1f001f;
  const opened = handle(k32.OpenJobObjectA(JOB_OBJECT_ALL_ACCESS, false, name));
  const out: Record<string, unknown> = { openedByName: opened !== 0 };
  if (!opened) out.openError = k32.GetLastError();
  else {
    out.selfAssigned = k32.AssignProcessToJobObject(opened, handle(k32.GetCurrentProcess()));
    if (!out.selfAssigned) out.assignError = k32.GetLastError();
    const inJob = new Uint8Array(4);
    if (k32.IsProcessInJob(handle(k32.GetCurrentProcess()), opened, ptr(inJob))) out.confirmedInJob = inJob[0] === 1;
    // Can the joiner READ the limits it just joined? That is `requireResourceBudget()`'s question.
    const extended = new Uint8Array(144);
    if (k32.QueryInformationJobObject(opened, 9, ptr(extended), 144, null)) {
      const v = new DataView(extended.buffer);
      out.readLimitFlags = "0x" + v.getUint32(16, true).toString(16);
      out.readActiveProcessLimit = v.getUint32(40, true);
      out.readJobMemoryLimitMiB = Math.round(Number(v.getBigUint64(120, true)) / 1048576);
    } else out.readLimitsFailed = k32.GetLastError();
    k32.CloseHandle(opened);
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

async function stillRunning(pid: number): Promise<boolean> {
  const probe = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -EA SilentlyContinue) { "yes" } else { "no" }`]);
  return probe.stdout.toString().trim() === "yes";
}

console.log(JSON.stringify(results, null, 2));
