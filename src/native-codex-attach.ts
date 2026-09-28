import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import type { CodexDisplayEnv } from "./native-codex";
import { seedNativePreferences } from "./native-preferences";

const installedExecutable = "/usr/lib/chatgpt/ChatGPT";
const privateSocketName = "orbit-codex-authority.sock";

export type CodexAuthoritySocket = { path: string; device: string; inode: string };

export type PreparedCodexAttachedLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: [];
  privateHome: string;
  authoritySocket: CodexAuthoritySocket;
  authorityStateSocket: CodexAuthoritySocket;
  release: () => Promise<void>;
};

async function ownedPrivateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 || await realpath(path) !== path)
    throw new OrbitError("UNSUPPORTED", "Codex attach directory must be owned and private");
}

async function liveAuthoritySocket(path: string): Promise<CodexAuthoritySocket> {
  const runtime = `/run/user/${process.getuid?.()}`;
  if (path !== resolve(path) || !path.startsWith(runtime + sep) || path.length > 4096 || path.includes("\0") ||
      path === join(runtime, privateSocketName))
    throw new OrbitError("INVALID_REQUEST", "Codex attach socket must be below the user runtime");
  const parts = path.slice(runtime.length + 1).split(sep);
  if (parts.some(part => !part || part === "." || part === ".."))
    throw new OrbitError("INVALID_REQUEST", "Codex attach socket path is unsafe");
  for (let depth = 0; depth < parts.length; depth++)
    await ownedPrivateDirectory(join(runtime, ...parts.slice(0, depth)));
  const before = await lstat(path, { bigint: true });
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n || before.nlink !== 1n || await realpath(path) !== path)
    throw new OrbitError("UNSUPPORTED", "Codex authority socket is not owned and private");
  await new Promise<void>((resolveConnection, reject) => {
    const connection = createConnection({ path });
    const finish = (error?: Error) => {
      connection.removeAllListeners();
      connection.destroy();
      if (error) reject(error);
      else resolveConnection();
    };
    connection.once("connect", () => finish());
    connection.once("error", error => finish(error));
    connection.setTimeout(2000, () => finish(new Error("Codex authority socket did not respond")));
  }).catch(() => { throw new OrbitError("UNSUPPORTED", "Codex authority socket is not accepting connections"); });
  const after = await lstat(path, { bigint: true });
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino ||
      after.uid !== before.uid || after.mode !== before.mode)
    throw new OrbitError("UNSUPPORTED", "Codex authority socket changed during preparation");
  return { path, device: String(before.dev), inode: String(before.ino) };
}

async function attachCapableExecutable(path: string, session: string) {
  if (path !== resolve(path))
    throw new OrbitError("INVALID_REQUEST", "Codex attach executable needs a canonical path");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || await realpath(path) !== path)
    throw new OrbitError("UNSUPPORTED", "Codex attach executable is unavailable");
  if (path.startsWith(session + sep)) return;
  if (path !== installedExecutable)
    throw new OrbitError("UNSUPPORTED", "Codex attach accepts only its private fixture or installed Desktop");
  let staged: unknown;
  try { staged = JSON.parse(await readFile("/usr/lib/chatgpt/.codex-linux/linux-features-staged.json", "utf8")); }
  catch { throw new OrbitError("UNSUPPORTED", "Codex Desktop attach feature is not installed"); }
  const manifest = staged as { resources?: unknown; runtimeHooks?: unknown };
  const resource = Array.isArray(manifest?.resources) && manifest.resources.some(entry =>
    entry?.id === "shared-app-server-socket" &&
    entry?.target === ".codex-linux/features/shared-app-server-socket/orphan-reaper.js");
  const stateBridge = Array.isArray(manifest?.resources) && manifest.resources.some(entry =>
    entry?.id === "shared-app-server-socket" &&
    entry?.target === ".codex-linux/features/shared-app-server-socket/sidebar-state-bridge.js");
  const launcher = Array.isArray(manifest?.runtimeHooks) && manifest.runtimeHooks.some(entry =>
    entry?.id === "shared-app-server-socket" && entry?.key === "launcher");
  if (!resource || !stateBridge || !launcher)
    throw new OrbitError("UNSUPPORTED", "Codex Desktop attach feature is not staged");
}

export async function prepareCodexAttachedLaunch(
  sessionDirectory: string,
  display: CodexDisplayEnv,
  authoritySocketPath: string,
  executable: string,
): Promise<PreparedCodexAttachedLaunch> {
  const session = resolve(sessionDirectory);
  if (!session.startsWith("/tmp/orbit-native-") || display.runtimeDirectory !== session ||
      !/^[A-Za-z0-9_.-]+$/.test(display.waylandDisplay) || !display.libraryPath)
    throw new OrbitError("INVALID_REQUEST", "Codex attach needs Orbit's private display environment");
  await ownedPrivateDirectory(session);
  await attachCapableExecutable(executable, session);
  const authoritySocket = await liveAuthoritySocket(authoritySocketPath);
  const authorityStateSocket = await liveAuthoritySocket(`${authoritySocketPath}.state`);
  const root = await mkdtemp(join(session, "codex-attach-"));
  try {
    await chmod(root, 0o700);
    const privateHome = join(root, "home");
    for (const path of [privateHome, join(privateHome, ".codex"), join(privateHome, ".config", "Codex"),
      join(privateHome, ".local", "share"), join(privateHome, ".local", "state"), join(privateHome, ".cache")])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await seedNativePreferences(join(privateHome, ".config"));
    const insideHome = homedir();
    const privateSocketPath = join(`/run/user/${process.getuid?.()}`, privateSocketName);
    const argv = [
      "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "XDG_SESSION_TYPE=wayland",
      "GSETTINGS_BACKEND=dconf",
      `XDG_RUNTIME_DIR=${display.runtimeDirectory}`, `WAYLAND_DISPLAY=${display.waylandDisplay}`,
      `LD_LIBRARY_PATH=${display.libraryPath}`,
      `HOME=${insideHome}`, `CODEX_HOME=${join(insideHome, ".codex")}`,
      `XDG_CONFIG_HOME=${join(insideHome, ".config")}`,
      `XDG_DATA_HOME=${join(insideHome, ".local", "share")}`,
      `XDG_STATE_HOME=${join(insideHome, ".local", "state")}`,
      `XDG_CACHE_HOME=${join(insideHome, ".cache")}`,
      `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${privateSocketPath}`,
      "CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1",
      `CODEX_LINUX_APP_SERVER_BRIDGE_PRIVATE_CODEX_HOME=${join(insideHome, ".codex")}`,
      executable, "--enable-features=UseOzonePlatform", "--ozone-platform=wayland",
      `--user-data-dir=${join(insideHome, ".config", "Codex")}`,
    ];
    return { argv, toolkit: "wayland", selectedFiles: [], privateHome, authoritySocket, authorityStateSocket,
      release: async () => { await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
