import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError } from "./errors";
import { parseHostCpu, type CpuSample } from "./cpu-sample";

/**
 * What a budget is on this platform.
 *
 * Linux enforces it in the kernel through a cgroup slice and reports live counters. Windows enforces
 * a committed memory ceiling and an active process ceiling through a named job object, and reports
 * neither a live memory gauge nor a thread count. Those are different promises, so the contract says
 * which one it is rather than printing a Windows number in a Linux shape.
 */
export type BudgetLimits = {
  cpuCores: number;
  memoryBytes: number;
  swapBytes: number;
  /** Linux: `pids.max`, a thread count. Windows: the active PROCESS limit, which is not the same. */
  tasks: number;
  /**
   * `kernel-cgroup` on Linux, `job-object` on Windows, `advisory` on macOS.
   *
   * The third one is a different kind of promise from the first two and the word says so. A cgroup
   * and a job object are ceilings the kernel refuses to let a process pass. The macOS registry is an
   * accounting boundary Orbit reads and a scheduling class Orbit sets: the numbers come from the
   * kernel, and nothing stops a process that is over the line. A caller that prints a limit prints
   * this field beside it.
   */
  enforcement: "kernel-cgroup" | "job-object" | "advisory";
  /** What this platform cannot bound. Empty on Linux. Everything on macOS. */
  unbounded: string[];
};

/** Aggregate counters only: no process arguments, page content or credentials. */
export async function readCpuSample(): Promise<CpuSample> {
  await requireResourceBudget();
  const root = await budgetRoot();
  const [orbit, host] = await Promise.all([
    readFile(join(root, "cpu.stat"), "utf8"), readFile("/proc/stat", "utf8"),
  ]);
  const usage = /^usage_usec\s+(\d+)$/m.exec(orbit)?.[1];
  if (!usage || !Number.isSafeInteger(Number(usage))) throw new Error("Invalid Orbit CPU counter");
  return { monotonicMs: performance.now(), orbitUsec: Number(usage), ...parseHostCpu(host) };
}

async function budgetRoot() {
  if (process.platform !== "linux") throw new Error("Linux required");
  const entry = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"));
  const parts = entry?.slice(3).split("/") ?? [];
  const index = parts.indexOf("sbarorbit.slice");
  if (index < 0) throw new Error("No shared Orbit slice");
  return join("/sys/fs/cgroup", ...parts.slice(0, index + 1));
}

export async function requireResourceBudget(): Promise<BudgetLimits> {
  if (process.platform === "win32") return requireWindowsBudget();
  if (process.platform === "darwin") return requireDarwinBudget();
  try {
    const root = await budgetRoot();
    const read = async (file: string) => (await readFile(join(root, file), "utf8")).trim();
    const [cpu, memory, swap, tasks] = await Promise.all([read("cpu.max"), read("memory.max"), read("memory.swap.max"), read("pids.max")]);
    const [quota, period] = cpu.split(" ").map(Number);
    if (!quota || !period || !Number.isFinite(quota) || quota / period > 4 || !Number.isFinite(Number(memory)) || Number(memory) > 8589934592 || Number(swap) !== 0 || !Number.isFinite(Number(tasks)) || Number(tasks) > 1536)
      throw new Error("Orbit budget is not enforced");
    return { cpuCores: quota / period, memoryBytes: Number(memory), swapBytes: 0, tasks: Number(tasks),
      enforcement: "kernel-cgroup", unbounded: [] };
  } catch {
    throw new OrbitError("RESOURCE_LIMIT_REQUIRED", "Run through bun run serve or bun run verify; a shared CPU and memory budget is required");
  }
}

/**
 * The Windows budget: join the named job object that every Orbit process on this machine shares.
 *
 * Measured on a Windows 11 guest, 16 September 2026: a second Bun process holding only the name
 * opened the same job, read back its ceilings and assigned itself, and the pool then counted both.
 * That is the shared pool `budgetHeadroom()` assumes, expressed the way Windows can express it.
 *
 * Three honest differences from the cgroup, all reported rather than smoothed over:
 *   - `swapBytes` is not bounded. There is no per job swap limit on Windows at all.
 *   - `tasks` is a PROCESS ceiling, not a thread ceiling. Job objects do not cap threads.
 *   - The CPU share is set per session, not on the shared pool, because a hard cap on the pool would
 *     make every session compete inside one 25% slice rather than each getting its own ceiling.
 */
async function requireWindowsBudget(): Promise<BudgetLimits> {
  try {
    const { joinSharedBudget } = await import("./windows-job");
    const { cpuCores, memoryMiB } = await import("./service");
    const pool = joinSharedBudget({ memoryBytes: memoryMiB * 1048576, processes: 1536 });
    if (!pool.joined)
      throw new Error(`This process is not inside the shared Orbit job object (Win32 assignment error ${pool.assignmentError ?? "unknown"})`);
    if (pool.memoryBytes > 8589934592 || pool.processes > 1536)
      throw new Error("The shared Orbit job object is wider than the budget allows");
    return {
      cpuCores, memoryBytes: pool.memoryBytes, swapBytes: 0, tasks: pool.processes,
      enforcement: "job-object",
      // Said here, once, so every caller that prints limits prints the gap too.
      unbounded: ["swap", "threads"],
    };
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    throw new OrbitError("RESOURCE_LIMIT_REQUIRED",
      `A shared CPU and memory budget is required; the Windows job object could not be joined: ${(error as Error).message}`);
  }
}

/**
 * The macOS budget: be inside a registered Orbit process group.
 *
 * Deliberately the same SHAPE as the other two and deliberately a weaker PROMISE, with the word
 * `advisory` carrying the difference. The ceilings are the same numbers `src/service.ts` computes
 * for every platform, a quarter of the machine, so a person moving between hosts sees one policy.
 * What differs is that here nothing enforces them: `unbounded` names every dimension rather than
 * two, and `budgetHeadroom()` sums live kernel counters to refuse the NEXT session rather than to
 * stop the current one.
 *
 * `tasks` is a PROCESS count on this platform, as on Windows, and not the thread count Linux bounds.
 * There is no per group thread ceiling on macOS at all.
 */
async function requireDarwinBudget(): Promise<BudgetLimits> {
  const { insideRegisteredGroup } = await import("./macos-budget");
  const { cpuCores, memoryMiB } = await import("./service");
  if (!await insideRegisteredGroup())
    throw new OrbitError("RESOURCE_LIMIT_REQUIRED",
      "Run through bun run serve or bun run verify; a shared CPU and memory budget is required");
  return {
    cpuCores, memoryBytes: memoryMiB * 1048576, swapBytes: 0, tasks: 1536,
    enforcement: "advisory",
    // Said here, once, so every caller that prints limits prints the gap too. This is the whole
    // list, not a subset: macOS offers no per process group ceiling on any of them without a
    // kernel extension or root, so the honest answer is that nothing is bounded and the numbers
    // above are a policy Orbit applies to itself.
    unbounded: ["cpu", "memory", "swap", "processes", "threads"],
  };
}

/**
 * How much of the shared budget is still free, read from the kernel rather than from what this
 * broker believes it started. The budget is one pool for every Orbit process on the machine: a managed
 * broker's live sessions, a test run and an installer all draw on the same task count and 2 GB.
 */
export async function budgetHeadroom() {
  const limits = await requireResourceBudget();
  if (process.platform === "darwin") {
    const { sharedBudgetUsage } = await import("./macos-budget");
    const usage = await sharedBudgetUsage();
    // A live gauge, unlike the Windows peak: `proc_pid_rusage` reports each process's current
    // footprint, so the sum is what the pool is charged with now. It is still advisory, and the
    // difference from Linux is not the freshness of the number but that nothing enforces it.
    return {
      tasks: { used: usage.processes, max: limits.tasks, free: limits.tasks - usage.processes },
      memory: { usedBytes: usage.footprintBytes, maxBytes: limits.memoryBytes, freeBytes: limits.memoryBytes - usage.footprintBytes },
    };
  }
  if (process.platform === "win32") {
    const { sharedBudgetUsage } = await import("./windows-job");
    const usage = sharedBudgetUsage();
    // `peakMemoryBytes` is a high water mark, not a gauge: Windows has no job class that reports
    // current committed memory outside a limit violation. Using the peak here is deliberate and
    // conservative, since it can only ever refuse a session the kernel might have allowed.
    return {
      tasks: { used: usage.processes, max: limits.tasks, free: limits.tasks - usage.processes },
      memory: { usedBytes: usage.peakMemoryBytes, maxBytes: limits.memoryBytes, freeBytes: limits.memoryBytes - usage.peakMemoryBytes },
    };
  }
  const root = await budgetRoot();
  const read = async (file: string) => Number((await readFile(join(root, file), "utf8")).trim());
  const [tasks, memoryBytes] = await Promise.all([read("pids.current"), read("memory.current")]);
  return { tasks: { used: tasks, max: limits.tasks, free: limits.tasks - tasks },
    memory: { usedBytes: memoryBytes, maxBytes: limits.memoryBytes, freeBytes: limits.memoryBytes - memoryBytes } };
}

/**
 * Refuse to start something that would not fit. Measured 13 September 2026: a headless Chrome
 * session settles at about 150 tasks, and one started into a slice with less room than its launch
 * burst failed inside 407 ms with a refused fork, reported as a browser that never published its
 * endpoint. The kernel's own refusal count, `pids.events max`, went up by ten across one test run.
 * Saying so before the fork is cheaper than reading it out of a crash afterwards, and names the cause.
 */
export async function requireHeadroom(need: { tasks: number; memoryBytes: number }, what: string) {
  const headroom = await budgetHeadroom();
  if (headroom.tasks.free < need.tasks || headroom.memory.freeBytes < need.memoryBytes)
    throw new OrbitError("RESOURCE_EXHAUSTED", `${what} needs about ${need.tasks} tasks and ${Math.round(need.memoryBytes / 1048576)} MB; the shared Orbit budget has ${headroom.tasks.free} of ${headroom.tasks.max} tasks and ${Math.round(headroom.memory.freeBytes / 1048576)} MB free. Stop a session or wait for one to finish.`);
  return headroom;
}

/** Kernel counters cover all Orbit scopes, not just this broker. */
export async function resourceStatus() {
  const limits = await requireResourceBudget();
  if (process.platform === "darwin") {
    const { sharedBudgetUsage } = await import("./macos-budget");
    const usage = await sharedBudgetUsage();
    return {
      scope: "all-orbit-groups", sampledAt: new Date().toISOString(), limits,
      // `footprintBytes` is a live sum of `ri_phys_footprint` across every registered group, which
      // is the figure Jetsam decides on and the one Activity Monitor calls Memory. Swap is null
      // rather than zero: macOS compresses rather than swapping per process and reports no per
      // group swap figure at all, so zero would be a measurement this platform cannot make.
      current: { footprintBytes: usage.footprintBytes, swapBytes: null, tasks: usage.processes, groups: usage.groups },
      // There are no limit events to report because there are no limits. A kernel that never
      // refuses an allocation has nothing to count, and inventing a zero here would read as "the
      // ceiling was never hit" rather than "there is no ceiling".
      events: null,
    };
  }
  if (process.platform === "win32") {
    const { sharedBudgetUsage } = await import("./windows-job");
    const usage = sharedBudgetUsage();
    return {
      scope: "all-orbit-jobs", sampledAt: new Date().toISOString(), limits,
      // `memoryBytes` is the pool's PEAK, and the field says so rather than being read as current.
      current: { peakMemoryBytes: usage.peakMemoryBytes, swapBytes: null, tasks: usage.processes },
      // Windows job objects deliver limit hits on a completion port rather than as readable counters,
      // and Orbit does not attach one to the shared pool, so there is nothing honest to report here.
      events: null,
    };
  }
  try {
    const root = await budgetRoot();
    const read = async (file: string) => (await readFile(join(root, file), "utf8")).trim();
    const [memory, swap, tasks, memoryEvents, taskEvents] = await Promise.all([
      read("memory.current"), read("memory.swap.current"), read("pids.current"), read("memory.events"), read("pids.events"),
    ]);
    const counters = (value: string) => Object.fromEntries(value.split("\n").map(line => {
      const [key, count] = line.split(/\s+/);
      return [key, Number(count)];
    }));
    return {
      scope: "all-orbit-jobs", sampledAt: new Date().toISOString(), limits,
      current: { memoryBytes: Number(memory), swapBytes: Number(swap), tasks: Number(tasks) },
      events: { memory: counters(memoryEvents), tasks: counters(taskEvents) },
    };
  } catch {
    throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "Could not read Orbit resource counters");
  }
}
