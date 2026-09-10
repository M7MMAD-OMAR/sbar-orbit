import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { chromeExecutables, nativeRuntimePaths } from "./runtime-paths";

type Probe = {
  platform: string;
  file(path: string, executable: boolean): Promise<boolean>;
  module(name: string, project: string): boolean;
  which(name: string): string | null;
};
const systemProbe: Probe = {
  platform: process.platform,
  async file(path, executable) {
    try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
    catch { return false; }
  },
  module(name, project) { try { Bun.resolveSync(name, project); return true; } catch { return false; } },
  which: name => Bun.which(name),
};

/** Checks availability only. Never spawns tools or starts applications. */
export async function inspectPrerequisites(project = resolve(import.meta.dir, ".."), probe: Probe = systemProbe) {
  const checks: { id: string; group: "common" | "browser" | "native"; available: boolean; remedy: string }[] = [];
  const add = (id: string, group: "common" | "browser" | "native", available: boolean, remedy: string) => {
    checks.push({ id, group, available, remedy: available ? "" : remedy });
  };
  add("linux", "common", probe.platform === "linux", "This alpha requires Linux; macOS and Windows adapters remain unverified.");
  for (const name of ["systemctl", "systemd-run", "nice", "python3"])
    add(name, "common", await probe.file(`/usr/bin/${name}`, true), "Install the required Linux runtime tool before starting Orbit.");
  add("supervisor-source", "common", await probe.file(join(project, "src/native/supervise.py"), false), "Restore a complete Orbit source release.");
  for (const name of ["playwright", "@modelcontextprotocol/sdk/client/index.js", "zod"])
    add(name, "common", probe.module(name, project), "Run bun install --frozen-lockfile --ignore-scripts in the source directory.");
  const browsers = await Promise.all(chromeExecutables.map(path => probe.file(path, true)));
  add("chrome-or-chromium", "browser", browsers.some(Boolean), "Install Chrome or Chromium at a supported Linux launcher location; see docs/packaging.md.");
  const native = nativeRuntimePaths(project);
  add("private-sway", "native", await probe.file(join(native.executables, "sway"), true), "Prepare the documented Fedora native runtime for this source version.");
  add("private-pointer", "native", await probe.file(native.pointer, true), "Build the documented Fedora native pointer helper for this source version.");
  for (const name of ["grim", "wl-copy", "wl-paste"])
    add(name, "native", await probe.file(`/usr/bin/${name}`, true), "Install the required Fedora capture or clipboard tool.");
  const xwayland = probe.which("Xwayland");
  add("xwayland", "native", !!xwayland && await probe.file(xwayland, true), "Install Xwayland and make it available on PATH.");
  const available = (group: string) => checks.filter(check => check.group === "common" || check.group === group).every(check => check.available);
  return { check: "prerequisite-availability", browserPrerequisitesFound: available("browser"), nativePrerequisitesFound: available("native"), checks,
    notVerified: ["Bun/runtime version compatibility", "systemd user session and cgroup delegation", "shared libraries and executable startup", "disk-backed private workspace storage", "application behavior and desktop CPU acceptance"],
    startsApplications: false };
}
