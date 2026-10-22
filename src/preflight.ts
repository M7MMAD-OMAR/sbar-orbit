import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

type Probe = {
  platform: string;
  bunVersion?: string;
  file(path: string, executable: boolean): Promise<boolean>;
  module(name: string, project: string): boolean;
  which(name: string): string | null;
  /** Whether a systemd user manager is actually running for this account, not whether the tool exists. */
  userManager(): Promise<boolean>;
  /** The shared libraries these executables cannot load, by soname, as the dynamic loader would see them. */
  missingLibraries(executables: string[], libraryPath: string): string[];
};
const systemProbe: Probe = {
  platform: process.platform,
  bunVersion: Bun.version,
  async file(path, executable) {
    try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
    catch { return false; }
  },
  module(name, project) {
    // Bun can resolve a missing local dependency from its global cache, using
    // a version outside this release's frozen lockfile. Parent installations
    // also do not make an extracted release independently usable.
    const modules = join(project, "node_modules");
    const packageName = name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/");
    if (!existsSync(join(modules, packageName, "package.json"))) return false;
    try {
      const resolved = relative(modules, Bun.resolveSync(name, project));
      return resolved !== ".." && !resolved.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(resolved);
    } catch { return false; }
  },
  missingLibraries(executables, libraryPath) {
    const ldd = Bun.spawnSync(["ldd", ...executables], { env: { ...process.env, LD_LIBRARY_PATH: libraryPath } });
    return [...new Set(String(ldd.stdout).split("\n").filter(line => line.includes("not found")).map(line => line.trim().split(" ")[0] ?? ""))].filter(Boolean);
  },
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
 * `packages` is the portable field: the software that is missing, named the way this system names it.
 * `command` is a convenience built for whichever package manager is actually on this machine, and it
 * is absent when none of the ones Orbit knows about is there. Branch on `packages`, print `command`.
 */
export type Remedy = { id: string; message: string; command?: string; packages?: string[]; needsElevation: boolean; agentMayRun: boolean };

/**
 * Enough package managers to cover the systems a person is likely to be on, and no attempt to cover
 * every one. An unrecognised system gets the package names and no command, which is the honest answer:
 * a wrong command is worse than none.
 */
const packageManagers = [
  { id: "dnf", path: "/usr/bin/dnf", install: (names: string[]) => `sudo dnf install -y ${names.join(" ")}` },
  { id: "apt", path: "/usr/bin/apt-get", install: (names: string[]) => `sudo apt-get install -y ${names.join(" ")}` },
  { id: "pacman", path: "/usr/bin/pacman", install: (names: string[]) => `sudo pacman -S --needed ${names.join(" ")}` },
  { id: "zypper", path: "/usr/bin/zypper", install: (names: string[]) => `sudo zypper install -y ${names.join(" ")}` },
  { id: "apk", path: "/usr/bin/apk", install: (names: string[]) => `sudo apk add ${names.join(" ")}` },
];

/** A remedy for software the system's package manager owns. Never something Orbit installs itself. */
async function systemPackages(probe: Probe, id: string, message: string, names: { any: string[] } & Record<string, string[] | undefined>): Promise<Remedy> {
  for (const manager of packageManagers) {
    if (!await probe.file(manager.path, true)) continue;
    return { id, message, packages: names.any, command: manager.install(names[manager.id] ?? names.any), needsElevation: true, agentMayRun: false };
  }
  return { id, message, packages: names.any, needsElevation: true, agentMayRun: false };
}
export type PrerequisiteCheck = { id: string; group: "common" | "browser" | "native"; available: boolean; remedy: Remedy | null };

/** Checks availability only. Never spawns tools or starts applications. */
export async function inspectPrerequisites(project = resolve(import.meta.dir, ".."), probe: Probe = systemProbe) {
  const checks: PrerequisiteCheck[] = [];
  const add = (id: string, group: "common" | "browser" | "native", available: boolean, remedy: Remedy) => {
    checks.push({ id, group, available, remedy: available ? null : remedy });
  };
  // What the platform has to provide, which is not the same list everywhere. Windows has none of
  // systemd, and does not need it: the budget is a named job object and the broker runs in the
  // person's own session, both measured on a Windows 11 guest. Checking for systemctl there would
  // fail an install for the absence of something the Windows path never calls.
  const windows = probe.platform === "win32";
  const darwin = probe.platform === "darwin";
  // The implemented desktop adapter uses the owner's Linux Hyprland session.
  // Other platforms must not inherit its prerequisites or claim native control.
  const nativePossible = probe.platform === "linux";
  add("supported-platform", "common", probe.platform === "linux" || windows || darwin,
    { id: "unsupported-platform", needsElevation: false, agentMayRun: false,
      message: "Metadata tooling supports Linux, Windows and macOS. Native desktop control currently requires Linux; other desktop adapters are not implemented." });
  if (windows) {
    const runtime = probe.bunVersion ?? "";
    add("bun-version", "common", /^\d+\.\d+\.\d+/.test(runtime) && Bun.semver.satisfies(runtime, ">=1.4.2"),
      { id: "unsupported-bun-version", needsElevation: false, agentMayRun: false,
        message: "Windows requires Bun 1.4.2 or newer. Bun 1.3.14 exhausted the shared memory budget with concurrent MCP adapters. Upgrade Bun using its original installation method, then run the installer again." });
  }
  if (darwin) {
    // The macOS prerequisites, which are a short list because almost everything Orbit needs here is
    // in the base system. Each one is checked at the path it really has, not at the path a POSIX
    // habit suggests.
    //
    // `/bin/launchctl`, NOT `/usr/bin/launchctl`. Measured on the macOS 26.6.2 runner, 14 September
    // 2026: the `/usr/bin` path does not exist, and a probe that looked there reported the tool
    // missing on a machine where `launchctl print gui/501` answered perfectly well.
    //
    // There is no remedy that installs any of these, because they ship with the operating system.
    // A Mac without them is a broken install, so the message says that rather than offering a
    // package manager command that does not apply.
    for (const [id, path] of [["launchctl", "/bin/launchctl"], ["cp", "/bin/cp"], ["sysctl", "/usr/sbin/sysctl"]] as const)
      add(id, "common", await probe.file(path, true),
        { id: "macos-base-system-missing", needsElevation: false, agentMayRun: false,
          message: `Orbit uses ${path}, which ships with macOS. A system missing it is not one Orbit can repair.` });
    // The scheduling half of the budget. Its absence is NOT fatal and the check says so: the
    // accounting half still works, and a session runs without the utility QoS clamp at a slightly
    // higher priority rather than not at all. It is reported so a person reading the report knows
    // which half they have.
    add("taskpolicy", "common", await probe.file("/usr/sbin/taskpolicy", true),
      { id: "no-taskpolicy", needsElevation: false, agentMayRun: false,
        message: "taskpolicy is missing, so sessions cannot be placed under the utility QoS clamp. The budget's accounting half still works and sessions still run." });
    // Metadata and owner-service installation use the shared broker source.
    add("broker-source", "common", await probe.file(join(project, "src/service.ts"), false),
      { id: "incomplete-source", needsElevation: false, agentMayRun: false,
        message: "This source tree is missing files a release carries. Extract a complete Orbit source release, or check out the repository again." });
  }
  if (!windows && !darwin) {
    for (const name of ["systemctl", "systemd-run", "nice", "python3"]) {
      const owner = name === "nice" ? { any: ["coreutils"] } : name === "python3" ? { any: ["python3"], apt: ["python3"], pacman: ["python"] } : { any: ["systemd"] };
      add(name, "common", await probe.file(`/usr/bin/${name}`, true),
        await systemPackages(probe, `system-tool-${name}`, `Orbit needs ${name} from the base system. Installing it belongs to the package manager, so it is yours to run.`, owner));
    }
    add("systemd-user-session", "common", await probe.userManager(),
      { id: "no-systemd-user-session", needsElevation: false, agentMayRun: false,
        message: "Orbit runs every process it owns inside a systemd user slice, and no user manager is running for this account. A desktop login provides one. A container and a bare ssh session without lingering do not." });

  }
  for (const name of ["@modelcontextprotocol/sdk/client/index.js", "zod"])
    add(name, "common", probe.module(name, project),
      { id: "dependencies-missing", needsElevation: false, agentMayRun: true, command: "bun install --frozen-lockfile --ignore-scripts",
        message: "Project dependencies are not installed. Run this in the source directory; the one command install does it for you." });
  if (nativePossible) {
    add("hyprctl", "native", !!probe.which("hyprctl"),
      { id: "native-compositor-unavailable", needsElevation: false, agentMayRun: false,
        message: "Original application opening requires the configured Hyprland owner session. No private display fallback exists." });
  }
  const available = (group: string) => checks.filter(check => check.group === "common" || check.group === group).every(check => check.available);
  // `every` on an empty list is true, so skipping the native checks would report
  // `nativePrerequisitesFound: true` without an implemented platform adapter.
  // Metadata tooling does not establish native desktop control.
  const nativePrerequisitesFound = nativePossible && available("native");
  return { check: "prerequisite-availability", browserPrerequisitesFound: false, nativePrerequisitesFound, checks,
    nativeRuntime: { source: "removed" },
    notVerified: ["Bun/runtime version compatibility", "platform resource budget enforcement", "shared libraries and executable startup", "owner application permissions", "application behavior and desktop CPU acceptance"],
    startsApplications: false };
}
