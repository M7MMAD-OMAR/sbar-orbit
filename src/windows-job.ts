/**
 * The Windows containment layer, through bun:ffi and kernel32.
 *
 * Linux gives Orbit one cgroup per machine and the kernel enforces the budget. Windows gives a job
 * object per session, and three of its properties are the reason this file exists: closing the last
 * handle kills the tree, no descendant can break away unless you ask for it, and a hard CPU cap is
 * a share of the WHOLE machine rather than of a core.
 *
 * Measured on a Windows 11 25H2 guest, 8 logical CPUs, Edge 151 headless:
 *   - `SetInformationJobObject` with KILL_ON_JOB_CLOSE, JOB_MEMORY 2 GiB and ACTIVE_PROCESS 512
 *     succeeds, and a hard CPU cap of 25.00% is accepted with no DFSS refusal.
 *   - Spawn, then assign, and the browser still starts: CDP answered from inside the job.
 *   - 13 of 14 `msedge.exe` were inside the job. The one outside was `--type=crashpad-handler`,
 *     started by Chrome in the 76 ms between `CreateProcess` returning and the assign landing.
 *     That is the race `spawnContained` closes, and why `--disable-crashpad` is not optional.
 *   - Closing the last job handle left zero survivors.
 */

import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";
import { OrbitError } from "./errors";

const { i32, u32, u64, bool, ptr: pointer } = FFIType;

/**
 * Only ever opened on win32. Every caller goes through `requireWindows` first.
 *
 * Memoized, because the symbols never change and this is on two hot paths: `sharedBudgetUsage()` is
 * called from `budgetHeadroom()` on every session launch and from `resourceStatus()` on every status
 * poll, and each call was building a fresh FFI symbol table. The platform guard stays on every call,
 * so a non Windows caller is still refused rather than handed a cached handle.
 */
let loaded: ReturnType<typeof kernel32Symbols> | undefined;
function kernel32() {
  if (process.platform !== "win32")
    throw new OrbitError("UNSUPPORTED", "The job object containment layer is Windows only");
  return loaded ??= kernel32Symbols();
}
function kernel32Symbols() {
  return dlopen(`kernel32.${suffix}`, {
    CreateJobObjectW: { args: [pointer, pointer], returns: pointer },
    OpenJobObjectW: { args: [u32, bool, pointer], returns: pointer },
    SetInformationJobObject: { args: [pointer, i32, pointer, u32], returns: bool },
    QueryInformationJobObject: { args: [pointer, i32, pointer, u32, pointer], returns: bool },
    AssignProcessToJobObject: { args: [pointer, pointer], returns: bool },
    IsProcessInJob: { args: [pointer, pointer, pointer], returns: bool },
    OpenProcess: { args: [u32, bool, u32], returns: pointer },
    TerminateProcess: { args: [pointer, u32], returns: bool },
    CloseHandle: { args: [pointer], returns: bool },
    GetLastError: { args: [], returns: u32 },
  }).symbols;
}

/**
 * Narrow a kernel HANDLE that bun:ffi may hand back as a bigint.
 *
 * This is not cosmetic. Measured on the guest: `GetCurrentProcess()` returns the pseudo handle
 * (HANDLE)-1, which arrives here as 18446744073709552000 rather than 2^64-1, because that value has
 * no exact double. Passing it back to `AssignProcessToJobObject` fails with error 6,
 * ERROR_INVALID_HANDLE. A real handle from `OpenProcess` is a small integer and round trips
 * cleanly, which is why nothing in this file ever uses a pseudo handle.
 */
function asHandle(value: unknown): Pointer {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new OrbitError("BACKEND_FAILED", "A kernel handle did not fit a safe integer; refusing to pass it back");
    return Number(value) as Pointer;
  }
  return value as Pointer;
}
/** winnt.h. Only the flags this design sets, so an unused constant cannot drift out of date. */
const LIMIT = {
  /** 0x8. Blast radius bound on a runaway fork loop. */
  ACTIVE_PROCESS: 0x0000_0008,
  /** 0x200. A COMMITTED virtual memory ceiling, not an RSS one: Chrome reserves far more than it uses. */
  JOB_MEMORY: 0x0000_0200,
  /** 0x2000. Broker death closes the handle, and the kernel kills the tree. This is the whole design. */
  KILL_ON_JOB_CLOSE: 0x0000_2000,
} as const;

const CPU_RATE = {
  ENABLE: 0x1,
  HARD_CAP: 0x4,
} as const;

const CLASS = {
  BasicAccountingInformation: 1,
  BasicProcessIdList: 3,
  ExtendedLimitInformation: 9,
  CpuRateControlInformation: 15,
} as const;

/** PROCESS_QUERY_LIMITED_INFORMATION plus PROCESS_TERMINATE plus PROCESS_SET_QUOTA. */
const PROCESS_ACCESS = 0x0001 | 0x0100 | 0x1000;

/** ERROR_NOT_SUPPORTED. Returned for the CPU cap when Dynamic Fair Share Scheduling owns the machine. */
const ERROR_NOT_SUPPORTED = 50;

export type JobBudget = {
  /** Committed memory ceiling for the whole session tree, in bytes. */
  memoryBytes: number;
  /**
   * Share of the WHOLE machine, in hundredths of a percent, so 2500 is 25.00%.
   *
   * This is not "n cores". `CpuRate` is documented as cycles per 10,000 cycles of the entire system,
   * so the same number buys different throughput on a hybrid P and E core machine. The session's
   * journal prints it as a cycle share for that reason.
   */
  cpuCycleSharePercent: number;
  /** Process count ceiling. */
  activeProcesses: number;
};

export type JobAccounting = {
  userMs: number;
  kernelMs: number;
  pageFaults: number;
  totalProcesses: number;
  activeProcesses: number;
  terminatedProcesses: number;
  /** A high water mark, never a live gauge. Windows has no job class that reports current commit. */
  peakJobMemoryBytes: number;
};

/**
 * One contained session tree.
 *
 * The handle is the lifetime: while this object holds it, the tree lives; when it is closed, by
 * `close()` or by the broker dying, the kernel terminates every process inside.
 */
export class WindowsJob {
  private readonly api = kernel32();
  private readonly handle: Pointer;
  private closed = false;
  /** The counters as they stood at `close()`, which is the last moment the handle was still ours. */
  private final: JobAccounting | undefined;
  /** Whether the machine accepted a hard CPU cap. False means the budget is memory only, and it says so. */
  readonly cpuCapEnforced: boolean;

  constructor(readonly budget: JobBudget) {
    // bun:ffi types a HANDLE return as Pointer or bigint. `asHandle` refuses a value that would lose
    // precision rather than passing a corrupted handle back to the kernel, which is how error 6 was
    // produced on the guest before this existed.
    const handle = asHandle(this.api.CreateJobObjectW(null, null));
    if (!handle) throw new OrbitError("BACKEND_FAILED", `CreateJobObject failed, error ${this.api.GetLastError()}`);
    this.handle = handle;

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64: a 64 byte basic block, 48 bytes of
    // IO_COUNTERS, then four 64 bit memory fields. LimitFlags is at 16, ActiveProcessLimit at 40,
    // JobMemoryLimit at 120 and PeakJobMemoryUsed at 136.
    const extended = new Uint8Array(144);
    const view = new DataView(extended.buffer);
    view.setUint32(16, LIMIT.KILL_ON_JOB_CLOSE | LIMIT.JOB_MEMORY | LIMIT.ACTIVE_PROCESS, true);
    view.setUint32(40, budget.activeProcesses, true);
    view.setBigUint64(120, BigInt(budget.memoryBytes), true);
    if (!this.api.SetInformationJobObject(this.handle, CLASS.ExtendedLimitInformation, ptr(extended), 144)) {
      const error = this.api.GetLastError();
      this.api.CloseHandle(this.handle);
      throw new OrbitError("BACKEND_FAILED", `Could not set job limits, error ${error}`);
    }

    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION is 8 bytes: ControlFlags then a union whose CpuRate
    // member is the hundredths of a percent.
    const rate = new Uint8Array(8);
    const rateView = new DataView(rate.buffer);
    rateView.setUint32(0, CPU_RATE.ENABLE | CPU_RATE.HARD_CAP, true);
    rateView.setUint32(4, budget.cpuCycleSharePercent, true);
    const capped = this.api.SetInformationJobObject(this.handle, CLASS.CpuRateControlInformation, ptr(rate), 8);
    if (!capped) {
      const error = this.api.GetLastError();
      // Under Remote Desktop Services, Dynamic Fair Share Scheduling owns the scheduler and no job
      // may set a rate. Refusing the whole session would be worse than saying the ceiling is weaker,
      // so the state is recorded and printed rather than thrown.
      if (error !== ERROR_NOT_SUPPORTED) {
        this.api.CloseHandle(this.handle);
        throw new OrbitError("BACKEND_FAILED", `Could not set the job CPU cap, error ${error}`);
      }
    }
    this.cpuCapEnforced = capped;
  }

  /** Bring an already running process, and everything it starts from now on, inside the job. */
  assign(pid: number): void {
    // Always a real handle from OpenProcess, never `GetCurrentProcess()`: the pseudo handle does not
    // survive the trip through FFI and the kernel rejects what comes back. Measured on the guest.
    const process = asHandle(this.api.OpenProcess(PROCESS_ACCESS, false, pid));
    if (!process) throw new OrbitError("BACKEND_FAILED", `OpenProcess ${pid} failed, error ${this.api.GetLastError()}`);
    try {
      if (!this.api.AssignProcessToJobObject(this.handle, process))
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", `Could not assign process ${pid} to the job, error ${this.api.GetLastError()}`);
    } finally {
      this.api.CloseHandle(process);
    }
  }

  /**
   * Every process the kernel currently counts as inside the job.
   *
   * This is the membership check the budget samples, rather than one `IsProcessInJob` after launch:
   * Chrome starts renderer, GPU and utility processes for the whole life of the session, so a check
   * that ran once can never see the process created afterwards.
   */
  processIds(): number[] {
    this.requireOpen();
    for (const capacity of [256, 1024, 4096]) {
      const size = 8 + 8 * capacity;
      const buffer = new Uint8Array(size);
      const view = new DataView(buffer.buffer);
      view.setUint32(0, capacity, true);
      if (!this.api.QueryInformationJobObject(this.handle, CLASS.BasicProcessIdList, ptr(buffer), size, null)) continue;
      const assigned = view.getUint32(0, true);
      const listed = view.getUint32(4, true);
      // The list was truncated: ask again with room for everything the kernel says is assigned.
      if (listed < assigned && capacity < 4096) continue;
      const pids: number[] = [];
      for (let index = 0; index < listed; index++) pids.push(Number(view.getBigUint64(8 + 8 * index, true)));
      return pids;
    }
    throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "Could not read the job's process list");
  }

  /**
   * What the kernel charged this job.
   *
   * Note what is NOT here: a live memory gauge. No job information class reports current committed
   * memory outside a limit violation notification, so `peakJobMemoryBytes` is a high water mark and
   * a continuous figure has to be summed per process. Publishing the peak as if it were current was
   * the defect this file was written to avoid.
   */
  accounting(): JobAccounting {
    // After `close()` the kernel may have handed this handle's VALUE to an entirely different object,
    // and a query against it can SUCCEED and return that object's counters. The final snapshot taken
    // at close is returned instead, which is also the figure a caller asking after a dead browser
    // actually wants: what the job was charged when it died.
    if (this.closed) {
      if (this.final) return this.final;
      throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "The job object is closed and no final snapshot was taken");
    }
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION on x64: 0 user, 8 kernel, 16 and 24 this period,
    // 32 page faults, 36 total, 40 active, 44 terminated.
    const basic = new Uint8Array(48);
    if (!this.api.QueryInformationJobObject(this.handle, CLASS.BasicAccountingInformation, ptr(basic), 48, null))
      throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "Could not read job accounting");
    const view = new DataView(basic.buffer);
    const extended = new Uint8Array(144);
    let peak = 0;
    if (this.api.QueryInformationJobObject(this.handle, CLASS.ExtendedLimitInformation, ptr(extended), 144, null))
      peak = Number(new DataView(extended.buffer).getBigUint64(136, true));
    return {
      // FILETIME units are 100 nanoseconds.
      userMs: Math.round(Number(view.getBigUint64(0, true)) / 10_000),
      kernelMs: Math.round(Number(view.getBigUint64(8, true)) / 10_000),
      pageFaults: view.getUint32(32, true),
      totalProcesses: view.getUint32(36, true),
      activeProcesses: view.getUint32(40, true),
      terminatedProcesses: view.getUint32(44, true),
      peakJobMemoryBytes: peak,
    };
  }

  /** Every query refuses on a closed handle, because Windows recycles handle VALUES. */
  private requireOpen() {
    if (this.closed) throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "The job object is closed");
  }

  /** Kill the tree. Idempotent, because both session stop and broker shutdown reach it. */
  close(): void {
    if (this.closed) return;
    // Read the counters while the handle is still this job's, so a diagnostic written after the tree
    // is reaped still has the numbers. This is the only moment they exist.
    try { this.final = this.accounting(); } catch {}
    this.closed = true;
    this.api.CloseHandle(this.handle);
  }
}

/**
 * The shared budget, as a named job object.
 *
 * On Linux the budget is one cgroup slice that every Orbit process on the machine lives in: the
 * managed broker's sessions, a test run and an installer all draw on the same pool, which is what
 * `budgetHeadroom()` means and why `requireResourceBudget()` refuses a process outside it. An
 * unnamed job cannot express that, because a second process has no way to refer to it.
 *
 * A NAMED job can. Measured on the guest: a second Bun process that knew only the name opened the
 * job, read back its limits (1536 processes, 2048 MiB), assigned itself, and the pool then counted
 * both. That is the same shape as the slice.
 *
 * Two places it is NOT the same, and both are printed rather than hidden:
 *
 *   - No `KILL_ON_JOB_CLOSE` here. A shared budget must outlive whoever declared it, so the pool is
 *     held open by whichever Orbit process is alive rather than by one owner. A per session job
 *     still sets it, which is what actually reaps a browser tree.
 *   - There is no task count. Windows job objects cap active PROCESSES, not threads, so `tasks` on
 *     Windows is the process limit and says so, rather than being reported as if it were `pids.max`.
 */
const SHARED_BUDGET_NAME = "Local\\sbar-orbit-budget";

/** JOB_OBJECT_ALL_ACCESS, which is what an owner and a joiner both need. */
const JOB_ALL_ACCESS = 0x1f_001f;

export type SharedBudget = {
  memoryBytes: number;
  /** Active process ceiling. Not a thread count: Windows jobs do not have one. */
  processes: number;
  /** Whether this process is inside the pool, which is the check `requireResourceBudget` makes. */
  joined: boolean;
};

/**
 * Join the shared pool, creating it if this is the first Orbit process on the machine.
 *
 * `CreateJobObjectW` on an existing name returns a handle to the existing job with
 * `ERROR_ALREADY_EXISTS`, so create and open are the same call and there is no race between two
 * brokers starting at once.
 */
export function joinSharedBudget(budget: { memoryBytes: number; processes: number }): SharedBudget {
  const api = kernel32();
  const name = Buffer.from(`${SHARED_BUDGET_NAME}\0`, "utf16le");
  const handle = asHandle(api.CreateJobObjectW(null, ptr(name)));
  if (!handle) throw new OrbitError("BACKEND_FAILED", `Could not open the shared Orbit budget, error ${api.GetLastError()}`);
  const existed = api.GetLastError() === 183; // ERROR_ALREADY_EXISTS

  // Only the creator sets the limits. A second process that rewrote them could widen the pool it
  // just joined, which is the one way a shared budget stops being a budget.
  if (!existed) {
    const extended = new Uint8Array(144);
    const view = new DataView(extended.buffer);
    view.setUint32(16, LIMIT.JOB_MEMORY | LIMIT.ACTIVE_PROCESS, true);
    view.setUint32(40, budget.processes, true);
    view.setBigUint64(120, BigInt(budget.memoryBytes), true);
    if (!api.SetInformationJobObject(handle, CLASS.ExtendedLimitInformation, ptr(extended), 144))
      throw new OrbitError("BACKEND_FAILED", `Could not set the shared Orbit budget, error ${api.GetLastError()}`);
  }

  const self = asHandle(api.OpenProcess(PROCESS_ACCESS, false, process.pid));
  if (!self) throw new OrbitError("BACKEND_FAILED", `Could not open this process, error ${api.GetLastError()}`);
  let joined = false;
  try {
    joined = api.AssignProcessToJobObject(handle, self);
    // Already in the pool from an earlier call is success, not failure.
    if (!joined) {
      const flag = new Uint8Array(4);
      if (api.IsProcessInJob(self, handle, ptr(flag))) joined = flag[0] === 1;
    }
  } finally {
    api.CloseHandle(self);
  }

  // Read the limits back from the kernel rather than trusting what was asked for: a process that
  // joined a pool someone else created must report THAT pool's ceiling.
  const readback = new Uint8Array(144);
  let memoryBytes = budget.memoryBytes;
  let processes = budget.processes;
  if (api.QueryInformationJobObject(handle, CLASS.ExtendedLimitInformation, ptr(readback), 144, null)) {
    const view = new DataView(readback.buffer);
    processes = view.getUint32(40, true);
    memoryBytes = Number(view.getBigUint64(120, true));
  }
  // The handle is deliberately NOT closed: it is what keeps the pool alive for the next process.
  return { memoryBytes, processes, joined };
}

/** What the shared pool currently holds, for `budgetHeadroom` and `resourceStatus`. */
export function sharedBudgetUsage(): { processes: number; peakMemoryBytes: number } {
  const api = kernel32();
  const name = Buffer.from(`${SHARED_BUDGET_NAME}\0`, "utf16le");
  const handle = asHandle(api.OpenJobObjectW(JOB_ALL_ACCESS, false, ptr(name)));
  if (!handle) throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "The shared Orbit budget is not open on this machine");
  try {
    const basic = new Uint8Array(48);
    let processes = 0;
    if (api.QueryInformationJobObject(handle, CLASS.BasicAccountingInformation, ptr(basic), 48, null))
      processes = new DataView(basic.buffer).getUint32(40, true);
    const extended = new Uint8Array(144);
    let peak = 0;
    if (api.QueryInformationJobObject(handle, CLASS.ExtendedLimitInformation, ptr(extended), 144, null))
      peak = Number(new DataView(extended.buffer).getBigUint64(136, true));
    return { processes, peakMemoryBytes: peak };
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * Chrome's command line, with the Windows specific parts of the containment in it.
 *
 * `--disable-crashpad` is containment, not tidiness. Measured on the guest: Chrome starts
 * `--type=crashpad-handler` within the first 76 ms, and with spawn-then-assign that handler is
 * outside the job. It is the one process that escaped, every run.
 *
 * `src/chrome.ts` calls this rather than building the list again beside it. That is not tidiness
 * either: the two lists had already drifted, this one hardcoding `--disable-extensions` while the
 * launcher honoured `options.extensions`, and `tests/windows-job.test.ts` was asserting the
 * containment flags of a function nothing in production called. A test standing over an unused
 * builder proves nothing about the browser Orbit actually launches.
 */
export function windowsChromeArguments(profile: string, extra: string[] = [], options: { extensions?: boolean } = {}): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--headless",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    ...(options.extensions ? [] : ["--disable-extensions"]),
    // The handler that escapes the job in the assign window. Orbit reads Chrome's exit through the
    // job rather than through a crash report, so nothing is lost by refusing it.
    "--disable-crashpad",
    // App Bound Encryption is already inert for a private user data directory, since Chrome returns
    // kNotUsingDefaultUserDataDir before it reaches the policy branch. Stated here so nobody reads
    // an Orbit profile's DPAPI-only protection as an oversight.
    ...extra,
    "about:blank",
  ];
}
