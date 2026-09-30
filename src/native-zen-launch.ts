import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import { openPublicWebLease, type PublicWebLease, type PublicWebLeaseRequest } from "./egress";
import { snapshotZenProfile, type ZenProfileSnapshot } from "./native-zen";
import { quietZenSync } from "./native-zen-sync";

type ZenLocation = { home?: string; deploymentFiles?: string;
  leaseProbe?: Pick<PublicWebLeaseRequest, "resolveHost" | "routeForTest"> };
type ZenInstallation = { deploymentFiles: string; profile: string; appRoot: string };

async function renderDeviceMounts(): Promise<string[]> {
  let names: string[];
  try { names = await readdir("/dev/dri"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nodes: string[] = [];
  for (const name of names.sort()) {
    if (!/^renderD[0-9]+$/.test(name)) continue;
    const node = join("/dev/dri", name);
    const entry = await lstat(node);
    if (entry.isCharacterDevice() && entry.uid === 0) nodes.push(node);
  }
  if (nodes.length > 16) throw new OrbitError("UNSUPPORTED", "Too many render devices for private Zen");
  return nodes.length ? ["--dir", "/dev/dri", ...nodes.flatMap(node => ["--dev-bind", node, node])] : [];
}

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
  const appRoot = await realpath(resolve(home, ".var/app/app.zen_browser.zen"));
  if (!baseReal.startsWith(appRoot + sep))
    throw new OrbitError("UNSUPPORTED", "Zen profile directory escaped its application data root");
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
      return { deploymentFiles: files, profile, appRoot };
  }
  throw new OrbitError("UNSUPPORTED", "The installed Zen Flatpak ELF was not found");
}

export type PreparedZenLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: string[];
  zenFilePolicy?: { paths: string[]; protectedDirectories: string[] };
  zenSnapshot: Pick<ZenProfileSnapshot, "files" | "bytes" | "databases" | "recoveryFiles" | "recoveredTabs"> &
    { network: "offline" | "public-web"; hostFiles: "unavailable" | "selected-live";
      sharedFiles?: { hostPath: string; privatePath: string }[] };
  refusedAuthorities: () => string[];
  release: () => Promise<void>;
};

export type ZenNetwork = "offline" | "public-web";

const proxyPreferences = `
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "127.0.0.1");
user_pref("network.proxy.http_port", 8888);
user_pref("network.proxy.ssl", "127.0.0.1");
user_pref("network.proxy.ssl_port", 8888);
user_pref("network.proxy.no_proxies_on", "");
user_pref("network.proxy.allow_hijacking_localhost", true);
user_pref("network.http.http3.enable", false);
user_pref("media.peerconnection.enabled", false);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.prefetch-next", false);
`;

async function writePrivateProxyPreferences(profile: string): Promise<void> {
  const target = join(profile, "user.js");
  const entry = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024))
    throw new OrbitError("UNSUPPORTED", "Zen copied proxy preferences must be a regular file");
  let existing = "";
  if (entry) {
    const source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await source.stat()).isFile()) throw new OrbitError("UNSUPPORTED", "Zen copied proxy preferences changed");
      existing = await source.readFile({ encoding: "utf8" });
    } finally { await source.close(); }
  }
  const temporary = join(profile, `.orbit-proxy-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(existing + proxyPreferences);
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

const publicWebScript = [
  '/usr/bin/socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/orbit/zen/runtime/lease.sock </dev/null >/dev/null 2>&1 &',
  'bridge=$!',
  'trap \'kill "$bridge" 2>/dev/null; wait "$bridge" 2>/dev/null\' EXIT',
  'ready=0',
  'for attempt in 1 2 3 4 5 6 7 8 9 10; do',
  '  if /usr/bin/python3 -c \'import socket; s=socket.socket(); s.settimeout(0.2); status=s.connect_ex(("127.0.0.1", 8888)); s.close(); raise SystemExit(status != 0)\'; then ready=1; break; fi',
  '  kill -0 "$bridge" 2>/dev/null || exit 111',
  '  /usr/bin/sleep 0.05',
  'done',
  '[ "$ready" -eq 1 ] || exit 111',
  '"$@"',
].join("\n");

/** Start only from a copied profile. The action caller cannot supply paths or arguments. */
export async function prepareZenLaunch(
  sessionDirectory: string, waylandSocket: string, libraryDirectory: string, location: ZenLocation = {},
  network: ZenNetwork = "offline",
  sharedFiles: string[] = [],
  origins: () => string[] = () => [],
): Promise<PreparedZenLaunch> {
  if (network === "public-web" && !origins().length)
    throw new OrbitError("INVALID_REQUEST", "Zen public web needs at least one bounded origin");
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
  if (!Array.isArray(sharedFiles) || sharedFiles.length > 16 ||
      sharedFiles.some(path => typeof path !== "string" || !path.startsWith("/") || path.length > 4096 ||
        path.includes("\0") || path.split("/").slice(1).some(part => !part || part === "." || part === "..")))
    throw new OrbitError("INVALID_REQUEST", "Zen can share up to 16 canonical absolute files");
  const privateDirectory = await mkdtemp(join(session, "zen-"));
  await chmod(privateDirectory, 0o700);
  let lease: PublicWebLease | undefined;
  try {
    const snapshot = await snapshotZenProfile(installation.profile, privateDirectory);
    for (const name of ["runtime", "config", "data", "cache", "state"])
      await mkdir(join(privateDirectory, name), { mode: 0o700 });
    await writeFile(join(privateDirectory, "runtime", "wayland-0"), "", { mode: 0o600 });
    if (network === "public-web") {
      if (!(await Bun.file("/usr/bin/socat").exists()))
        throw new OrbitError("UNSUPPORTED", "Zen public web mode needs socat");
      await writePrivateProxyPreferences(snapshot.directory);
      await quietZenSync(snapshot.directory, installation.profile);
      lease = await openPublicWebLease({ parentDirectory: session, origins, ...location.leaseProbe });
      await writeFile(join(privateDirectory, "runtime", "lease.sock"), "", { mode: 0o600 });
    }
    const profileInside = `/orbit/zen/${basename(snapshot.directory)}`;
    const argv = [
      "/usr/bin/bwrap", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--dev", "/dev", ...await renderDeviceMounts(), "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run",
      "--dir", "/etc",
      "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind", "/etc/passwd", "/etc/passwd",
      "--ro-bind", "/etc/group", "/etc/group", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind", installation.deploymentFiles, "/app", "--ro-bind", libraries, "/runtime-lib",
      "--dir", "/orbit", "--bind", privateDirectory, "/orbit/zen",
      "--ro-bind", socket, "/orbit/zen/runtime/wayland-0",
      ...(lease ? ["--ro-bind", lease.socketPath, "/orbit/zen/runtime/lease.sock"] : []),
      "--clearenv", "--setenv", "HOME", "/orbit/zen", "--setenv", "XDG_RUNTIME_DIR", "/orbit/zen/runtime",
      "--setenv", "XDG_CONFIG_HOME", "/orbit/zen/config", "--setenv", "XDG_DATA_HOME", "/orbit/zen/data",
      "--setenv", "XDG_CACHE_HOME", "/orbit/zen/cache", "--setenv", "XDG_STATE_HOME", "/orbit/zen/state",
      "--setenv", "WAYLAND_DISPLAY", "wayland-0", "--setenv", "GDK_BACKEND", "wayland",
      "--setenv", "MOZ_ENABLE_WAYLAND", "1", "--setenv", "NO_AT_BRIDGE", "1",
      "--setenv", "DBUS_SESSION_BUS_ADDRESS", "unix:path=/orbit/zen/runtime/no-session-bus",
      "--setenv", "LD_LIBRARY_PATH", "/runtime-lib:/app/lib:/app/zen", "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8", "--chdir", "/orbit/zen",
      // The shell, bridge, and Zen all run under the same bubblewrap PID and network namespaces.
      ...(lease ? ["/usr/bin/sh", "-c", publicWebScript, "orbit-zen"] : []),
      "/app/zen/zen", "--no-remote", "--profile", profileInside,
    ];
    const uid = process.getuid?.();
    if (sharedFiles.length && uid === undefined)
      throw new OrbitError("UNSUPPORTED", "Zen shared files need a Unix user runtime");
    const zenFilePolicy = sharedFiles.length ? { paths: sharedFiles,
      protectedDirectories: [installation.appRoot, session, `/run/user/${uid}`] } : undefined;
    return { argv, toolkit: "wayland", selectedFiles: sharedFiles,
      ...(zenFilePolicy ? { zenFilePolicy } : {}),
      zenSnapshot: { files: snapshot.files, bytes: snapshot.bytes, databases: snapshot.databases,
        recoveryFiles: snapshot.recoveryFiles, recoveredTabs: snapshot.recoveredTabs,
        network, hostFiles: sharedFiles.length ? "selected-live" : "unavailable",
        ...(sharedFiles.length ? { sharedFiles: sharedFiles.map((hostPath, index) => ({
          hostPath, privatePath: `/orbit/shared/${index + 1}/${basename(hostPath)}` })) } : {}) },
      refusedAuthorities: () => lease?.refused() ?? [],
      release: async () => {
        const results = await Promise.allSettled([
          lease?.close(), rm(privateDirectory, { recursive: true, force: true }),
        ]);
        if (results.some(result => result.status === "rejected"))
          throw new OrbitError("BACKEND_FAILED", "Zen private profile or web lease cleanup failed");
      } };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      lease?.close(), rm(privateDirectory, { recursive: true, force: true }),
    ]);
    if (cleanup.some(result => result.status === "rejected"))
      throw new OrbitError("BACKEND_FAILED", "Zen launch preparation cleanup failed");
    throw error;
  }
}
