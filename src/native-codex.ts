import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";

const maximumAuthBytes = 1024 * 1024;
const installedExecutable = "/usr/lib/chatgpt/ChatGPT";

export type CodexProfileSource = { authPath?: string; executable?: string };
export type CodexDisplayEnv = { runtimeDirectory: string; waylandDisplay: string; libraryPath: string };

export type PreparedCodexLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: [];
  privateHome: string;
  accountSnapshot: { authBytes: number; mode: "chatgpt" };
  release: () => Promise<void>;
};

async function readStableAuth(path: string): Promise<Buffer> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new OrbitError("UNSUPPORTED", "Codex account source is unavailable"); }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumAuthBytes)
      throw new OrbitError("UNSUPPORTED", "Codex account source must be a regular unlinked file within its size limit");
    const contents = await file.readFile();
    const after = await file.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        before.dev !== after.dev || before.ino !== after.ino || before.ino !== current.ino ||
        before.size !== after.size || before.size !== current.size ||
        before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs)
      throw new OrbitError("BACKEND_FAILED", "Codex account source changed during the snapshot");
    let parsed: unknown;
    try { parsed = JSON.parse(contents.toString("utf8")); }
    catch { throw new OrbitError("UNSUPPORTED", "Codex account source is invalid"); }
    if (typeof parsed !== "object" || parsed === null ||
        (parsed as { auth_mode?: unknown }).auth_mode !== "chatgpt" ||
        typeof (parsed as { last_refresh?: unknown }).last_refresh !== "string")
      throw new OrbitError("UNSUPPORTED", "Codex account source does not contain a ChatGPT login");
    const tokens = (parsed as { tokens?: unknown }).tokens;
    if (typeof tokens !== "object" || tokens === null ||
        typeof (tokens as { id_token?: unknown }).id_token !== "string" ||
        typeof (tokens as { access_token?: unknown }).access_token !== "string" ||
        typeof (tokens as { refresh_token?: unknown }).refresh_token !== "string" ||
        typeof (tokens as { account_id?: unknown }).account_id !== "string")
      throw new OrbitError("UNSUPPORTED", "Codex account source has no reusable session tokens");
    const accountTokens = tokens as { id_token: string; access_token: string; refresh_token: string; account_id: string };
    const access = accountTokens.access_token;
    const payload = access.split(".")[1];
    let expiry: unknown;
    try { expiry = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")).exp; }
    catch { throw new OrbitError("UNSUPPORTED", "Codex account access token has no readable expiry"); }
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry * 1000 < Date.now() + 300000)
      throw new OrbitError("UNSUPPORTED", "Codex account access token is too close to refresh for a safe copy");
    accountTokens.refresh_token = "";
    return Buffer.from(JSON.stringify(parsed));
  } finally { await file.close(); }
}

export async function prepareCodexLaunch(
  sessionDirectory: string,
  display: CodexDisplayEnv,
  source: CodexProfileSource = {},
): Promise<PreparedCodexLaunch> {
  const session = resolve(sessionDirectory);
  const metadata = await stat(session);
  if (!metadata.isDirectory()) throw new OrbitError("INVALID_REQUEST", "Codex needs a private session directory");
  if (display.runtimeDirectory !== session || !/^[A-Za-z0-9_.-]+$/.test(display.waylandDisplay) ||
      !display.libraryPath)
    throw new OrbitError("INVALID_REQUEST", "Codex needs Orbit's private display environment");
  const executable = source.executable ?? installedExecutable;
  if (!(await stat(executable).then(value => value.isFile(), () => false)))
    throw new OrbitError("UNSUPPORTED", "Codex Desktop is not installed");
  const authPath = source.authPath ?? join(homedir(), ".codex", "auth.json");
  const root = await mkdtemp(join(session, "codex-"));
  try {
    await chmod(root, 0o700);
    const home = join(root, "home");
    const codex = join(home, ".codex");
    const config = join(home, ".config");
    const data = join(home, ".local", "share");
    const state = join(home, ".local", "state");
    const cache = join(home, ".cache");
    for (const path of [home, codex, config, join(config, "Codex"), join(home, ".local"), data, state, cache])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const auth = await readStableAuth(authPath);
    await writeFile(join(codex, "auth.json"), auth, { flag: "wx", mode: 0o600 });
    const insideHome = homedir();
    const argv = [
      "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "XDG_SESSION_TYPE=wayland",
      `XDG_RUNTIME_DIR=${display.runtimeDirectory}`, `WAYLAND_DISPLAY=${display.waylandDisplay}`,
      `LD_LIBRARY_PATH=${display.libraryPath}`,
      `HOME=${insideHome}`, `CODEX_HOME=${join(insideHome, ".codex")}`,
      `XDG_CONFIG_HOME=${join(insideHome, ".config")}`,
      `XDG_DATA_HOME=${join(insideHome, ".local", "share")}`,
      `XDG_STATE_HOME=${join(insideHome, ".local", "state")}`,
      `XDG_CACHE_HOME=${join(insideHome, ".cache")}`,
      executable, "--enable-features=UseOzonePlatform", "--ozone-platform=wayland",
      `--user-data-dir=${join(insideHome, ".config", "Codex")}`,
    ];
    if (!home.startsWith(session + sep)) throw new OrbitError("BACKEND_FAILED", "Codex snapshot escaped the session");
    return {
      argv, toolkit: "wayland", selectedFiles: [], privateHome: home,
      accountSnapshot: { authBytes: auth.length, mode: "chatgpt" },
      release: async () => { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
