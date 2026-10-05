import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const gtkKeys = new Set([
  "gtk-theme-name", "gtk-icon-theme-name", "gtk-font-name", "gtk-cursor-theme-name",
  "gtk-cursor-theme-size", "gtk-application-prefer-dark-theme", "gtk-xft-dpi",
  "gtk-xft-antialias", "gtk-xft-hinting", "gtk-xft-hintstyle", "gtk-xft-rgba",
]);
const kdeKeys: Record<string, ReadonlySet<string>> = {
  General: new Set(["ColorScheme", "ColorSchemeHash", "AccentColor", "font", "fixed", "menuFont", "smallestReadableFont", "toolBarFont", "XftAntialias", "XftHintStyle", "XftSubPixel"]),
  Icons: new Set(["Theme"]),
  KDE: new Set(["widgetStyle"]),
  WM: new Set(["activeBackground", "activeForeground", "activeBlend", "inactiveBackground", "inactiveForeground", "inactiveBlend", "frame", "inactiveFrame"]),
};
const colorKeys = new Set(["BackgroundNormal", "BackgroundAlternate", "ForegroundNormal", "ForegroundInactive", "ForegroundActive", "ForegroundLink", "ForegroundVisited", "ForegroundNegative", "ForegroundNeutral", "ForegroundPositive", "DecorationFocus", "DecorationHover"]);
const effectKeys = new Set(["Enable", "ChangeSelectionColor", "Color", "ColorAmount", "ColorEffect", "ContrastAmount", "ContrastEffect", "IntensityAmount", "IntensityEffect"]);
const colorGroups = /^(Colors:(View|Window|Button|Selection|Tooltip|Complementary|Header))$/;
const effectGroups = /^ColorEffects:(Disabled|Inactive)$/;
const settingsFiles = ["gtk-3.0/settings.ini", "gtk-4.0/settings.ini", "kdeglobals"] as const;
const colorSchemes = new Set(["default", "prefer-dark", "prefer-light"]);

/** Literal visual properties only. Never carry KConfig expansion or lockdown suffixes. */
export function filterNativeAppearance(text: string, toolkit: "gtk" | "kde"): string {
  const groups = new Map<string, Map<string, string>>();
  let group = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const heading = /^\[([^\]]+)\]\s*$/.exec(line);
    if (line.trimStart().startsWith("[")) { group = heading?.[1] ?? ""; continue; }
    const property = /^\s*([A-Za-z0-9_-]+)\s*=(.*)$/.exec(line);
    if (!property || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) continue;
    const key = property[1], value = property[2];
    if (key === undefined || value === undefined) continue;
    const allowed = toolkit === "gtk" ? (group === "Settings" ? gtkKeys : undefined)
      : colorGroups.test(group) ? colorKeys : effectGroups.test(group) ? effectKeys : Object.hasOwn(kdeKeys, group) ? kdeKeys[group] : undefined;
    if (!allowed?.has(key)) continue;
    let entries = groups.get(group);
    if (!entries) { entries = new Map(); groups.set(group, entries); }
    entries.set(key, value.trim());
  }
  return [...groups].map(([name, entries]) => `[${name}]\n${[...entries].map(([key, value]) => `${key}=${value}`).join("\n")}\n`).join("\n");
}

async function readSettings(path: string, privateSnapshot = false): Promise<string | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 1_000_000) throw new Error("Appearance source must be a bounded regular file");
    if (privateSnapshot && (before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600))
      throw new Error("Appearance snapshot must be an owned private unlinked regular file");
    const buffer = Buffer.alloc(1_000_001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > 1_000_000 || length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Appearance source changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/** Fixed owner snapshot only; these defaults never carry access to the owner's config tree. */
export async function loadNativeAppearance(source: string): Promise<Readonly<Record<string, string>>> {
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw new Error("Native appearance requires Linux");
  const privateDirectory = async (path: string) => {
    const info = await lstat(path);
    if (!isAbsolute(path) || await realpath(path) !== path || !info.isDirectory()
        || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw new Error("Appearance snapshot directory must be canonical, private and owned");
  };
  await privateDirectory(source);
  const configuration: Record<string, string> = {};
  for (const name of settingsFiles) {
    const parent = dirname(join(source, name));
    if (parent !== source) {
      try { await privateDirectory(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    }
    const text = await readSettings(join(source, name), true);
    if (text === undefined) continue;
    const filtered = filterNativeAppearance(text, name === "kdeglobals" ? "kde" : "gtk");
    if (filtered) configuration[name] = filtered;
  }
  const scheme = await readSettings(join(source, "color-scheme"), true);
  if (scheme !== undefined) {
    if (!colorSchemes.has(scheme)) throw new Error("Invalid native color preference");
    configuration["color-scheme"] = scheme;
  }
  if (Buffer.byteLength(JSON.stringify(configuration)) > 50_000)
    throw new Error("Appearance snapshot exceeds native launch configuration budget");
  return Object.freeze(configuration);
}

/** Preparation only: fresh private files, no environment changes or application launch. */
export async function stageNativeAppearance(source: string, parent: string, colorScheme?: string) {
  if (colorScheme !== undefined && !colorSchemes.has(colorScheme)) throw new Error("Invalid native color preference");
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw new Error("Native appearance staging requires Linux");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory()) throw new Error("Appearance source must be a directory, not a symlink");
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error("Appearance staging parent must be private and owned by this user");
  const directory = await mkdtemp(join(parent, "native-appearance-"));
  const copied: string[] = [], absent: string[] = [], empty: string[] = [];
  try {
    for (const name of settingsFiles) {
      const text = await readSettings(join(source, name));
      if (text === undefined) { absent.push(name); continue; }
      const filtered = filterNativeAppearance(text, name === "kdeglobals" ? "kde" : "gtk");
      if (!filtered) { empty.push(name); continue; }
      await mkdir(join(directory, dirname(name)), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, name), filtered, { flag: "wx", mode: 0o600 });
      copied.push(name);
    }
    if (colorScheme !== undefined) {
      await writeFile(join(directory, "color-scheme"), colorScheme, { flag: "wx", mode: 0o600 });
      copied.push("color-scheme");
    }
    return { directory, copied, absent, empty, themeMatch: "not measured" as const,
      pending: ["CSS and assets", "GSettings and portal color scheme", "native application visual comparison"] };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
