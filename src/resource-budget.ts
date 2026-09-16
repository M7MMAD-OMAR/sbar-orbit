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
  /** `kernel-cgroup` on Linux, `job-object` on Windows. Never absent: a host with neither refuses. */
  enforcement: "kernel-cgroup" | "job-object";
  /** What this platform cannot bound. Empty on Linux. */
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
      throw new Error("This process is not inside the shared Orbit job object");
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
 * How much of the shared budget is still free, read from the kernel rather than from what this
 * broker believes it started. The budget is one pool for every Orbit process on the machine: a managed
 * broker's live sessions, a test run and an installer all draw on the same task count and 2 GB.
 */
export async function budgetHeadroom() {
  const limits = await requireResourceBudget();
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
