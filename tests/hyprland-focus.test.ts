import { test, expect } from "bun:test";
import { focusEvent, sanitizeFocus, startFocusMonitor } from "../experiments/hyprland-focus";

test("focus telemetry discards titles and rejects malformed identities", () => {
  const safe = sanitizeFocus({ pid: 42, title: "PRIVATE_TITLE", class: "PRIVATE_APP" }, [{ pid: 42, address: "0xABC", title: "PRIVATE_TITLE" }]);
  expect(safe).toEqual({ activePid: 42, clients: [{ pid: 42, address: "abc" }] });
  expect(JSON.stringify(safe)).not.toContain("PRIVATE");
  expect(focusEvent("activewindow>>PRIVATE_APP,PRIVATE_TITLE")).toBeUndefined();
  expect(focusEvent("activewindowv2>>0xABC")).toBe("abc");
  expect(focusEvent("activewindowv2>>")).toBeNull();
  expect(() => focusEvent("activewindowv2>>PRIVATE_TITLE")).toThrow();
  expect(() => sanitizeFocus({ pid: "42" }, [])).toThrow();
  expect(() => sanitizeFocus({}, [{ pid: 42, address: "invalid" }])).toThrow();
});

(process.env.HYPRLAND_INSTANCE_SIGNATURE ? test : test.skip)("read-only live focus monitor closes and emits only redacted observations", async () => {
  const monitor = await startFocusMonitor(async () => new Set([process.pid]), 200);
  await Bun.sleep(650);
  const report = await monitor.stop();
  expect(report.errors).toBe(0);
  expect(report.samples.length).toBeGreaterThan(2);
  expect(report.samples.every(sample => !sample.activeOwned && sample.visibleOwnedCount === 0)).toBe(true);
  expect(Object.keys(report.samples[0]!).sort()).toEqual(["activeOwned", "atMs", "visibleOwnedCount"]);
  expect(report.maximumSampleGapMs).toBeLessThan(1500);
}, 5000);
