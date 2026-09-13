import { copyFile, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A private display gets private XDG base directories so no application restores the person's own
 * documents or session into the agent's workspace. That also strips the person's theme, so every
 * application opened there looks like a stranger's machine. This copies appearance only: theme,
 * icon, cursor and font settings for GTK, Qt and fontconfig, plus the file manager's sidebar
 * bookmarks, which are folder names rather than contents.
 *
 * Nothing here is a document, history, credential or cache. The list is fixed rather than a glob,
 * so a new file under ~/.config never rides along by accident.
 */
const files = [
  "gtk-3.0/settings.ini", "gtk-3.0/gtk.css", "gtk-3.0/bookmarks",
  "gtk-4.0/settings.ini", "gtk-4.0/gtk.css",
  "qt6ct/qt6ct.conf", "qt5ct/qt5ct.conf", "fontconfig/fonts.conf",
] as const;
// kdeglobals mixes appearance with file dialog state, recent files and the terminal command, so only
// these groups are carried over, and within General only colour and font keys.
const kdeGroups = /^(General|Icons|KDE|WM|Colors:.*|ColorEffects:.*)$/;
const kdeGeneralKeys = /^(ColorScheme|ColorSchemeHash|AccentColor|LastUsedCustomAccentColor|accentColorFromWallpaper|fixed|font|menuFont|smallestReadableFont|toolBarFont|XftAntialias|XftHintStyle|XftSubPixel)$/;
// What applications look up read-only from the person's data home: nothing that names a document,
// a handler or a program. Desktop entries and MIME associations stay out on purpose.
const sharedData = ["icons", "themes", "color-schemes"] as const;
const kdePlatformTheme = "/usr/lib64/qt6/plugins/platformthemes/KDEPlasmaPlatformTheme6.so";
const directories = ["qt6ct/colors", "qt5ct/colors", "qt5ct/qss", "Kvantum"] as const;
const settingLine = /^\s*([a-z-]+)\s*=\s*(.+?)\s*$/;

export interface Appearance { copied: string[]; env: Record<string, string>; cursor?: { theme: string; size: number } }
/** Environment the person's own shell may carry that must not decide how a session looks. */
export const inheritedAppearance = ["QT_QPA_PLATFORMTHEME", "QT_STYLE_OVERRIDE", "GTK_THEME", "XCURSOR_THEME", "XCURSOR_SIZE", "ADW_DEBUG_COLOR_SCHEME", "XDG_CONFIG_DIRS"] as const;

/** Keeps the appearance groups of a KDE settings file and drops everything else. */
export function filterKdeGlobals(text: string): string {
  const kept: string[] = [];
  let group = "";
  for (const line of text.split("\n")) {
    const heading = /^\[([^\]]+)\](\[[^\]]+\])?\s*$/.exec(line);
    if (heading) { group = kdeGroups.test(heading[1] ?? "") ? line.trim() : ""; if (group) kept.push(group); continue; }
    if (!group || !line.trim()) continue;
    const key = (line.split("=")[0] ?? "").trim().replace(/\[\$[a-z]\]$/, "");
    if (group === "[General]" && !kdeGeneralKeys.test(key)) continue;
    if (/^Recent /.test(key)) continue;
    kept.push(line);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}
export interface AppearanceSource { configHome?: string; dataHome?: string; cacheHome?: string; dataDirs?: string; kdePlatformTheme?: string }

async function copyTree(source: string, target: string, copied: string[], relative: string, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); } catch { return; }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = join(source, entry.name), to = join(target, entry.name), name = join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await copyTree(from, to, copied, name, depth + 1); continue; }
    if (!entry.isFile() || (await lstat(from)).size > 1_000_000) continue;
    await copyFile(from, to);
    copied.push(name);
  }
}

/** Reads the cursor theme and size from a GTK settings file, which is what sway's seat needs. */
function readCursor(text: string): { theme: string; size: number } | undefined {
  let theme: string | undefined, size = 24;
  for (const line of text.split("\n")) {
    const match = settingLine.exec(line);
    if (!match) continue;
    const [, name, value = ""] = match;
    if (name === "gtk-cursor-theme-name" && /^[A-Za-z0-9._-]+$/.test(value)) theme = value;
    if (name === "gtk-cursor-theme-size" && /^[1-9]\d{0,2}$/.test(value)) size = Number(value);
  }
  return theme ? { theme, size } : undefined;
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
  return value.replace(/[<>&"']/g, c => entities[c] ?? c);
}

function prefersDark(text: string): boolean {
  return /^\s*gtk-application-prefer-dark-theme\s*=\s*(1|true)\s*$/mi.test(text) || /^\s*gtk-theme-name\s*=.*dark/mi.test(text);
}

/**
 * Copies the person's appearance into a session's private configuration directory and returns the
 * environment that makes toolkits read it there. `source` defaults to the person's own
 * XDG_CONFIG_HOME; a session's directory must be private already.
 */
export async function applyAppearance(configHome: string, from: AppearanceSource = {}): Promise<Appearance> {
  const source = from.configHome ?? (process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
  const dataHome = from.dataHome ?? (process.env.XDG_DATA_HOME || join(homedir(), ".local/share"));
  const cacheHome = from.cacheHome ?? (process.env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  const copied: string[] = [];
  for (const file of files) {
    try {
      const from = join(source, file);
      const info = await lstat(from);
      if (!info.isFile() || info.size > 1_000_000) continue;
      await mkdir(join(configHome, dirname(file)), { recursive: true, mode: 0o700 });
      await copyFile(from, join(configHome, file));
      copied.push(file);
    } catch { continue; }
  }
  try {
    const info = await lstat(join(source, "kdeglobals"));
    if (info.isFile() && info.size <= 1_000_000) {
      const filtered = filterKdeGlobals(await readFile(join(source, "kdeglobals"), "utf8"));
      if (filtered) { await writeFile(join(configHome, "kdeglobals"), filtered, { mode: 0o600 }); copied.push("kdeglobals"); }
    }
  } catch {}
  for (const directory of directories) await copyTree(join(source, directory), join(configHome, directory), copied, directory);
  // A directory of links to the person's own icon sets, themes, fonts and colour schemes, listed on
  // XDG_DATA_DIRS so lookups find them while writes stay in the private data home. Desktop entries,
  // MIME associations and everything else under the data home are not linked.
  const links = join(configHome, "..", "shared-data");
  await mkdir(links, { recursive: true, mode: 0o700 });
  for (const name of sharedData) {
    try { if ((await lstat(join(dataHome, name))).isDirectory()) await symlink(join(dataHome, name), join(links, name)); } catch {}
  }
  // Fonts are the one thing that must be named by their real path. fontconfig keys its cache by
  // directory, so a link or a data-dirs entry under the session would make every session rescan
  // every font the person installed: measured at 3.9 seconds of compositor start for 2.4 GB of
  // fonts. A configuration fragment naming the real directory and the real cache costs nothing.
  try {
    const fonts = join(dataHome, "fonts"), cache = join(cacheHome, "fontconfig");
    if ((await lstat(fonts)).isDirectory()) {
      const fragment = join(configHome, "fontconfig/conf.d");
      await mkdir(fragment, { recursive: true, mode: 0o700 });
      const cacheLine = await lstat(cache).then(info => info.isDirectory() ? `  <cachedir>${escapeXml(cache)}</cachedir>\n` : "").catch(() => "");
      await writeFile(join(fragment, "10-orbit-person-fonts.conf"), `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${escapeXml(fonts)}</dir>\n${cacheLine}</fontconfig>\n`, { mode: 0o600 });
      copied.push("fontconfig/conf.d/10-orbit-person-fonts.conf");
    }
  } catch {}

  const env: Record<string, string> = {};
  let cursor: Appearance["cursor"];
  let dark = false;
  for (const file of ["gtk-3.0/settings.ini", "gtk-4.0/settings.ini"]) {
    if (!copied.includes(file)) continue;
    const text = await Bun.file(join(configHome, file)).text();
    cursor ??= readCursor(text);
    dark ||= prefersDark(text);
  }
  // The desktop delivers its colour scheme over the settings portal, which a private display has no
  // bus for. libadwaita reads this variable in its place; plain GTK reads settings.ini, copied above.
  if (dark) env.ADW_DEBUG_COLOR_SCHEME = "prefer-dark";
  // KDE applications read colours and fonts from kdeglobals through their own platform theme when
  // it is installed; everything else Qt goes through qt6ct.
  if (copied.includes("kdeglobals") && await Bun.file(from.kdePlatformTheme ?? kdePlatformTheme).exists()) env.QT_QPA_PLATFORMTHEME = "kde";
  else if (copied.includes("qt6ct/qt6ct.conf")) env.QT_QPA_PLATFORMTHEME = "qt6ct";
  const shared = (from.dataDirs ?? process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean);
  env.XDG_DATA_DIRS = [links, ...shared.filter(directory => directory !== dataHome && directory !== links)].join(":");
  if (cursor) { env.XCURSOR_THEME = cursor.theme; env.XCURSOR_SIZE = String(cursor.size); }
  return { copied, env, ...(cursor ? { cursor } : {}) };
}
