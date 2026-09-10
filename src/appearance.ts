import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
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
  "qt6ct/qt6ct.conf", "qt5ct/qt5ct.conf", "fontconfig/fonts.conf", "Kvantum/kvantum.kvconfig",
] as const;
const directories = ["qt6ct/colors", "qt5ct/colors", "qt5ct/qss", "Kvantum"] as const;
const settingLine = /^\s*([a-z-]+)\s*=\s*(.+?)\s*$/;

export interface Appearance { copied: string[]; env: Record<string, string>; cursor?: { theme: string; size: number } }

async function copyTree(source: string, target: string, copied: string[], relative: string, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); } catch { return; }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = join(source, entry.name), to = join(target, entry.name), name = join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await copyTree(from, to, copied, name, depth + 1); continue; }
    if (!entry.isFile() || (await stat(from)).size > 1_000_000) continue;
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
    if (match[1] === "gtk-cursor-theme-name" && /^[A-Za-z0-9._-]+$/.test(match[2]!)) theme = match[2];
    if (match[1] === "gtk-cursor-theme-size" && /^\d{1,3}$/.test(match[2]!)) size = Number(match[2]);
  }
  return theme ? { theme, size } : undefined;
}

function prefersDark(text: string): boolean {
  return /^\s*gtk-application-prefer-dark-theme\s*=\s*(1|true)\s*$/mi.test(text) || /^\s*gtk-theme-name\s*=.*dark/mi.test(text);
}

/**
 * Copies the person's appearance into a session's private configuration directory and returns the
 * environment that makes toolkits read it there. `source` defaults to the person's own
 * XDG_CONFIG_HOME; a session's directory must be private already.
 */
export async function applyAppearance(configHome: string, source = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")): Promise<Appearance> {
  const copied: string[] = [];
  for (const file of files) {
    try {
      const from = join(source, file);
      if ((await stat(from)).size > 1_000_000) continue;
      await mkdir(join(configHome, dirname(file)), { recursive: true, mode: 0o700 });
      await copyFile(from, join(configHome, file));
      copied.push(file);
    } catch { continue; }
  }
  for (const directory of directories) await copyTree(join(source, directory), join(configHome, directory), copied, directory);

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
  // bus for. libadwaita and GTK 4 read this variable in its place, so dark stays dark.
  if (dark) env.ADW_DEBUG_COLOR_SCHEME = "prefer-dark";
  if (copied.includes("qt6ct/qt6ct.conf")) env.QT_QPA_PLATFORMTHEME = "qt6ct";
  if (cursor) { env.XCURSOR_THEME = cursor.theme; env.XCURSOR_SIZE = String(cursor.size); }
  return { copied, env, ...(cursor ? { cursor } : {}) };
}
