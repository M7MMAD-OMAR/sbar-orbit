import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError } from "./errors";

async function budgetRoot() {
  if (process.platform !== "linux") throw new Error("Linux required");
  const entry = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"));
  const parts = entry?.slice(3).split("/") ?? [];
  const index = parts.indexOf("sbarorbit.slice");
  if (index < 0) throw new Error("No shared Orbit slice");
  return join("/sys/fs/cgroup", ...parts.slice(0, index + 1));
}

export async function requireResourceBudget() {
  try {
    const root = await budgetRoot();
    const read = async (file: string) => (await readFile(join(root, file), "utf8")).trim();
    const [cpu, memory, swap, tasks] = await Promise.all([read("cpu.max"), read("memory.max"), read("memory.swap.max"), read("pids.max")]);
    const [quota, period] = cpu.split(" ").map(Number);
    if (!quota || !period || !Number.isFinite(quota) || quota / period > 1 || !Number.isFinite(Number(memory)) || Number(memory) > 2147483648 || Number(swap) !== 0 || !Number.isFinite(Number(tasks)) || Number(tasks) > 512)
      throw new Error("Orbit budget is not enforced");
    return { cpuCores: quota / period, memoryBytes: Number(memory), swapBytes: 0, tasks: Number(tasks) };
  } catch {
    throw new OrbitError("RESOURCE_LIMIT_REQUIRED", "Run through bun run serve or bun run verify; a shared CPU and memory budget is required");
  }
}

/** Kernel counters cover all Orbit scopes, not just this broker. */
export async function resourceStatus() {
  const limits = await requireResourceBudget();
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
