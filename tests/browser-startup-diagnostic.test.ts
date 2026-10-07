import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserStartupDiagnostic, registerBrowserStartupFixture, sampleBrowserStartupDiagnostic, startupDiagnosticBudgetRoot, startupDiagnosticStderr } from "../src/browser-startup-diagnostic";

test("diagnostic stderr omits arbitrary output and categorizes messages without exposing private paths or endpoint URLs", () => {
  const output = startupDiagnosticStderr([
    'Traceback at /home/example/private/source.py with private-token',
    '[1:2:1006/120000:ERROR:chrome.cc:1] Failed to read "/home/example/Private User/profile/file"',
    "[1:2:1006/120000:WARNING:chrome.cc:2] Access denied 'C:\\Users\\example\\Private User\\file'",
    '[1:2:1006/120000:ERROR:chrome.cc:3] Failed request https://private.example/token?secret=fixture',
    '[1:2:1006/120000:ERROR:chrome.cc:4] Missing /var/tmp/private/data',
    '[1:2:1006/120000:ERROR:chrome.cc:5] Missing /home/example/Private User/profile/file',
    '[1:2:1006/120000:ERROR:chrome.cc:6] open(/home/example/private/profile)',
    '[1:2:1006/120000:WARNING:chrome.cc:7] Failed to connect to the bus: private-token',
    'DevTools listening on ws://127.0.0.1:1234/devtools/browser/private-id',
  ].join("\n"));
  for (const secret of ["private-token", "Private", "User", "private.example", "secret=fixture", "private-id", "/var/tmp/private", "/home/example/private/profile"])
    expect(output).not.toContain(secret);
  expect(output).toContain("[ERROR] other browser message");
  expect(output).toContain("[WARNING] dbus connection failed");
  expect(output).toContain("DevTools endpoint published");
  expect(startupDiagnosticStderr("unrecognized ".repeat(1000))).toBe("");
  expect(startupDiagnosticStderr('[1:2:1006/120000:ERROR:chrome.cc:1] ' + 'x'.repeat(5000)).length).toBeLessThanOrEqual(2048);
});

test("diagnostic counter scope resolves the enforced slice including nested commands", () => {
  const root = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/sbarorbit.slice";
  for (const suffix of ["", "/limited.scope", "/limited.scope/nested.scope"])
    expect(startupDiagnosticBudgetRoot(`0::/user.slice/user-1000.slice/user@1000.service/sbarorbit.slice${suffix}\n`)).toBe(root);
  expect(startupDiagnosticBudgetRoot("0::/user.slice/unrelated.scope\n")).toBeUndefined();
});

test("trace flag alone cannot emit diagnostics for another fixture", () => {
  const fixture = mkdtempSync(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "account-test-"));
  const profile = join(fixture, "profile");
  mkdirSync(profile, { mode: 0o700 });
  let release = () => {};
  const originalFlag = process.env.ORBIT_BROWSER_STARTUP_TRACE;
  const originalRoot = process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
  try {
    process.env.ORBIT_BROWSER_STARTUP_TRACE = "1";
    delete process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
    const owner = () => { throw new Error("Unselected owner must never be inspected"); };
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/profile", owner)).toBeUndefined();
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = "__saved_only__";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/profile", owner)).toBeUndefined();
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = "/var/tmp/fixture";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture-other/profile", owner)).toBeUndefined();
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/../fixture-other/profile", owner)).toBeUndefined();
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = "/";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/profile", owner)).toBeUndefined();
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = "/var/tmp/fixture/..";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/../fixture-other/profile", owner)).toBeUndefined();
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = fixture;
    release = registerBrowserStartupFixture(fixture);
    if (process.platform === "linux") {
      const selected = createBrowserStartupDiagnostic(profile, owner);
      expect(selected).toBeDefined();
      expect(() => selected?.record("owner.failed")).not.toThrow();
    }
    process.env.ORBIT_BROWSER_STARTUP_TRACE = "0";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/profile", owner)).toBeUndefined();
  } finally {
    release();
    rmSync(fixture, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE;
    else process.env.ORBIT_BROWSER_STARTUP_TRACE = originalFlag;
    if (originalRoot === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
    else process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = originalRoot;
  }
});


test("failed resource sampling stays unavailable and retains successful counters", async () => {
  const allFailed = await sampleBrowserStartupDiagnostic(async () => { throw new Error("read refused"); });
  expect(allFailed.counters).toEqual({});
  expect(allFailed.cgroupAncestry).toBeNull();
  expect(allFailed.budgetRoot).toBeNull();
  expect(allFailed.unavailable.sort()).toEqual(["cgroup-ancestry", "budget-root", "runner.cpu", "runner.cpu.pressure", "runner.io.pressure", "runner.memory.pressure"].sort());
  const partial = await sampleBrowserStartupDiagnostic(async path => {
    if (path === "/proc/self/cgroup") return "0::/user.slice/sbarorbit.slice/fixture.scope\n";
    if (path.endsWith("/memory.current")) return "123\n";
    throw new Error("counter unavailable");
  });
  expect(partial.counters).toEqual({ "memory.current": "123" });
  expect(partial.cgroupAncestry).toBe("0::/user.slice/sbarorbit.slice/fixture.scope\n");
  expect(partial.budgetRoot).toBe("/sys/fs/cgroup/user.slice/sbarorbit.slice");
  expect(partial.unavailable).toContain("pids.current");
  expect(partial.unavailable).not.toContain("memory.current");
  expect(partial.unavailable).not.toContain("budget-root");
});


(process.platform === "linux" ? test : test.skip)("selected actual fixture rejects symlink escape, revoked selection and non-private roots", () => {
  const oldFlag = process.env.ORBIT_BROWSER_STARTUP_TRACE;
  const oldRoot = process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
  const fixture = mkdtempSync("/var/tmp/account-test-");
  const outside = mkdtempSync("/var/tmp/startup-outside-");
  const profile = join(fixture, "profile");
  mkdirSync(profile, { mode: 0o700 });
  let release = () => {};
  try {
    process.env.ORBIT_BROWSER_STARTUP_TRACE = "1";
    process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = fixture;
    expect(createBrowserStartupDiagnostic(profile, () => ({}))).toBeUndefined();
    release = registerBrowserStartupFixture(fixture);
    expect(createBrowserStartupDiagnostic(profile, () => ({}))).toBeDefined();
    symlinkSync(outside, join(fixture, "escape"));
    expect(createBrowserStartupDiagnostic(join(fixture, "escape"), () => ({}))).toBeUndefined();
    chmodSync(fixture, 0o755);
    expect(createBrowserStartupDiagnostic(profile, () => ({}))).toBeUndefined();
    chmodSync(fixture, 0o700);
    chmodSync(profile, 0o755);
    expect(createBrowserStartupDiagnostic(profile, () => ({}))).toBeUndefined();
    release();
    chmodSync(profile, 0o700);
    expect(createBrowserStartupDiagnostic(profile, () => ({}))).toBeUndefined();
  } finally {
    release();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (oldFlag === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE; else process.env.ORBIT_BROWSER_STARTUP_TRACE = oldFlag;
    if (oldRoot === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT; else process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = oldRoot;
  }
});
