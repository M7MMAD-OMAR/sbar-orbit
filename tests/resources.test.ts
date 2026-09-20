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
          enforcement: "kernel-cgroup" | "job-object" | "advisory"; unbounded: string[] };
        current: { memoryBytes?: number; peakMemoryBytes?: number; footprintBytes?: number; swapBytes: number | null; tasks: number; groups?: number };
        events: { memory: Record<string, number>; tasks: Record<string, number> } | null;
      };
    };
    expect(result.sessions).toBe(0);
    // The scope name says what the pool IS on this platform, and the three are different objects:
    // one cgroup slice, one named job object, or every registered process group. A single expected
    // string here would be asserting that one platform's mechanism is the only one.
    expect(result.resources.scope).toBe(process.platform === "darwin" ? "all-orbit-groups" : "all-orbit-jobs");
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
      expect(result.resources.current.memoryBytes).toBeGreaterThan(0);
      expect(result.resources.current.peakMemoryBytes).toBeGreaterThanOrEqual(Number(result.resources.current.memoryBytes));
      // Not zero: NOT BOUNDED. A job object has no per job swap limit of any kind.
      expect(result.resources.current.swapBytes).toBeNull();
      // Job objects deliver limit hits on a completion port rather than as readable counters, and
      // Orbit attaches none to the shared pool, so there is nothing honest to report.
      expect(result.resources.events).toBeNull();
      return;
    }
    if (process.platform === "darwin") {
      // The weakest guarantee of the three, named rather than dressed in either stronger one's
      // shape. Every dimension is unbounded here, which is a statement about macOS and not about
      // Orbit being lazy: there is no per process group ceiling to set.
      expect(result.resources.limits.enforcement).toBe("advisory");
      expect(result.resources.limits.unbounded).toContain("memory");
      expect(result.resources.limits.unbounded).toContain("cpu");
      // A live sum of `ri_phys_footprint` over every registered group, unlike the Windows peak.
      expect(result.resources.current.footprintBytes!).toBeGreaterThan(0);
      // At least this broker's own group is registered, or the pool is not being accounted at all.
      expect(result.resources.current.groups!).toBeGreaterThan(0);
      // Not zero: NOT MEASURED. macOS compresses rather than swapping per process and reports no
      // per group swap figure, so a zero would be a measurement this platform cannot make.
      expect(result.resources.current.swapBytes).toBeNull();
      // No limits means no limit events to count. A zero here would read as "the ceiling was never
      // hit" rather than "there is no ceiling".
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
