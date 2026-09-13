import { test, expect } from "bun:test";
import { startBroker, call } from "../src/ipc";

test("doctor exposes enforced aggregate limits and live kernel counters without a browser", async () => {
  const broker = await startBroker();
  try {
    const result = await call(broker.socket, "doctor") as {
      sessions: number;
      resources: { scope: string; sampledAt: string; limits: { cpuCores: number; memoryBytes: number; swapBytes: number; tasks: number };
        current: { memoryBytes: number; swapBytes: number; tasks: number }; events: { memory: Record<string, number>; tasks: Record<string, number> } };
    };
    expect(result.sessions).toBe(0);
    expect(result.resources.scope).toBe("all-orbit-jobs");
    expect(result.resources.limits.cpuCores).toBeLessThanOrEqual(4);
    expect(result.resources.limits.memoryBytes).toBeLessThanOrEqual(8589934592);
    expect(result.resources.limits.swapBytes).toBe(0);
    expect(result.resources.limits.tasks).toBeLessThanOrEqual(1536);
    expect(result.resources.current.memoryBytes).toBeGreaterThan(0);
    expect(result.resources.current.tasks).toBeGreaterThan(0);
    expect(result.resources.current.swapBytes).toBe(0);
    expect(result.resources.events.memory.oom_kill).toBeGreaterThanOrEqual(0);
    expect(result.resources.events.tasks.max).toBeGreaterThanOrEqual(0);
    expect(Math.abs(Date.now() - Date.parse(result.resources.sampledAt))).toBeLessThan(5000);
  } finally { await broker.close(); }
});
