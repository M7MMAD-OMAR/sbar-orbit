import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { inspectPrerequisites } from "../src/preflight";

const complete = { platform: "linux", file: async () => true, module: () => true, which: () => "/usr/bin/Xwayland",
  userManager: async () => true };

test("preflight distinguishes browser, native and common missing prerequisites", async () => {
  const all = await inspectPrerequisites("/fixture", complete);
  expect(all.browserPrerequisitesFound).toBe(true);
  expect(all.nativePrerequisitesFound).toBe(true);
  expect(all.startsApplications).toBe(false);
  expect(all.notVerified).toContain("shared libraries and executable startup");
  const noBrowser = await inspectPrerequisites("/fixture", { ...complete, file: async path => !path.includes("chrom") });
  expect(noBrowser.browserPrerequisitesFound).toBe(false);
  expect(noBrowser.nativePrerequisitesFound).toBe(true);
  expect(noBrowser.checks.find(check => check.id === "chrome-or-chromium")?.remedy).not.toBe("");
  const noNative = await inspectPrerequisites("/fixture", { ...complete, file: async path => !path.includes(".runtime") });
  expect(noNative.browserPrerequisitesFound).toBe(true);
  expect(noNative.nativePrerequisitesFound).toBe(false);
  const noModules = await inspectPrerequisites("/fixture", { ...complete, module: () => false });
  expect(noModules.browserPrerequisitesFound).toBe(false);
  expect(noModules.nativePrerequisitesFound).toBe(false);
});

test("a systemd tool with no user manager behind it is not availability", async () => {
  // The case a container found: systemctl present, nothing running it, and the install that needs it
  // refusing seconds after the check said the machine was ready.
  const report = await inspectPrerequisites("/fixture", { ...complete, userManager: async () => false });
  expect(report.browserPrerequisitesFound).toBe(false);
  expect(report.nativePrerequisitesFound).toBe(false);
  const check = report.checks.find(entry => entry.id === "systemd-user-session");
  expect(check?.available).toBe(false);
  expect(check?.remedy).toContain("user manager");
});

test("unsupported OS and absent executable checks cannot claim availability", async () => {
  const platform = await inspectPrerequisites("/fixture", { ...complete, platform: "darwin" });
  expect(platform.browserPrerequisitesFound).toBe(false);
  expect(platform.nativePrerequisitesFound).toBe(false);
  const permissions: boolean[] = [];
  const missing = await inspectPrerequisites("/fixture", { ...complete, file: async (_path, executable) => {
    permissions.push(executable); return !executable;
  } });
  expect(missing.browserPrerequisitesFound).toBe(false);
  expect(missing.nativePrerequisitesFound).toBe(false);
  expect(permissions).toContain(true);
  expect(permissions).toContain(false);
  expect(JSON.stringify(missing)).not.toContain("/fixture");
});

test("standalone preflight runs without a broker socket and emits no personal paths", async () => {
  const env = { ...process.env }; delete env.ORBIT_SOCKET;
  const child = Bun.spawn([resolve(import.meta.dir, "../bin/sbar-orbit"), "preflight"], {
    cwd: "/tmp", env, stdout: "pipe", stderr: "pipe",
  });
  const raw = await new Response(child.stdout).text();
  const report = JSON.parse(raw);
  expect(await child.exited).toBe(report.browserPrerequisitesFound ? 0 : 1);
  expect(report.check).toBe("prerequisite-availability");
  expect(report.startsApplications).toBe(false);
  expect(raw).not.toContain(resolve(import.meta.dir, ".."));
});
