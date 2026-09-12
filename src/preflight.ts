import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { chromeExecutables, nativeRuntimePaths } from "./runtime-paths";

type Probe = {
  platform: string;
  file(path: string, executable: boolean): Promise<boolean>;
  module(name: string, project: string): boolean;
  which(name: string): string | null;
  /** Whether a systemd user manager is actually running for this account, not whether the tool exists. */
  userManager(): Promise<boolean>;
};
const systemProbe: Probe = {
  platform: process.platform,
  async file(path, executable) {
    try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
    catch { return false; }
  },
  module(name, project) { try { Bun.resolveSync(name, project); return true; } catch { return false; } },
  which: name => Bun.which(name),
  // The private socket a running user manager keeps in the runtime directory. A container image can
  // carry systemctl with nothing behind it, which read as available here while the install that needs
  // it refused seconds later. Still a file check: nothing is spawned to ask.
  async userManager() {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return false;
    try { return (await stat(join(runtime, "systemd/private"))).isSocket(); } catch { return false; }
  },
};

/**
 * A missing prerequisite, in the shape a program can branch on rather than a sentence it has to read.
 *
 * Two separate facts, because a trial agent found that one boolean cannot carry both. `needsElevation`
 * describes the command: true means a package manager and a person. `agentMayRun` is the permission:
 * whether an agent may run this itself without asking. They are not the same, and the gap between
 * them is real. Putting a directory on PATH needs no elevation at all and still belongs to the person,
 * because it is their shell configuration and Orbit does not edit it.
 *
 * An agent runs a remedy when `agentMayRun` is true, prints it and stops otherwise. The `message`
 * stays for people.
 *
 * Package commands name Fedora's packages, because Fedora 44 is the only host class this project
 * measures. On another distribution the package names are the person's to translate.
 */
export type Remedy = { id: string; message: string; command?: string; needsElevation: boolean; agentMayRun: boolean };
export type PrerequisiteCheck = { id: string; group: "common" | "browser" | "native"; available: boolean; remedy: Remedy | null };

/** Checks availability only. Never spawns tools or starts applications. */
export async function inspectPrerequisites(project = resolve(import.meta.dir, ".."), probe: Probe = systemProbe) {
  const checks: PrerequisiteCheck[] = [];
  const add = (id: string, group: "common" | "browser" | "native", available: boolean, remedy: Remedy) => {
    checks.push({ id, group, available, remedy: available ? null : remedy });
  };
  add("linux", "common", probe.platform === "linux",
    { id: "unsupported-platform", needsElevation: false, agentMayRun: false,
      message: "This alpha requires Linux. The macOS and Windows adapters are unverified, so nothing here can install them." });
  for (const name of ["systemctl", "systemd-run", "nice", "python3"])
    add(name, "common", await probe.file(`/usr/bin/${name}`, true),
      { id: `system-tool-${name}`, needsElevation: true, agentMayRun: false, command: `sudo dnf install -y ${name === "nice" ? "coreutils" : name === "systemd-run" ? "systemd" : name}`,
        message: `Orbit needs ${name} from the base system. Installing it is a package manager's job, so it is yours to run.` });
  add("systemd-user-session", "common", await probe.userManager(),
    { id: "no-systemd-user-session", needsElevation: false, agentMayRun: false,
      message: "Orbit runs every process it owns inside a systemd user slice, and no user manager is running for this account. A desktop login provides one. A container and a bare ssh session without lingering do not." });
  add("supervisor-source", "common", await probe.file(join(project, "src/native/supervise.py"), false),
    { id: "incomplete-source", needsElevation: false, agentMayRun: false,
      message: "This source tree is missing files a release carries. Extract a complete Orbit source release, or check out the repository again." });
  for (const name of ["playwright", "@modelcontextprotocol/sdk/client/index.js", "zod"])
    add(name, "common", probe.module(name, project),
      { id: "dependencies-missing", needsElevation: false, agentMayRun: true, command: "bun install --frozen-lockfile --ignore-scripts",
        message: "Project dependencies are not installed. Run this in the source directory; the one command install does it for you." });
  const browsers = await Promise.all(chromeExecutables.map(path => probe.file(path, true)));
  add("chrome-or-chromium", "browser", browsers.some(Boolean),
    { id: "no-browser", needsElevation: true, agentMayRun: false, command: "sudo dnf install -y chromium",
      message: "Browser sessions need Chrome or Chromium at a supported launcher location. See docs/packaging.md for the paths Orbit looks at." });
  const native = nativeRuntimePaths(project);
  for (const [id, path] of [["private-sway", join(native.executables, "sway")], ["private-pointer", native.pointer]] as const)
    add(id, "native", await probe.file(path, true),
      { id: "no-native-runtime", needsElevation: true, agentMayRun: false, command: "bash experiments/fedora-display/bootstrap.sh",
        message: "The private compositor and pointer helper are not in a source release, so a fresh machine builds them from the Fedora bootstrap. Read its pinned package versions before running it; native sessions are unavailable until then, browser sessions are not affected." });
  for (const name of ["grim", "wl-copy", "wl-paste"])
    add(name, "native", await probe.file(`/usr/bin/${name}`, true),
      { id: "no-capture-tools", needsElevation: true, agentMayRun: false, command: "sudo dnf install -y grim wl-clipboard",
        message: "Native sessions capture with grim and paste through wl-clipboard. Browser sessions do not need either." });
  const xwayland = probe.which("Xwayland");
  add("xwayland", "native", !!xwayland && await probe.file(xwayland, true),
    { id: "no-xwayland", needsElevation: true, agentMayRun: false, command: "sudo dnf install -y xorg-x11-server-Xwayland",
      message: "X11 applications on the private display need Xwayland on PATH." });
  const available = (group: string) => checks.filter(check => check.group === "common" || check.group === group).every(check => check.available);
  return { check: "prerequisite-availability", browserPrerequisitesFound: available("browser"), nativePrerequisitesFound: available("native"), checks,
    notVerified: ["Bun/runtime version compatibility", "cgroup delegation and the enforced resource budget", "shared libraries and executable startup", "disk-backed private workspace storage", "application behavior and desktop CPU acceptance"],
    startsApplications: false };
}
