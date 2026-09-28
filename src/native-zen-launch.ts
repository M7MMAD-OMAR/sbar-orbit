import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import { snapshotZenProfile, type ZenProfileSnapshot } from "./native-zen";

type ZenLocation = { home?: string; deploymentFiles?: string };
type ZenInstallation = { deploymentFiles: string; profile: string };

function selectedProfile(ini: string): string {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line)?.[1];
    if (section) { current = new Map(); sections.set(section, current); continue; }
    const equal = line.indexOf("=");
    if (current && equal > 0) current.set(line.slice(0, equal).trim(), line.slice(equal + 1).trim());
  }
  const installDefaults = [...sections.entries()].filter(([name, values]) => name.startsWith("Install") && values.get("Default"))
    .map(([, values]) => values.get("Default"));
  const profileDefaults = [...sections.entries()].filter(([name, values]) => name.startsWith("Profile") && values.get("Default") === "1")
    .map(([, values]) => values.get("Path"));
  const choices = installDefaults.length ? installDefaults : profileDefaults;
  const selected = choices.length === 1 || choices.every(choice => choice === choices[0]) ? choices[0] : undefined;
  if (!selected || selected.includes("\0"))
    throw new OrbitError("UNSUPPORTED", "Zen has no unambiguous active profile in profiles.ini");
  return selected;
}

export async function discoverZenInstallation(location: ZenLocation = {}): Promise<ZenInstallation> {
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Zen private launch requires Linux");
  const home = location.home ?? homedir();
  const base = resolve(home, ".var/app/app.zen_browser.zen/config/zen");
  const baseEntry = await lstat(base).catch(() => undefined);
  if (!baseEntry?.isDirectory() || baseEntry.isSymbolicLink())
    throw new OrbitError("UNSUPPORTED", "Zen Flatpak profile directory is unavailable");
  const profileName = selectedProfile(await readFile(join(base, "profiles.ini"), "utf8"));
  const baseReal = await realpath(base);
  const profile = await realpath(resolve(base, profileName)).catch(() => "");
  if (!profile.startsWith(baseReal + sep) || !(await lstat(profile).catch(() => undefined))?.isDirectory())
    throw new OrbitError("UNSUPPORTED", "Zen active profile must be a real directory inside its installation");
  const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";
  if (!architecture) throw new OrbitError("UNSUPPORTED", "Zen installation architecture is unsupported");
  const candidates = location.deploymentFiles ? [location.deploymentFiles] : [
    `/var/lib/flatpak/app/app.zen_browser.zen/${architecture}/stable/active/files`,
    join(home, `.local/share/flatpak/app/app.zen_browser.zen/${architecture}/stable/active/files`),
  ];
  for (const candidate of candidates) {
    const files = await realpath(candidate).catch(() => "");
    if (!files) continue;
    const executable = await lstat(join(files, "zen/zen")).catch(() => undefined);
    if (executable?.isFile() && executable.mode & 0o111)
      return { deploymentFiles: files, profile };
  }
  throw new OrbitError("UNSUPPORTED", "The installed Zen Flatpak ELF was not found");
}

export type PreparedZenLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: [];
  zenSnapshot: Pick<ZenProfileSnapshot, "files" | "bytes" | "databases" | "recoveryFiles" | "recoveredTabs"> &
    { network: "offline"; hostFiles: "unavailable" };
  release: () => Promise<void>;
};

/** Start only from a copied profile. The action caller cannot supply paths or arguments. */
export async function prepareZenLaunch(
  sessionDirectory: string, waylandSocket: string, libraryDirectory: string, location: ZenLocation = {},
): Promise<PreparedZenLaunch> {
  const session = await realpath(sessionDirectory);
  const socket = await realpath(waylandSocket);
  const socketEntry = await lstat(socket);
  if (!socket.startsWith(session + sep) || !socketEntry.isSocket())
    throw new OrbitError("UNSUPPORTED", "Zen needs the Orbit session's private Wayland socket");
  const libraries = await realpath(libraryDirectory);
  if (!(await lstat(libraries)).isDirectory())
    throw new OrbitError("UNSUPPORTED", "Zen needs the installed private display libraries");
  if (!(await Bun.file("/usr/bin/bwrap").exists()))
    throw new OrbitError("UNSUPPORTED", "Zen private launch needs bubblewrap");
  const installation = await discoverZenInstallation(location);
  const privateDirectory = await mkdtemp(join(session, "zen-"));
  await chmod(privateDirectory, 0o700);
  try {
    const snapshot = await snapshotZenProfile(installation.profile, privateDirectory);
    for (const name of ["runtime", "config", "data", "cache", "state"])
      await mkdir(join(privateDirectory, name), { mode: 0o700 });
    await writeFile(join(privateDirectory, "runtime", "wayland-0"), "", { mode: 0o600 });
    const profileInside = `/orbit/zen/${basename(snapshot.directory)}`;
    const argv = [
      "/usr/bin/bwrap", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run",
      "--dir", "/etc", "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind", "/etc/passwd", "/etc/passwd",
      "--ro-bind", "/etc/group", "/etc/group", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind", installation.deploymentFiles, "/app", "--ro-bind", libraries, "/runtime-lib",
      "--dir", "/orbit", "--bind", privateDirectory, "/orbit/zen",
      "--ro-bind", socket, "/orbit/zen/runtime/wayland-0",
      "--clearenv", "--setenv", "HOME", "/orbit/zen", "--setenv", "XDG_RUNTIME_DIR", "/orbit/zen/runtime",
      "--setenv", "XDG_CONFIG_HOME", "/orbit/zen/config", "--setenv", "XDG_DATA_HOME", "/orbit/zen/data",
      "--setenv", "XDG_CACHE_HOME", "/orbit/zen/cache", "--setenv", "XDG_STATE_HOME", "/orbit/zen/state",
      "--setenv", "WAYLAND_DISPLAY", "wayland-0", "--setenv", "GDK_BACKEND", "wayland",
      "--setenv", "MOZ_ENABLE_WAYLAND", "1", "--setenv", "NO_AT_BRIDGE", "1",
      "--setenv", "DBUS_SESSION_BUS_ADDRESS", "unix:path=/orbit/zen/runtime/no-session-bus",
      "--setenv", "LD_LIBRARY_PATH", "/runtime-lib:/app/lib:/app/zen", "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8", "--chdir", "/orbit/zen",
      "/app/zen/zen", "--no-remote", "--profile", profileInside,
    ];
    return { argv, toolkit: "wayland", selectedFiles: [],
      zenSnapshot: { files: snapshot.files, bytes: snapshot.bytes, databases: snapshot.databases,
        recoveryFiles: snapshot.recoveryFiles, recoveredTabs: snapshot.recoveredTabs,
        network: "offline", hostFiles: "unavailable" },
      release: async () => { await rm(privateDirectory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(privateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
