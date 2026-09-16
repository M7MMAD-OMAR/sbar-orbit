import { test, expect } from "bun:test";
import { startBroker, call } from "../src/ipc";

/**
 * Two platforms report a budget, and they do not report the same one. Linux enforces it in a cgroup
 * slice and publishes live counters and the kernel's own refusal events. Windows enforces a committed
 * memory ceiling and an active PROCESS ceiling in a named job object, has no swap bound at all, and
 * has no job class that reports current commit outside a limit violation, so it publishes a high
 * water mark and says so.
 *
 * Asserting the Linux shape everywhere is what made this fail on the guest, against a broker that was
 * answering correctly. The fields both platforms owe a caller are checked once; each platform's own
 * promise is checked against that platform.
 */
test("doctor exposes the enforced aggregate limits this platform can actually promise", async () => {
  const broker = await startBroker();
  try {
    const result = await call(broker.socket, "doctor") as {
      sessions: number;
      resources: {
        scope: string; sampledAt: string;
        limits: { cpuCores: number; memoryBytes: number; swapBytes: number; tasks: number;
          enforcement: "kernel-cgroup" | "job-object"; unbounded: string[] };
        current: { memoryBytes?: number; peakMemoryBytes?: number; swapBytes: number | null; tasks: number };
        events: { memory: Record<string, number>; tasks: Record<string, number> } | null;
      };
    };
    expect(result.sessions).toBe(0);
    expect(result.resources.scope).toBe("all-orbit-jobs");
    expect(result.resources.limits.cpuCores).toBeLessThanOrEqual(4);
    expect(result.resources.limits.memoryBytes).toBeLessThanOrEqual(8589934592);
    expect(result.resources.limits.tasks).toBeLessThanOrEqual(1536);
    expect(result.resources.current.tasks).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - Date.parse(result.resources.sampledAt))).toBeLessThan(5000);

    if (process.platform === "win32") {
      // The weaker guarantee is named rather than printed in the stronger one's shape.
      expect(result.resources.limits.enforcement).toBe("job-object");
      expect(result.resources.limits.unbounded).toEqual(["swap", "threads"]);
      expect(result.resources.current.peakMemoryBytes).toBeGreaterThan(0);
      // Not zero: NOT BOUNDED. A job object has no per job swap limit of any kind.
      expect(result.resources.current.swapBytes).toBeNull();
      // Job objects deliver limit hits on a completion port rather than as readable counters, and
      // Orbit attaches none to the shared pool, so there is nothing honest to report.
      expect(result.resources.events).toBeNull();
      return;
    }
    expect(result.resources.limits.enforcement).toBe("kernel-cgroup");
    expect(result.resources.limits.unbounded).toEqual([]);
    expect(result.resources.limits.swapBytes).toBe(0);
    expect(result.resources.current.memoryBytes!).toBeGreaterThan(0);
    expect(result.resources.current.swapBytes).toBe(0);
    expect(result.resources.events!.memory.oom_kill).toBeGreaterThanOrEqual(0);
    expect(result.resources.events!.tasks.max).toBeGreaterThanOrEqual(0);
  } finally { await broker.close(); }
});
