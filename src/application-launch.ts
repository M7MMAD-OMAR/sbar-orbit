import { open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { boundedApplicationEntries, type DiscoveryOptions } from "./application-discovery";
import { OrbitError } from "./errors";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

// Desktop Entry string decoding precedes the separate Exec quoting rules.
function desktopString(value: string): string {
  const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") { result += character; continue; }
    const next = value[++index];
    const decoded = next === undefined ? undefined : escapes[next];
    if (decoded === undefined) refuse("Unsupported desktop string escape");
    result += decoded;
  }
  return result;
}

// A deliberately bounded Desktop Entry grammar. No shell is evaluated.
function words(value: string): string[] {
  const result: string[] = []; let current = "", quoted = false, started = false, closedQuote = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === undefined) break;
    if (closedQuote && char !== " ") refuse("Unsupported desktop Exec quote concatenation");
    if (char === '"') {
      if (!quoted && started) refuse("Unsupported desktop Exec quote concatenation");
      if (quoted && current.includes("%")) refuse("Desktop field codes inside quoted arguments are undefined");
      closedQuote = quoted; quoted = !quoted; started = true; continue;
    }
    if (char === "\\") {
      if (!quoted) refuse("Unquoted desktop Exec escape is unsupported");
      const next = value[++i];
      if (next === undefined || !['"', "\\", "$", "`"].includes(next)) refuse("Unsupported desktop Exec escape");
      current += next; started = true; continue;
    }
    if (/[\r\n\0]/.test(char) || (!quoted && char === "\t") || /[$`;|&<>']/.test(char)) refuse("Unsupported desktop Exec expression");
    if (!quoted && /[~*?#()]/.test(char)) refuse("Unquoted desktop Exec reserved character");
    if (!quoted && char === " ") { if (started) result.push(current); current = ""; started = false; closedQuote = false; }
    else { current += char; started = true; }
  }
  if (quoted) refuse("Unterminated desktop Exec quote");
  if (started) result.push(current);
  return result;
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const searchPath = (env.PATH ?? "").split(":");
  if (!isAbsolute(command) && searchPath.some(path => !isAbsolute(path)))
    refuse("Application PATH contains relative or empty entries; refusing a different installation");
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [] :
    searchPath.map(path => join(path, command));
  if (candidates.length > 128) refuse("Application PATH discovery is incomplete");
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical) continue;
    const entry = await stat(canonical).catch(() => undefined);
    // The invoked alias can select a program mode. Canonical identity is only for validation.
    if (entry?.isFile() && entry.mode & 0o111) return candidate;
  }
  return refuse("Registered application executable is unavailable");
}

async function preparedExecutable(path: string, home: string, env: NodeJS.ProcessEnv, visited = new Set<string>()): Promise<string> {
  const identity = await realpath(path);
  if (visited.has(identity) || visited.size >= 8) refuse("Application wrapper chain is cyclic or too deep");
  visited.add(identity);
  const handle = await open(path, "r");
  let content: string, exceedsLimit: boolean;
  try {
    const bytes = Buffer.alloc(8193);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    content = bytes.subarray(0, result.bytesRead).toString();
    exceedsLimit = result.bytesRead > 8192 || (await handle.stat()).size > 8192;
  }
  finally { await handle.close(); }
  if (!content.startsWith("#!")) return path;
  if (content.includes("\r")) refuse("Application wrapper carriage returns are unsupported");
  if (exceedsLimit) refuse("Application wrapper exceeds supported size");
  const lines = content.split(/\r?\n/); const interpreter = lines.shift() ?? "";
  if (!/^#![ \t]*\/(?:usr\/)?bin\/(?:ba|da)?sh[ \t]*$/.test(interpreter))
    refuse("Application script requires an unsupported interpreter launch recipe");
  const statements = lines.map(line => line.replace(/^[ \t]+|[ \t]+$/g, "")).filter(line => line && !line.startsWith("#"));
  if (statements.length !== 1) refuse("Application shell wrapper requires an explicit supported launch recipe");
  const match = /^exec (?:"([^"\r\n]+)"|([^\s"']+)) "\$@"$/.exec(statements[0] ?? "");
  if (!match) refuse("Application shell wrapper requires an explicit supported launch recipe");
  let target = match?.[1] ?? match?.[2] ?? "";
  if ((!match?.[1] && !/^[A-Za-z0-9_./:+-]+$/.test(target)) || target.startsWith("-"))
    refuse("Unsupported application wrapper expression");
  if (target.startsWith("$HOME/") && match?.[1]) target = home + target.slice(5);
  if (/[$`\\;|&<>\0]/.test(target)) refuse("Unsupported application wrapper expression");
  return preparedExecutable(await executable(target, env), home, env, visited);
}

/** Resolve an exact registered desktop ID, never an existing-window attachment. */
export async function resolveInstalledApplication(applicationId: string, options: DiscoveryOptions = {}): Promise<{ argv: string[]; cwd?: string; applicationId: string }> {
  if ((options.platform ?? process.platform) !== "linux") refuse("Registered application launch has no adapter for this platform");
  if (!/^[^/\\\0\r\n]+\.desktop$/.test(applicationId) || applicationId.length > 1024)
    throw new OrbitError("INVALID_REQUEST", "Choose an exact registered .desktop application ID");
  const env = options.env ?? process.env; const home = options.home ?? env.HOME ?? homedir();
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local/share");
  const roots = options.applicationDirectories ?? [join(data, "applications"),
    join(env.FLATPAK_USER_DIR ?? join(data, "flatpak"), "exports/share/applications"),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(isAbsolute).map(root => join(root, "applications")),
    join(env.FLATPAK_SYSTEM_DIR ?? "/var/lib/flatpak", "exports/share/applications")];
  let remaining = 4096; const deadline = Date.now() + 8000; let registration: string | undefined;
  for (const root of roots) {
    const scan = await boundedApplicationEntries(root, remaining, true, deadline); remaining -= scan.scanned;
    if (scan.truncated || Date.now() >= deadline) refuse("Application registration discovery is incomplete");
    const matches = scan.entries.filter(entry => entry.replaceAll("/", "-") === applicationId);
    if (matches.length > 1) refuse("Application registration identity is ambiguous");
    if (matches[0]) { registration = join(root, matches[0]); break; }
  }
  if (!registration) return refuse("No exact application registration was discovered");
  const metadata = await stat(registration);
  if (!metadata.isFile() || metadata.size > 65536) refuse("Application registration is unavailable or too large");
  const fields: Record<string, string> = {}; let inside = false;
  for (const line of (await readFile(registration, "utf8")).split(/\r?\n/)) {
    const value = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (value.startsWith("[")) { if (inside) break; inside = value === "[Desktop Entry]"; continue; }
    if (!inside || !value || value.startsWith("#")) continue;
    const separator = value.indexOf("="); if (separator < 1) continue;
    const key = value.slice(0, separator);
    if (key in fields) refuse("Application registration contains duplicate keys");
    const raw = value.slice(separator + 1);
    fields[key] = ["Exec", "Name", "Icon", "Path", "TryExec"].includes(key) ? desktopString(raw) : raw;
  }
  if (fields.Type !== "Application" || fields.Hidden === "true" || !fields.Exec) refuse("Application registration is disabled or has no Exec recipe");
  // Use the validated Exec compatibility recipe, including for D-Bus activatable applications.
  // The private desktop launches it directly on its own bus; never activate it on the owner's bus.
  if (fields.Terminal === "true" || fields["X-Flatpak"])
    refuse("Application registration needs an unsupported activation adapter");
  const exec = fields.Exec;
  if (exec === undefined) return refuse("Application registration has no Exec recipe");
  const args = words(exec); const command = args.shift();
  if (!command || command.includes("%")) return refuse("Application registration has no literal executable");
  const path = await executable(command, env);
  const unsupportedCommands = ["env", "flatpak", "sh", "bash", "dash"];
  if ([basename(path), basename(await realpath(path))].some(name => unsupportedCommands.includes(name)))
    refuse("Application registration needs an unsupported command adapter");
  if (fields.TryExec) await executable(fields.TryExec, env);
  const resolved = await preparedExecutable(path, home, env);
  if ([basename(resolved), basename(await realpath(resolved))].some(name => unsupportedCommands.includes(name)))
    refuse("Application wrapper needs an unsupported command adapter");
  const argv = [resolved];
  for (const arg of args) {
    if (/^%[fFuU]$/.test(arg)) continue;
    if (arg === "%c") { argv.push(fields.Name ?? applicationId); continue; }
    if (arg === "%k") { argv.push(registration); continue; }
    if (arg === "%i") { if (fields.Icon) argv.push("--icon", fields.Icon); continue; }
    if (/%(?!%)/.test(arg.replaceAll("%%", ""))) refuse("Unsupported desktop Exec field code");
    argv.push(arg.replaceAll("%%", "%"));
  }
  // Validate the final arguments, including values introduced by field codes.
  for (const arg of argv.slice(1)) {
    if (/^(?:--?profile|--profile-directory|--user-data-dir)(?:=|$)/i.test(arg) || /^-P(?:$|[^a-z])/.test(arg))
      refuse("Registered profile selection requires a separate supported state adapter");
  }
  let cwd: string | undefined;
  if (fields.Path) {
    if (!isAbsolute(fields.Path) || /[$`\0]/.test(fields.Path)) refuse("Application working directory must be literal and absolute");
    cwd = await realpath(fields.Path).catch(() => undefined);
    if (!cwd || !(await stat(cwd)).isDirectory()) refuse("Application working directory is unavailable");
  }
  if (argv.length > 128 || argv.some(arg => arg.length > 4096)) refuse("Application launch recipe exceeds argument limits");
  return { argv, ...(cwd ? { cwd } : {}), applicationId };
}
