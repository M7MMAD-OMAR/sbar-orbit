import { expect, test } from "bun:test";
import { createBrowserStartupDiagnostic, startupDiagnosticBudgetRoot, startupDiagnosticStderr } from "../src/browser-startup-diagnostic";

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
    process.env.ORBIT_BROWSER_STARTUP_TRACE = "0";
    expect(createBrowserStartupDiagnostic("/var/tmp/fixture/profile", owner)).toBeUndefined();
  } finally {
    if (originalFlag === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE;
    else process.env.ORBIT_BROWSER_STARTUP_TRACE = originalFlag;
    if (originalRoot === undefined) delete process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
    else process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT = originalRoot;
  }
});
