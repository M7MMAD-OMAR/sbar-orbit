import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";

export const agentHosts = ["claude", "codex", "hermes"] as const;
export type AgentHost = typeof agentHosts[number];
export type HostEntry = { command: string; args: string[]; env: Record<string, string> };
export type HostRegistration = { host: AgentHost; path: string;
  state: "configured" | "unchanged" | "planned" | "not-found" | "failed"; detail: string; backup?: string };

export function parseHosts(value: string): "auto" | AgentHost[] {
  if (value === "auto") return value;
  const names = value.split(",");
  if (!names.length || names.some(name => !agentHosts.some(host => host === name)))
    throw new Error("Use --connect auto or a comma-separated list of claude,codex,hermes");
  return [...new Set(names)] as AgentHost[];
}

export function hostConfigPath(host: AgentHost, env = process.env, home = homedir(), platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  if (host === "claude") return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
  if (host === "codex") return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
  // HERMES_HOME is the selected profile's home when Hermes launches a tool.
  const defaultHome = platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "hermes") : path.join(home, ".hermes");
  return path.join(env.HERMES_HOME || defaultHome, "config.yaml");
}

function mapping(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a mapping");
  return value as Record<string, unknown>;
}

function sameEntry(value: unknown, desired: HostEntry) {
  const entry = mapping(value);
  const env = mapping(entry.env);
  return entry.command === desired.command && JSON.stringify(entry.args ?? []) === JSON.stringify(desired.args)
    && Object.entries(desired.env).every(([key, value]) => env[key] === value)
    && !entry.url && entry.enabled !== false && entry.disabled !== true;
}

/** Preserve unrelated settings. Never claim ownership of an existing, different orbit entry. */
export function addHostEntry(host: AgentHost, text: string, entry: HostEntry) {
  const parsed = text.trim() ? host === "codex" ? Bun.TOML.parse(text)
    : host === "hermes" ? Bun.YAML.parse(text) : JSON.parse(text) : {};
  const config = mapping(parsed);
  const key = host === "claude" ? "mcpServers" : "mcp_servers";
  const servers = mapping(config[key]);
  if (Object.hasOwn(servers, "orbit")) {
    if (sameEntry(servers.orbit, entry)) return { changed: false, text };
    throw new Error("An orbit entry already exists with different settings; it was left unchanged");
  }
  if (host === "codex") {
    const quote = (value: string) => JSON.stringify(value);
    const updated = `${text.trimEnd()}\n\n[mcp_servers.orbit]\ncommand = ${quote(entry.command)}\nargs = [${entry.args.map(quote).join(", ")}]\n\n[mcp_servers.orbit.env]\n${Object.entries(entry.env).map(([key, value]) => `${quote(key)} = ${quote(value)}`).join("\n")}\n`;
    Bun.TOML.parse(updated);
    return { changed: true, text: updated };
  }
  config[key] = { ...servers, orbit: entry };
  return { changed: true, text: host === "hermes" ? Bun.YAML.stringify(config) : `${JSON.stringify(config, null, 2)}\n` };
}

async function existingFile(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Configuration is not a regular file; it was left unchanged");
  return readFile(path, "utf8");
}

export async function registerAgentHosts(selection: "auto" | AgentHost[], entry: HostEntry,
  options: { dryRun?: boolean; env?: NodeJS.ProcessEnv; home?: string;
    which?: (name: string) => string | null } = {}): Promise<HostRegistration[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const which = options.which ?? Bun.which;
  const results: HostRegistration[] = [];
  for (const host of selection === "auto" ? agentHosts : selection) {
    let path = hostConfigPath(host, env, home);
    if (host === "hermes" && !env.HERMES_HOME) {
      const selected = await readFile(join(dirname(path), "active_profile"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        return "invalid profile";
      });
      const profile = selected.trim();
      if (profile && profile !== "default") {
        if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
          results.push({ host, path, state: "failed", detail: "Could not resolve the active Hermes profile; settings left unchanged" });
          continue;
        }
        path = join(dirname(path), "profiles", profile, "config.yaml");
      }
    }
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const lockPath = `${path}.orbit-lock`;
    const temporary = `${path}.orbit-${crypto.randomUUID()}.tmp`;
    try {
      const before = await existingFile(path);
      if (selection === "auto" && before === null && !which(host)) {
        results.push({ host, path, state: "not-found", detail: "Host not detected; no settings written" });
        continue;
      }
      const proposed = addHostEntry(host, before ?? "", entry);
      if (!proposed.changed || options.dryRun) {
        results.push({ host, path, state: proposed.changed ? "planned" : "unchanged",
          detail: proposed.changed ? "Would add Orbit and preserve existing settings" : "Orbit is already configured" });
        continue;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      lock = await open(lockPath, "wx", 0o600);
      if (await existingFile(path) !== before) throw new Error("Configuration changed during registration; retry");
      const backup = before === null ? undefined : `${path}.orbit-backup-${crypto.randomUUID()}`;
      if (backup && before !== null) await writeFile(backup, before, { flag: "wx", mode: 0o600 });
      await writeFile(temporary, proposed.text, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      results.push({ host, path, state: "configured", detail: "Orbit configured; restart the host to load its tools", ...(backup ? { backup } : {}) });
    } catch (error) {
      // Parser errors can quote secrets from the configuration. Report the cause
      // without copying configuration text into an installation log.
      const detail = error instanceof Error && /^(An orbit entry|Configuration |Use --connect)/.test(error.message)
        ? error.message : "Could not safely read or update host settings; existing settings were retained";
      results.push({ host, path, state: "failed", detail });
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
    }
  }
  return results;
}
