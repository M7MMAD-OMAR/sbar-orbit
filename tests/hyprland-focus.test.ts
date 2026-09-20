import { test, expect } from "bun:test";
import { focusEvent, parseProcessIds, ownsFocus, sanitizeFocus, startFocusMonitor } from "../experiments/hyprland-focus";

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

/**
 * The two defects that made a ten minute run report owned focus on a desktop with no Orbit window at
 * all, both measured on 20 September 2026. Neither could be caught by the live test below, because
 * both need a specific state to occur: an empty `cgroup.procs`, and a moment with no active window.
 */
test("an empty procs file has no processes, and no window means no owner", () => {
  // `"".split(/\s+/)` is `[""]` and `Number("")` is 0, which put pid 0 in the owned set.
  expect(parseProcessIds("")).toEqual(new Set());
  expect(parseProcessIds("\n")).toEqual(new Set());
  expect(parseProcessIds("  \n \t")).toEqual(new Set());
  expect(parseProcessIds("0 12 0 -3 x 12 7")).toEqual(new Set([12, 7]));
  // `sanitizeFocus({})` reports pid 0 for "no active window", so a set holding pid 0 claimed it.
  expect(ownsFocus(0, new Set([0]))).toBe(false);
  expect(ownsFocus(0, new Set([0, 12]))).toBe(false);
  expect(ownsFocus(12, new Set([12]))).toBe(true);
  expect(ownsFocus(12, new Set([0]))).toBe(false);
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
