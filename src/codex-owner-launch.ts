import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import { validateStagedCodexCandidate } from "./native-codex-candidate";

const originalExecutable = "/usr/lib/chatgpt/ChatGPT";
const configFormat = "orbit-codex-owner-v1";
const digestPattern = /^[a-f0-9]{64}$/;
const waylandFlags = ["--enable-features=UseOzonePlatform", "--ozone-platform=wayland", "--enable-wayland-ime"];

type OwnerConfig = {
  format: typeof configFormat;
  candidateExecutable: string;
  manifestSha256: string;
};

export type CodexOwnerLaunchPlan = {
  choice: "candidate" | "original";
  executable: string;
  args: string[];
  env: Record<string, string>;
  setEnvKeys: string[];
};

function refuse(message: string): never {
  throw new OrbitError("UNSUPPORTED", message);
}

async function checkedDirectory(path: string, privateDirectory = false) {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() ||
      entry.uid !== BigInt(process.getuid?.() ?? -1) || (entry.mode & 0o022n) !== 0n ||
      (privateDirectory && (entry.mode & 0o777n) !== 0o700n) || await realpath(path) !== path)
    refuse("Codex owner configuration directory is unsafe");
}

async function readOwnerConfig(home: string): Promise<OwnerConfig> {
  if (home !== resolve(home) || home.length > 4096 || home.includes("\0"))
    refuse("Codex owner home must be canonical");
  const config = join(home, ".config");
  const orbit = join(config, "sbar-orbit");
  for (const path of [home, config]) await checkedDirectory(path);
  await checkedDirectory(orbit, true);
  const path = join(orbit, "codex-owner.json");
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o777n) !== 0o600n ||
      before.size > 4096n || await realpath(path) !== path)
    refuse("Codex owner configuration file is unsafe");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      refuse("Codex owner configuration changed before reading");
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs || named.dev !== before.dev || named.ino !== before.ino ||
        named.mtimeNs !== before.mtimeNs)
      refuse("Codex owner configuration changed during reading");
  } finally { await handle.close(); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { refuse("Codex owner configuration is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("Codex owner configuration is invalid");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "candidateExecutable,format,manifestSha256" ||
      object.format !== configFormat || typeof object.candidateExecutable !== "string" ||
      typeof object.manifestSha256 !== "string" || !digestPattern.test(object.manifestSha256))
    refuse("Codex owner configuration is invalid");
  return object as OwnerConfig;
}

function checkedUrls(urls: string[]): string[] {
  if (urls.length > 64) throw new OrbitError("INVALID_REQUEST", "Codex owner accepts at most 64 URLs");
  for (const value of urls) {
    if (value.length > 8192 || value.includes("\0"))
      throw new OrbitError("INVALID_REQUEST", "Codex owner URL is invalid");
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new OrbitError("INVALID_REQUEST", "Codex owner accepts URLs only"); }
    if (!["codex:", "http:", "https:", "file:"].includes(parsed.protocol))
      throw new OrbitError("INVALID_REQUEST", "Codex owner URL scheme is unsupported");
  }
  return urls;
}

export async function prepareCodexOwnerLaunch(
  urls: string[],
  options: { home?: string; sourceRoot?: string; inheritedEnv?: NodeJS.ProcessEnv; uid?: number } = {},
): Promise<CodexOwnerLaunchPlan> {
  const home = options.home ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  const args = [...waylandFlags, ...checkedUrls(urls)];
  const env = Object.fromEntries(Object.entries(options.inheritedEnv ?? process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_LINUX_APP_SERVER_BRIDGE_") ||
        key === "CODEX_CLI_PATH" || key === "CODEX_LINUX_APP_DIR") delete env[key];
  }
  const original = (): CodexOwnerLaunchPlan => ({
    choice: "original", executable: originalExecutable, args, env, setEnvKeys: [],
  });
  if (uid === undefined) return original();
  try {
    const config = await readOwnerConfig(home);
    const base = join(home, ".local", "share", "sbar-orbit", "codex-candidates");
    if (dirname(dirname(dirname(config.candidateExecutable))) !== base ||
        !config.candidateExecutable.startsWith(base + sep))
      refuse("Codex owner candidate must use durable Orbit storage");
    await validateStagedCodexCandidate(config.candidateExecutable, config.manifestSha256,
      options.sourceRoot, home);
    const candidateEnv = {
      ...env,
      CODEX_CLI_PATH: join(dirname(config.candidateExecutable), "resources", "codex"),
      CODEX_LINUX_APP_DIR: dirname(config.candidateExecutable),
      CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:
        join(`/run/user/${uid}`, "codex-desktop", "app-server-bridge", "app-server.sock"),
    };
    return { choice: "candidate", executable: config.candidateExecutable, args, env: candidateEnv,
      setEnvKeys: ["CODEX_CLI_PATH", "CODEX_LINUX_APP_DIR", "CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET"] };
  } catch { return original(); }
}

export function formatCodexOwnerDryRun(plan: CodexOwnerLaunchPlan): string {
  return JSON.stringify({ choice: plan.choice, setEnvKeys: plan.setEnvKeys });
}
