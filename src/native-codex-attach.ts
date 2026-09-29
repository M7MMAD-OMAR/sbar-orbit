import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import type { CodexDisplayEnv } from "./native-codex";
import { validateStagedCodexCandidate } from "./native-codex-candidate";
import { seedNativePreferences } from "./native-preferences";
import { startCodexReadOnlyGate, type PaginatedPageRequest } from "./codex-authority-gate";

const installedExecutable = "/usr/lib/chatgpt/ChatGPT";

export function activeCodexAuthoritySocketPath(): string {
  return process.env.ORBIT_CODEX_AUTHORITY_SOCKET ??
    join(`/run/user/${process.getuid?.()}`, "codex-desktop", "app-server-bridge", "app-server.sock");
}

function activeCodexExecutable() {
  const executable = process.env.ORBIT_CODEX_CANDIDATE_EXECUTABLE;
  const manifestSha256 = process.env.ORBIT_CODEX_CANDIDATE_MANIFEST_SHA256;
  if (executable === undefined && manifestSha256 === undefined)
    return { executable: installedExecutable };
  if (!executable || !manifestSha256)
    throw new OrbitError("UNSUPPORTED", "Codex candidate needs both broker executable and manifest SHA-256 settings");
  return { executable, manifestSha256 };
}

export type CodexAuthoritySocket = { path: string; device: string; inode: string };

export type PreparedCodexAttachedLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: [];
  privateHome: string;
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
      path === join(runtime, "orbit-codex-authority.sock"))
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

async function attachCapableExecutable(path: string, session: string,
                                       options: { allowFixture?: boolean; candidateManifestSha256?: string }) {
  if (path !== resolve(path))
    throw new OrbitError("INVALID_REQUEST", "Codex attach executable needs a canonical path");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || await realpath(path) !== path)
    throw new OrbitError("UNSUPPORTED", "Codex attach executable is unavailable");
  if (path.startsWith(session + sep)) {
    if (!options.allowFixture) throw new OrbitError("UNSUPPORTED", "Public Codex launch cannot use a session fixture executable");
    return;
  }
  if (path !== installedExecutable) {
    if (!options.candidateManifestSha256)
      throw new OrbitError("UNSUPPORTED", "Codex candidate needs a broker-pinned manifest");
    await validateStagedCodexCandidate(path, options.candidateManifestSha256);
    return;
  }
  if (options.candidateManifestSha256)
    throw new OrbitError("UNSUPPORTED", "Installed Codex cannot use a candidate manifest");
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
  options: { allowFixture?: boolean; candidateManifestSha256?: string;
    fixturePaginatedPageReader?: (request: PaginatedPageRequest) => Promise<unknown>;
    fixtureTurnThreadId?: string } = { allowFixture: true },
): Promise<PreparedCodexAttachedLaunch> {
  const session = resolve(sessionDirectory);
  if (!session.startsWith("/tmp/orbit-native-") || display.runtimeDirectory !== session ||
      !/^[A-Za-z0-9_.-]+$/.test(display.waylandDisplay) || !display.libraryPath)
    throw new OrbitError("INVALID_REQUEST", "Codex attach needs Orbit's private display environment");
  await ownedPrivateDirectory(session);
  const fixturePageReader = options.fixturePaginatedPageReader;
  const fixtureTurnThreadId = options.fixtureTurnThreadId;
  if ((fixturePageReader || fixtureTurnThreadId !== undefined) &&
      (options.allowFixture !== true || !executable.startsWith(session + sep) ||
      options.candidateManifestSha256 !== undefined))
    throw new OrbitError("UNSUPPORTED", "Codex fixture access needs a private fixture executable");
  if (fixtureTurnThreadId !== undefined && (!fixturePageReader ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(fixtureTurnThreadId)))
    throw new OrbitError("INVALID_REQUEST", "Codex fixture turn needs one thread and a page reader");
  let verifiedSockets: [CodexAuthoritySocket, CodexAuthoritySocket];
  try {
    const owner = await liveAuthoritySocket(authoritySocketPath);
    const state = await liveAuthoritySocket(`${authoritySocketPath}.state`);
    verifiedSockets = [owner, state];
  } catch (error) {
    if (error instanceof OrbitError && error.code === "INVALID_REQUEST") throw error;
    throw new OrbitError("UNSUPPORTED", "Codex active profile needs a running Desktop authority with both private shared sockets");
  }
  await attachCapableExecutable(executable, session, options);
  const root = await mkdtemp(join(session, "codex-attach-"));
  let gate: Awaited<ReturnType<typeof startCodexReadOnlyGate>> | undefined;
  try {
    await chmod(root, 0o700);
    const privateHome = join(root, "home");
    for (const path of [privateHome, join(privateHome, ".codex"), join(privateHome, ".config", "Codex"),
      join(privateHome, ".local", "share"), join(privateHome, ".local", "state"), join(privateHome, ".cache")])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await seedNativePreferences(join(privateHome, ".config"));
    const fixtureAudit = process.env.ORBIT_CODEX_GATE_METHOD_AUDIT === "1" &&
      (fixturePageReader !== undefined ||
        /^\/var\/tmp\/codex-private-smoke-[A-Za-z0-9-]+\/app\/ChatGPT$/u.test(executable));
    const auditPath = fixturePageReader ? join(session, "codex-gate-audit.jsonl")
      : join(dirname(dirname(executable)), "gate-audit.jsonl");
    let auditCount = 0;
    let notificationAuditCount = 0;
    gate = await startCodexReadOnlyGate(session, authoritySocketPath, `${authoritySocketPath}.state`, {
      ownerIdentity: verifiedSockets[0], stateIdentity: verifiedSockets[1],
      ...(fixturePageReader ? { allowThreadMetadataRead: true, allowPaginatedThreadPages: true,
        readPaginatedThreadPage: fixturePageReader } : {}),
      ...(fixtureTurnThreadId ? { fixtureTurnThreadId, fixturePollSavedTurn: true } : {}),
      ...(fixtureAudit && fixtureTurnThreadId ? { auditFixtureNotificationShape: (
        shape: { method: string; keys: string[]; outcome: "allow" | "deny" }) => {
        if (notificationAuditCount++ < 200) appendFileSync(auditPath,
          JSON.stringify({ notification: shape }) + "\n",
          { encoding: "utf8", mode: 0o600, flag: "a" });
      } } : {}),
      ...(fixtureAudit ? { auditMethod: (method: string, outcome: "allow" | "deny") => {
        if (auditCount++ < 200) appendFileSync(auditPath, JSON.stringify({ method, outcome }) + "\n",
          { encoding: "utf8", mode: 0o600, flag: "a" });
      }, auditThreadListShape: (fields: Array<{ key: string; kind: string; length?: number }>) => {
        if (auditCount++ < 200) appendFileSync(auditPath, JSON.stringify({ method: "thread/list", fields }) + "\n",
          { encoding: "utf8", mode: 0o600, flag: "a" });
      } } : {}),
    });
    const insideHome = homedir();
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
      `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${gate.socketPath}`,
      "CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1",
      ...(fixturePageReader ? ["CODEX_LINUX_ATTACH_PAGINATED_VIEWER_READY=1"] : []),
      ...(fixtureTurnThreadId ? ["CODEX_LINUX_ATTACH_FIXTURE_WRITE_READY=1"] : []),
      `CODEX_LINUX_APP_SERVER_BRIDGE_PRIVATE_CODEX_HOME=${join(insideHome, ".codex")}`,
      `CODEX_LINUX_APP_DIR=${dirname(executable)}`,
      executable, "--enable-features=UseOzonePlatform", "--ozone-platform=wayland",
      `--user-data-dir=${join(insideHome, ".config", "Codex")}`,
    ];
    const activeGate = gate;
    return { argv, toolkit: "wayland", selectedFiles: [], privateHome,
      release: async () => { await activeGate.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await gate?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareActiveCodexAttachedLaunch(
  sessionDirectory: string,
  display: CodexDisplayEnv,
): Promise<PreparedCodexAttachedLaunch> {
  const target = activeCodexExecutable();
  return prepareCodexAttachedLaunch(sessionDirectory, display, activeCodexAuthoritySocketPath(),
    target.executable, { allowFixture: false, candidateManifestSha256: target.manifestSha256 });
}
