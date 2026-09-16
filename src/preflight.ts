import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { chromeExecutables, nativeRuntimeLocations, nativeRuntimePackages, windowsBrowserInstalls } from "./runtime-paths";

type Probe = {
  platform: string;
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
  async file(path, executable) {
    try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
    catch { return false; }
  },
  module(name, project) { try { Bun.resolveSync(name, project); return true; } catch { return false; } },
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
  add("supported-platform", "common", probe.platform === "linux" || windows,
    { id: "unsupported-platform", needsElevation: false, agentMayRun: false,
      message: "This alpha runs on Linux and, at the Limited tier, on Windows. The macOS adapter is unverified, so nothing here can install it." });
  if (!windows) {
    for (const name of ["systemctl", "systemd-run", "nice", "python3"]) {
      const owner = name === "nice" ? { any: ["coreutils"] } : name === "python3" ? { any: ["python3"], apt: ["python3"], pacman: ["python"] } : { any: ["systemd"] };
      add(name, "common", await probe.file(`/usr/bin/${name}`, true),
        await systemPackages(probe, `system-tool-${name}`, `Orbit needs ${name} from the base system. Installing it belongs to the package manager, so it is yours to run.`, owner));
    }
    add("systemd-user-session", "common", await probe.userManager(),
      { id: "no-systemd-user-session", needsElevation: false, agentMayRun: false,
        message: "Orbit runs every process it owns inside a systemd user slice, and no user manager is running for this account. A desktop login provides one. A container and a bare ssh session without lingering do not." });
    // The Python subreaper that holds a browser tree on Linux. Windows uses a job object instead, so
    // its absence there is correct rather than an incomplete source tree.
    add("supervisor-source", "common", await probe.file(join(project, "src/native/supervise.py"), false),
      { id: "incomplete-source", needsElevation: false, agentMayRun: false,
        message: "This source tree is missing files a release carries. Extract a complete Orbit source release, or check out the repository again." });
  }
  for (const name of ["playwright", "@modelcontextprotocol/sdk/client/index.js", "zod"])
    add(name, "common", probe.module(name, project),
      { id: "dependencies-missing", needsElevation: false, agentMayRun: true, command: "bun install --frozen-lockfile --ignore-scripts",
        message: "Project dependencies are not installed. Run this in the source directory; the one command install does it for you." });
  // The same resolver `doctor` uses, so a Windows install and a Windows doctor cannot disagree about
  // whether a browser exists. `chromeExecutables` is a list of Linux paths and finds nothing there.
  //
  // Still asked through `probe.file`, one path at a time, rather than by calling the resolver for a
  // yes or no: the probe is the seam every test injects, and answering from the real machine instead
  // made this check unmockable and silently ignored the caller's probe.
  const browserCandidates = windows ? windowsBrowserInstalls().map(install => install.executable) : chromeExecutables;
  const browsers = await Promise.all(browserCandidates.map(path => probe.file(path, true)));
  add("chrome-or-chromium", "browser", browsers.some(Boolean),
    await systemPackages(probe, "no-browser",
      "Browser sessions need Chrome or Chromium at a supported launcher location. See docs/packaging.md for the paths Orbit looks at.",
      { any: ["chromium"] }));
  // Which runtime this machine would use, resolved through the probe rather than the filesystem, so an
  // injected probe still decides everything. `in-source` means one built before 14 September 2026,
  // inside a source tree, still usable and adopted by `./install.sh --native`.
  // The native backend is a nested Wayland compositor: Linux only, by construction. Running these
  // checks on Windows emitted three remedies telling an agent to run `./install.sh --native` and to
  // `sudo dnf install` Fedora packages, on a machine with no dnf, no sudo and no possible private
  // display. A remedy nobody can act on is worse than no remedy: the contract says an agent must
  // report what it did not run, so it would faithfully report Fedora instructions to a Windows user.
  let runtimeSource: "shared" | "in-source" | "none" = "none";
  if (!windows) {
    const locations = nativeRuntimeLocations(project);
    const built = async (paths: { executables: string; pointer: string }) =>
      await probe.file(join(paths.executables, "sway"), true) && await probe.file(paths.pointer, true);
      runtimeSource = await built(locations.shared) ? "shared" : await built(locations.inSource) ? "in-source" : "none";
    const native = runtimeSource === "in-source" ? locations.inSource : locations.shared;
    for (const [id, path] of [["private-sway", join(native.executables, "sway")], ["private-pointer", native.pointer]] as const)
      add(id, "native", await probe.file(path, true),
        // The one prerequisite that is genuinely tied to a system: the bootstrap that builds the private
        // compositor pins Fedora packages, and no equivalent has been written or tried anywhere else.
        { id: "no-native-runtime", needsElevation: false, agentMayRun: false, command: "./install.sh --native",
          message: "The private compositor and pointer helper are not in a source release, so they are built from the bootstrap script. It pins Fedora packages and has been run on no other system. Read it before running it. Native sessions are unavailable until then; browser sessions are not affected." });
    // A runtime that is present and cannot load is the fresh-machine failure the container found: the
    // bootstrap unpacks packages and the libraries they need are the machine's own. ldd is the same
    // question the dynamic loader will ask, asked before a session does.
    const sway = join(native.executables, "sway");
    if (await probe.file(sway, true)) {
      const missing = probe.missingLibraries([sway, native.pointer], join(native.runtime, "root/usr/lib64"));
      add("private-runtime-libraries", "native", !missing.length,
        { id: "no-native-libraries", needsElevation: true, agentMayRun: false,
          command: `sudo dnf install ${nativeRuntimePackages}`,
          message: `The private compositor is built and cannot load${missing.length ? ` ${missing.join(", ")}` : ""}. Those are Fedora packages the bootstrap does not install.` });
    }
    for (const name of ["grim", "wl-copy", "wl-paste"])
      add(name, "native", await probe.file(`/usr/bin/${name}`, true),
        await systemPackages(probe, "no-capture-tools",
          "Native sessions capture with grim and paste through wl-clipboard. Browser sessions do not need either.",
          { any: ["grim", "wl-clipboard"] }));
    const xwayland = probe.which("Xwayland");
    add("xwayland", "native", !!xwayland && await probe.file(xwayland, true),
      await systemPackages(probe, "no-xwayland", "X11 applications on the private display need Xwayland on PATH.",
        { any: ["xwayland"], dnf: ["xorg-x11-server-Xwayland"], zypper: ["xorg-x11-server-Xwayland"], pacman: ["xorg-xwayland"] }));
  }
  const available = (group: string) => checks.filter(check => check.group === "common" || check.group === group).every(check => check.available);
  // `every` on an empty list is true, so skipping the native checks on Windows would report
  // `nativePrerequisitesFound: true` on a machine that cannot have a private display at all. That is a
  // worse answer than the Fedora remedies it replaced: one is noise, this would be a false capability
  // claim in the field an agent branches on. Not measured is not a pass, and here it is not even a
  // possibility, so it is stated as false.
  const nativePrerequisitesFound = windows ? false : available("native");
  return { check: "prerequisite-availability", browserPrerequisitesFound: available("browser"), nativePrerequisitesFound, checks,
    nativeRuntime: { source: runtimeSource },
    notVerified: ["Bun/runtime version compatibility", "cgroup delegation and the enforced resource budget", "shared libraries and executable startup", "disk-backed private workspace storage", "application behavior and desktop CPU acceptance"],
    startsApplications: false };
}
