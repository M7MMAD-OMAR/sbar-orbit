import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { inspectPrerequisites } from "../src/preflight";

const complete = { platform: "linux", file: async () => true, module: () => true, which: () => "/usr/bin/Xwayland",
  userManager: async () => true, missingLibraries: () => [] as string[] };

test("preflight distinguishes browser, native and common missing prerequisites", async () => {
  const all = await inspectPrerequisites("/fixture", complete);
  expect(all.browserPrerequisitesFound).toBe(true);
  expect(all.nativePrerequisitesFound).toBe(true);
  expect(all.startsApplications).toBe(false);
  expect(all.notVerified).toContain("shared libraries and executable startup");
  const noBrowser = await inspectPrerequisites("/fixture", { ...complete, file: async path => !path.includes("chrom") });
  expect(noBrowser.browserPrerequisitesFound).toBe(false);
  expect(noBrowser.nativePrerequisitesFound).toBe(true);
  const browser = noBrowser.checks.find(check => check.id === "chrome-or-chromium")?.remedy;
  // A remedy an agent can branch on: the elevation flag is the boundary, not a sentence about one.
  expect(browser).toMatchObject({ id: "no-browser", needsElevation: true, agentMayRun: false });
  expect(browser?.command).toContain("chromium");
  expect(all.checks.every(check => check.available === (check.remedy === null))).toBe(true);
  // A machine with neither runtime. Named by the two files rather than by a directory, because the
  // runtime is shared between versions now and is no longer under a `.runtime` path.
  const noNative = await inspectPrerequisites("/fixture", { ...complete, file: async path => !/\/sway$|\/pointer$/.test(path) });
  expect(noNative.browserPrerequisitesFound).toBe(true);
  expect(noNative.nativePrerequisitesFound).toBe(false);
  // The fresh-machine failure: a compositor that is built and cannot load, which is a package
  // manager's job and is named as one, library by library.
  const unloadable = await inspectPrerequisites("/fixture", { ...complete, missingLibraries: () => ["libevdev.so.2", "libinput.so.10"] });
  expect(unloadable.nativePrerequisitesFound).toBe(false);
  expect(unloadable.browserPrerequisitesFound).toBe(true);
  const libraries = unloadable.checks.find(check => check.id === "private-runtime-libraries");
  expect(libraries?.remedy).toMatchObject({ id: "no-native-libraries", needsElevation: true });
  expect(libraries?.remedy?.message).toContain("libevdev.so.2, libinput.so.10");
  expect(libraries?.remedy?.command).toMatch(/^sudo dnf install .*\blibevdev\b/);
  const noModules = await inspectPrerequisites("/fixture", { ...complete, module: () => false });
  expect(noModules.browserPrerequisitesFound).toBe(false);
  expect(noModules.nativePrerequisitesFound).toBe(false);
});

test("a package remedy follows the package manager that is actually on the machine", async () => {
  const missing = { platform: "linux", module: () => false, which: () => null, userManager: async () => false, missingLibraries: () => [] as string[] };
  const only = (manager: string) => inspectPrerequisites("/fixture", { ...missing, file: async (path: string) => path === manager });
  const browserOn = async (manager: string) =>
    (await only(manager)).checks.find(check => check.id === "chrome-or-chromium")?.remedy;

  expect((await browserOn("/usr/bin/dnf"))?.command).toBe("sudo dnf install -y chromium");
  expect((await browserOn("/usr/bin/apt-get"))?.command).toBe("sudo apt-get install -y chromium");
  expect((await browserOn("/usr/bin/pacman"))?.command).toBe("sudo pacman -S --needed chromium");
  // Package names are not the same everywhere, so the portable field is the software, not the command.
  const arch = (await only("/usr/bin/pacman")).checks.find(check => check.id === "xwayland")?.remedy;
  expect(arch?.command).toBe("sudo pacman -S --needed xorg-xwayland");
  expect(arch?.packages).toEqual(["xwayland"]);
  // An unrecognised system gets the names and no command. A wrong command is worse than none.
  const unknown = await browserOn("none");
  expect(unknown?.command).toBeUndefined();
  expect(unknown?.packages).toEqual(["chromium"]);
});

test("a systemd tool with no user manager behind it is not availability", async () => {
  // The case a container found: systemctl present, nothing running it, and the install that needs it
  // refusing seconds after the check said the machine was ready.
  const report = await inspectPrerequisites("/fixture", { ...complete, userManager: async () => false });
  expect(report.browserPrerequisitesFound).toBe(false);
  expect(report.nativePrerequisitesFound).toBe(false);
  const check = report.checks.find(entry => entry.id === "systemd-user-session");
  expect(check?.available).toBe(false);
  expect(check?.remedy?.id).toBe("no-systemd-user-session");
  expect(check?.remedy?.needsElevation).toBe(false);
  // No package would fix it, and no agent may fix it either. The two flags are separate.
  expect(check?.remedy?.agentMayRun).toBe(false);
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
