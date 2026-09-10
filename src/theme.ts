import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The viewer paints from Material 3 colour roles so a desktop that already generates them can hand
 * its palette over and the workspace stops looking like a foreign application. A theme file is
 * observed content: it is read for a fixed set of keys and every value is checked before it reaches
 * CSS, because the viewer origin holds a session access token.
 */
const roles = [
  "surface", "surface_container_lowest", "surface_container_low", "surface_container",
  "surface_container_high", "surface_container_highest", "surface_variant",
  "on_surface", "on_surface_variant", "outline", "outline_variant",
  "primary", "on_primary", "primary_container", "on_primary_container",
  "secondary_container", "on_secondary_container", "tertiary", "tertiary_container",
  "on_tertiary_container", "error", "on_error", "error_container", "on_error_container",
] as const;

const families = { main: "--font-main", monospace: "--font-mono" } as const;
const colour = /^#[0-9a-fA-F]{3,8}$/;
const family = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/;

/** Where a palette is looked for, in order, when the environment names no file. */
export function themeCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const state = env.XDG_STATE_HOME || join(home, ".local/state");
  if (env.ORBIT_THEME) return [env.ORBIT_THEME];
  return [
    join(config, "sbar-orbit/theme.json"),
    join(state, "quickshell/user/generated/colors.json"),
    join(config, "matugen/colors.json"),
  ];
}

/** A dark surface asks browsers for dark form controls and scrollbars. */
function isDark(hex: string): boolean {
  const value = hex.slice(1);
  const digits = value.length < 6 ? value.slice(0, 3).split("").map(c => c + c).join("") : value.slice(0, 6);
  const channel = (at: number) => {
    const part = Number.parseInt(digits.slice(at, at + 2), 16) / 255;
    return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4) < 0.4;
}

/**
 * Accepts either a flat Material You colour map, which is what matugen and quickshell write, or an
 * Orbit theme file with `colors` and `fonts` objects. Unknown keys and malformed values are dropped
 * rather than rejected, so a palette gaining new roles does not break the viewer.
 */
export function themeCss(source: unknown): string {
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  const file = source as Record<string, unknown>;
  const nested = file.colors && typeof file.colors === "object" && !Array.isArray(file.colors);
  const colours = (nested ? file.colors : file) as Record<string, unknown>;
  const fonts = (file.fonts && typeof file.fonts === "object" ? file.fonts : {}) as Record<string, unknown>;

  const declarations: string[] = [];
  for (const role of roles) {
    const value = colours[role];
    if (typeof value === "string" && colour.test(value)) declarations.push(`--${role.replaceAll("_", "-")}:${value}`);
  }
  for (const [key, token] of Object.entries(families)) {
    const value = fonts[key];
    if (typeof value !== "string" || !family.test(value)) continue;
    declarations.push(`${token}:"${value}",${key === "monospace" ? "ui-monospace,monospace" : "system-ui,sans-serif"}`);
  }
  if (!declarations.length) return "";

  const surface = colours.surface;
  if (typeof surface === "string" && colour.test(surface)) declarations.push(`color-scheme:${isDark(surface) ? "dark" : "light"}`);
  return `:root{${declarations.join(";")}}\n`;
}

/**
 * Merges every readable candidate, later files winning, so a desktop that regenerates its palette
 * from the wallpaper keeps supplying colours while a hand written theme file adds fonts or overrides
 * single roles. A missing or unusable file leaves the shipped palette in place.
 */
export async function loadTheme(env: Record<string, string | undefined> = process.env): Promise<string> {
  const colors: Record<string, unknown> = {}, fonts: Record<string, unknown> = {};
  for (const path of themeCandidates(env).reverse()) {
    let file: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      file = parsed as Record<string, unknown>;
    } catch { continue; }
    const nested = file.colors && typeof file.colors === "object" && !Array.isArray(file.colors);
    Object.assign(colors, nested ? file.colors : file);
    if (file.fonts && typeof file.fonts === "object") Object.assign(fonts, file.fonts);
  }
  return themeCss({ colors, fonts });
}
