import { lstat, opendir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, win32, relative, resolve } from "node:path";
import { parseExec } from "./host-browsers";
import { OrbitError } from "./errors";

export type Application = {
  id: string; name: string; executable: string; packaging: "local" | "flatpak" | "bundle" | "registry" | "unknown";
  sources: string[]; runningPids: number[]; profileDirectories: string[];
  channel: "not measured" | "release" | "stable" | "beta" | "nightly"; channelSource?: string;
  version?: string; lastUsed?: string;
  flatpak?: FlatpakReference & { deploymentFiles: string };
  profileNames?: string[]; profileResolutionFailed?: boolean;
  availability?: "verified" | "unresolved";
  registrationIds?: string[];
};
export type FlatpakReference = { appId: string; branch?: string; architecture?: string; installation?: string };
export type DiscoveryOptions = {
  home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; query?: string;
  applicationDirectories?: string[]; bundleRoots?: string[]; procRoot?: string;
  registryEntries?: { id: string; executable: string }[]; includeRunning?: boolean;
  recentFile?: string;
  metadataProbe?: (reference: FlatpakReference) => Promise<string | undefined>;
};
const maxEntries = 4096;
export async function boundedApplicationEntries(root: string, limit = maxEntries, recursive = true, deadline = Infinity) {
  const entries: string[] = []; const pending = [""]; let scanned = 0;
  while (pending.length) {
    if (Date.now() >= deadline) return { entries, scanned, truncated: true };
    const directory = pending.pop(); if (directory === undefined) break;
    try {
      // Bun can defer directory errors until iteration, after opendir resolves.
      const handle = await opendir(join(root, directory));
      for await (const entry of handle) {
        if (scanned >= limit || Date.now() >= deadline) return { entries, scanned, truncated: true };
        scanned++;
        const path = join(directory, entry.name); entries.push(path);
        if (recursive && entry.isDirectory()) pending.push(path);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { entries, scanned, truncated: true };
    }
  }
  return { entries, scanned, truncated: false };
}
export function parseFlatpakReference(words: string[]): FlatpakReference | undefined {
  const run = words.indexOf("run"); if (run < 0) return;
  const reference: FlatpakReference = { appId: "" };
  for (let index = run + 1; index < words.length; index++) {
    const word = words[index]; if (!word) continue;
    if (word === "--user" || word === "--system") {
      if (reference.installation) return; reference.installation = word.slice(2); continue;
    }
    const key = /^(--branch|--arch|--installation)(?:=(.*))?$/.exec(word);
    if (key) {
      const value = key[2] ?? words[++index];
      if (!value || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) return;
      if (key[1] === "--branch") reference.branch = value;
      else if (key[1] === "--arch") reference.architecture = value;
      else { if (reference.installation) return; reference.installation = value; }
      continue;
    }
    if (word.startsWith("--")) {
      if (/^--(?:command|file-forwarding|filesystem|env|socket|device|share|talk-name|own-name)(?:=|$)/.test(word)) {
        if (!word.includes("=") && word !== "--file-forwarding") index++;
        continue;
      }
      return;
    }
    if (/^[A-Za-z][\w-]*(?:\.[\w-]+){2,}$/.test(word)) { reference.appId = word; return reference; }
    return;
  }
}
export function flatpakInfoArguments(reference: FlatpakReference): string[] {
  return ["info", "--show-location", ...(reference.architecture ? [`--arch=${reference.architecture}`] : []),
    ...(reference.installation === "user" || reference.installation === "system" ? [`--${reference.installation}`] :
      reference.installation ? [`--installation=${reference.installation}`] : []), reference.appId,
    ...(reference.branch ? [reference.branch] : [])];
}
async function runningFlatpak(path: string, roots: { root: string; installation: string }[]): Promise<Application["flatpak"] | undefined> {
  for (const root of roots) {
    const canonical = await realpath(root.root).catch(() => ""); if (!canonical) continue;
    const parts = relative(canonical, path).split("/");
    const [app, appId, architecture, branch, commit, files] = parts;
    if (app !== "app" || !appId || !architecture || !branch || !commit || files !== "files") continue;
    if (!/^[A-Za-z][\w-]*(?:\.[\w-]+){2,}$/.test(appId)) continue;
    return { appId, architecture, branch, installation: root.installation,
      deploymentFiles: join(canonical, app, appId, architecture, branch, commit, files) };
  }
}
async function smallFile(path: string, maximum = 65536): Promise<string | undefined> {
  try { const info = await stat(path); if (!info.isFile() || info.size > maximum) return;
    const text = await readFile(path, "utf8"); return Buffer.byteLength(text) <= maximum ? text : undefined;
  } catch { return; }
}
async function executablePath(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  try { const canonical = await realpath(path); const entry = await lstat(canonical);
    return entry.isFile() && (platform === "win32" || (entry.mode & 0o111)) ? canonical : undefined;
  } catch { return; }
}
async function resolveCommand(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  limits?: { deadline: number; incomplete: () => void }): Promise<string | undefined> {
  if (limits && Date.now() >= limits.deadline) { limits.incomplete(); return; }
  if (isAbsolute(command) || (platform === "win32" && win32.isAbsolute(command))) return executablePath(command, platform);
  if (command.includes("/") || command.includes("\\")) return;
  const path = env.PATH ?? "";
  const directories = path.slice(0, 65536).split(platform === "win32" ? ";" : ":");
  if (path.length > 65536 || directories.length > 128) limits?.incomplete();
  for (const directory of directories.slice(0, 128)) {
    if (limits && Date.now() >= limits.deadline) { limits.incomplete(); return; }
    if (!isAbsolute(directory) && !(platform === "win32" && win32.isAbsolute(directory))) continue;
    for (const suffix of platform === "win32" ? ["", ".exe", ".cmd"] : [""]) {
      const found = await executablePath(join(directory, command + suffix), platform); if (found) return found;
    }
  }
}
async function wrapperTarget(path: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  limits?: { deadline: number; incomplete: () => void }): Promise<string> {
  const text = await smallFile(path, 8192);
  if (!text?.startsWith("#!")) return path;
  const lines = text.split(/\r?\n/).slice(1).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  // Inspect a literal exec wrapper. Never evaluate assignments, substitutions or shell code.
  if (lines.length !== 1) return path;
  const line = lines[0];
  if (!line?.startsWith("exec ") || !line.endsWith(' "$@"')) return path;
  const words = validExec(line.slice(5, -5));
  if (!words) return path;
  const word = words[0];
  if (words.length !== 1 || !word || /[$`;|&<>]/.test(word)) return path;
  return await resolveCommand(word, env, platform, limits) ?? path;
}
function validExec(line: string): string[] | undefined {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote && character === "\\") { if (++index >= line.length) return; continue; }
    if (quote) { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === "\n" || character === "\r") return;
  }
  if (quote) return;
  return parseExec(line);
}
function desktopFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}; let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim(); if (value.startsWith("[")) { if (inside) break; inside = value === "[Desktop Entry]"; continue; }
    if (!inside || value.startsWith("#")) continue;
    const index = value.indexOf("="); if (index > 0) fields[value.slice(0, index)] = value.slice(index + 1);
  } return fields;
}
function xmlValue(text: string, key: string): string | undefined {
  const value = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
  return value?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
export function parseAppPaths(text: string, env: NodeJS.ProcessEnv): { id: string; executable: string }[] {
  const rows: { id: string; executable: string }[] = []; let id = "";
  for (const line of text.split(/\r?\n/)) {
    const key = /\\App Paths\\([^\\]+\.exe)\s*$/i.exec(line.trim());
    if (key?.[1]) { id = key[1]; continue; }
    const value = /^\s*\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line)?.[1];
    if (id && value) rows.push({ id, executable: value.trim().replace(/^"|"$/g, "").replace(/%([^%]+)%/g, (_, name: string) => env[name] ?? `%${name}%`) });
  } return rows;
}
async function registryRows(env: NodeJS.ProcessEnv): Promise<{ id: string; executable: string }[]> {
  const rows: { id: string; executable: string }[] = [];
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return rows;
  const registryExecutable = win32.join(systemRoot, "System32", "reg.exe");
  for (const root of ["HKCU", "HKLM"]) {
    try {
      const child = Bun.spawn([registryExecutable, "query", `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths`, "/s"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
      const text = await new Response(child.stdout).text(); if (await child.exited === 0 && text.length <= 1024 * 1024) rows.push(...parseAppPaths(text, env));
    } catch { /* Missing registry metadata is reported through the adapter coverage. */ }
  } return rows;
}
async function explicitProfiles(words: string[], cwd: () => Promise<string>): Promise<{ paths: string[]; names: string[]; failed: boolean }> {
  const paths = new Set<string>(); const names = new Set<string>(); let failed = false;
  for (const [index, word] of words.entries()) {
    if (word.toLowerCase() === "-p") {
      const name = words[index + 1]; if (!name || name.startsWith("-")) failed = true; else names.add(name);
    }
    const path = /^(?:--profile|--user-data-dir)=(.*)$/i.exec(word)?.[1] ??
      (["--profile", "-profile", "--user-data-dir"].includes(word.toLowerCase()) ? words[index + 1] : undefined);
    if (path) {
      try {
        const directory = isAbsolute(path) ? undefined : await cwd();
        if (directory !== undefined && !isAbsolute(directory)) throw new Error("Unavailable process working directory");
        const absolute = directory === undefined ? path : resolve(directory, path);
        paths.add(await realpath(absolute));
      } catch { failed = true; }
    } else if (/^(?:--profile|--user-data-dir)(?:=|$)/i.test(word) || word.toLowerCase() === "-profile") failed = true;
  } return { paths: [...paths], names: [...names], failed };
}

/** Metadata only: no app startup, screen capture, keyring or account content reads. */
export async function discoverApplications(options: DiscoveryOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const applications = new Map<string, Application>();
  const notes: string[] = []; let truncated = false;
  const deadline = Date.now() + 8000;
  const expired = () => { if (Date.now() < deadline) return false; truncated = true; return true; };
  const limits = { deadline, incomplete: () => { truncated = true; } };
  const add = async (id: string, name: string, path: string, packaging: Application["packaging"], source: string, pid?: number, profiles: string[] = [], lastUsed?: string, flatpak?: Application["flatpak"], profileNames: string[] = [], profileFailed = false) => {
    const executable = await executablePath(path, platform); if (!executable) return;
    if (options.query && !`${id} ${name} ${executable}`.toLowerCase().includes(options.query.toLowerCase())) return;
    const key = flatpak ? `${id}:${flatpak.deploymentFiles}` : platform === "win32" ? executable.toLowerCase() : executable;
    let app = applications.get(key);
    if (!app) { app = { id, name, executable, packaging, sources: [], runningPids: [], profileDirectories: [], channel: "not measured", availability: "verified" }; applications.set(key, app); }
    if (!app.sources.includes(source)) app.sources.push(source);
    if (source.startsWith("desktop:") && source.endsWith(".desktop")) {
      // The caller's id is the XDG registration id for local applications.
      if (!flatpak) { app.registrationIds ??= []; if (!app.registrationIds.includes(id)) app.registrationIds.push(id); }
    }
    if (pid !== undefined && !app.runningPids.includes(pid)) app.runningPids.push(pid);
    if (flatpak) app.flatpak = flatpak;
    if (pid !== undefined) app.executable = executable;
    for (const profile of profiles) if (!app.profileDirectories.includes(profile)) app.profileDirectories.push(profile);
    for (const name of profileNames) { app.profileNames ??= []; if (!app.profileNames.includes(name)) app.profileNames.push(name); }
    if (profileFailed) app.profileResolutionFailed = true;
    if (lastUsed && (!app.lastUsed || Date.parse(lastUsed) > Date.parse(app.lastUsed))) app.lastUsed = lastUsed;
    if (!app.version && /^(?:zen|zen-bin|firefox)$/.test(basename(executable))) {
      const ini = await smallFile(join(dirname(executable), "application.ini"));
      const version = ini && /^Version=([^\r\n]{1,80})$/m.exec(ini)?.[1];
      if (version) app.version = version;
      const channelSource = join(dirname(executable), "defaults/pref/channel-prefs.js");
      const prefs = await smallFile(channelSource);
      const channel = prefs && /^\s*pref\("app\.update\.channel",\s*"(release|stable|beta|nightly)"\)/m.exec(prefs)?.[1];
      if (channel === "release" || channel === "stable" || channel === "beta" || channel === "nightly") {
        app.channel = channel; app.channelSource = channelSource;
      }
    }
  };
  if (platform === "linux") {
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local/share");
    const userFlatpak = env.FLATPAK_USER_DIR && isAbsolute(env.FLATPAK_USER_DIR) ? env.FLATPAK_USER_DIR : join(data, "flatpak");
    const systemFlatpak = env.FLATPAK_SYSTEM_DIR && isAbsolute(env.FLATPAK_SYSTEM_DIR) ? env.FLATPAK_SYSTEM_DIR : "/var/lib/flatpak";
    const roots = options.applicationDirectories ?? [join(data, "applications"), join(userFlatpak, "exports/share/applications"),
      ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(isAbsolute).map(root => join(root, "applications")), join(systemFlatpak, "exports/share/applications")];
    const seen = new Set<string>();
    let remaining = maxEntries;
    for (const root of roots) {
      if (expired()) break;
      const scan = await boundedApplicationEntries(root, remaining, true, deadline); remaining -= scan.scanned;
      if (scan.truncated) truncated = true;
      for (const entry of scan.entries.sort()) {
        if (expired()) break;
        if (!entry.endsWith(".desktop")) continue;
        const id = entry.replaceAll("/", "-"); if (seen.has(id)) continue;
        const text = await smallFile(join(root, entry)); if (!text) continue; seen.add(id);
        const fields = desktopFields(text); if (fields.Type !== "Application" || fields.Hidden === "true" || !fields.Exec) continue;
        const words = validExec(fields.Exec); const first = words?.[0]; if (!first || !words) continue;
        const executable = await resolveCommand(first, env, platform, limits); if (!executable) continue;
        if (basename(executable) === "flatpak") {
          const metadataRunner = await executablePath("/usr/bin/flatpak", platform);
          if (!metadataRunner || metadataRunner !== executable) continue;
          // Registrations can outlive an uninstall. Resolve the deployed application before reporting it.
          const reference = parseFlatpakReference(words); if (!reference) continue;
          if (options.query && !`${reference.appId} ${fields.Name ?? ""} ${executable}`.toLowerCase().includes(options.query.toLowerCase())) continue;
          try {
            let location: string | undefined;
            if (options.metadataProbe) location = await options.metadataProbe(reference);
            else { const child = Bun.spawn([metadataRunner, ...flatpakInfoArguments(reference)], { stdout: "pipe", stderr: "ignore", timeout: Math.max(1, Math.min(2000, deadline - Date.now())) });
              const text = (await new Response(child.stdout).text()).trim(); if (await child.exited === 0) location = text; }
            if (!location || !isAbsolute(location)) continue;
            const deploymentFiles = await realpath(join(location, "files")).catch(() => "");
            if (!deploymentFiles || !(await stat(deploymentFiles)).isDirectory()) continue;
            await add(reference.appId, fields.Name ?? reference.appId, executable, "flatpak", `desktop:${join(root, entry)}`, undefined, [], undefined,
              { ...reference, deploymentFiles });
          } catch { continue; }
        } else {
          const target = await wrapperTarget(executable, env, platform, limits);
          await add(id, fields.Name ?? id, target, "local", `desktop:${join(root, entry)}`);
        }
      }
    }
    // XBEL application metadata is useful for moved archives. Document locations,
    // titles and full invocation arguments never enter the returned inventory.
    const recent = await smallFile(options.recentFile ?? join(data, "recently-used.xbel"), 1024 * 1024);
    for (const match of (recent ?? "").matchAll(/<(?:[\w-]+:)?application\s+([^>]+)\/?\s*>/g)) {
      if (expired()) break;
      const attributes = match[1] ?? "";
      const attribute = (key: string) => new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attributes)?.[1]
        ?.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
      const first = validExec(attribute("exec") ?? "")?.[0]; if (!first) continue;
      const executable = await resolveCommand(first, env, platform, limits); if (!executable) continue;
      const modified = attribute("modified");
      await add(basename(executable), attribute("name") ?? basename(executable), await wrapperTarget(executable, env, platform, limits),
        "local", "recent-application-metadata", undefined, [], modified && Number.isFinite(Date.parse(modified)) ? modified : undefined);
    }
    if (options.includeRunning !== false) {
      const proc = options.procRoot ?? "/proc"; let pids: string[] = [];
      try { await stat(proc); const scan = await boundedApplicationEntries(proc, maxEntries, false, deadline);
        pids = scan.entries.filter(name => /^\d+$/.test(name)); if (scan.truncated) truncated = true;
      } catch { notes.push("Current-user process metadata is unavailable"); }
      for (const pid of pids) {
        if (expired()) break;
        try {
          if ((await stat(join(proc, pid))).uid !== process.getuid?.()) continue;
          const executable = await readlink(join(proc, pid, "exe")); if (!isAbsolute(executable) || executable.endsWith(" (deleted)")) continue;
          const name = basename(executable);
          if (!await executablePath(executable, platform)) {
            if (!options.query || `${name} ${executable}`.toLowerCase().includes(options.query.toLowerCase())) {
              const key = `unresolved:${executable}`;
              const existing = applications.get(key);
              if (existing) existing.runningPids.push(Number(pid));
              else applications.set(key, { id: name, name, executable, packaging: "unknown", availability: "unresolved",
                sources: ["current-user-process-namespace"], runningPids: [Number(pid)], profileDirectories: [], channel: "not measured" });
            }
            continue;
          }
          // Profile flags are inspected only for supported browser families, never emitted as raw argv.
          const words = /^(?:zen|zen-bin|firefox|chrome|chromium(?:-browser)?)$/.test(name)
            ? (await smallFile(join(proc, pid, "cmdline")))?.split("\0") ?? [] : [];
          const registered = [...applications.values()].find(app => app.flatpak && executable.startsWith(app.flatpak.deploymentFiles + "/"))?.flatpak;
          const flatpak = registered ?? await runningFlatpak(executable, [{ root: userFlatpak, installation: "user" }, { root: systemFlatpak, installation: "system" }]);
          const unresolvedFlatpak = !flatpak && /\/app\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/files\//.test(executable);
          const profiles = await explicitProfiles(words, () => readlink(join(proc, pid, "cwd")));
          await add(flatpak?.appId ?? name, name, executable, flatpak ? "flatpak" : unresolvedFlatpak ? "unknown" : "local", "current-user-process", Number(pid), profiles.paths, undefined, flatpak, profiles.names, profiles.failed);
        } catch { /* A process may exit or refuse inspection during the snapshot. */ }
      }
    }
    for (const name of ["zen", "zen-browser", "code", "codex", "google-chrome", "chromium", "firefox"]) {
      if (expired()) break;
      const executable = await resolveCommand(name, env, platform, limits); if (executable) await add(name, name, await wrapperTarget(executable, env, platform, limits), "local", "PATH");
    }
    notes.push("Linux desktop entries, supported PATH names, current-user processes and available XBEL application metadata are inspected. Recent usage is not active profile evidence; Flatpak profile identity is not inferred.");
  } else if (platform === "darwin") {
    for (const root of options.bundleRoots ?? ["/Applications", posix.join(home, "Applications")]) {
      const scan = await boundedApplicationEntries(root, maxEntries, false, deadline); if (scan.truncated) truncated = true;
      for (const entry of scan.entries.sort()) {
        if (expired()) break;
        if (!entry.endsWith(".app")) continue;
        const bundle = join(root, entry); const plist = await smallFile(join(bundle, "Contents/Info.plist")); if (!plist) continue;
        let binary = xmlValue(plist, "CFBundleExecutable"); let id = xmlValue(plist, "CFBundleIdentifier");
        if (!binary && process.platform === "darwin") {
          try { const child = Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
            const info = JSON.parse(await new Response(child.stdout).text()); if (await child.exited === 0) { binary = info.CFBundleExecutable; id = info.CFBundleIdentifier; }
          } catch { continue; }
        }
        if (typeof binary !== "string" || !binary || binary.includes("/") || binary.includes("\0") || binary === "..") continue;
        await add(typeof id === "string" ? id : entry, entry.slice(0, -4), join(bundle, "Contents/MacOS", binary), "bundle", `bundle:${bundle}`);
      }
    }
    notes.push("macOS bundle metadata only. Running process, profile and native private display support are not measured here.");
  } else if (platform === "win32") {
    const seen = new Set<string>();
    for (const entry of options.registryEntries ?? await registryRows(env)) {
      if (seen.has(entry.id.toLowerCase())) continue; seen.add(entry.id.toLowerCase());
      await add(entry.id, entry.id, entry.executable, "registry", "App Paths");
    }
    notes.push("Windows App Paths metadata only. Localized registry labels, running processes, profiles and native private display support are not measured here.");
  } else notes.push("Application discovery has no adapter for this platform");
  expired();
  const found = [...applications.values()].sort((a, b) => Number(b.runningPids.length > 0) - Number(a.runningPids.length > 0) || a.name.localeCompare(b.name) || a.executable.localeCompare(b.executable));
  return { platform, scope: "current-user", applications: found, truncated, notes };
}

export function selectApplication(applications: Application[], name: string): Application {
  const matches = applications.filter(app => basename(app.executable).replace(/\.exe$/i, "").replace(/-bin$/, "") === name);
  if (matches.some(app => app.runningPids.length && app.availability === "unresolved"))
    throw new OrbitError("UNSUPPORTED", `${name} running executable identity is unresolved`);
  const running = matches.filter(app => app.runningPids.length > 0);
  const choices = running.length ? running : matches;
  if (choices.length !== 1) throw new OrbitError("UNSUPPORTED", choices.length ? `${name} installation is ambiguous; choose or close conflicting installations` : `No verified ${name} executable was discovered`);
  const selected = choices[0]; if (!selected) throw new OrbitError("UNSUPPORTED", "Application discovery returned no selection");
  return selected;
}
