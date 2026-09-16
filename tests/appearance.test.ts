import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the GTK, Qt and Kvantum theming of the person's own desktop");
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAppearance, filterKdeGlobals } from "../src/appearance";
import { tmpdir } from "node:os";

async function fixtureHome() {
  const source = await mkdtemp(join(tmpdir(), "orbit-appearance-source-"));
  await mkdir(join(source, "gtk-3.0"), { recursive: true });
  await mkdir(join(source, "gtk-4.0"), { recursive: true });
  await mkdir(join(source, "qt6ct/colors"), { recursive: true });
  await mkdir(join(source, "Kvantum/Colloid"), { recursive: true });
  await writeFile(join(source, "gtk-3.0/settings.ini"), "[Settings]\ngtk-theme-name=adw-gtk3-dark\ngtk-cursor-theme-name=Bibata-Modern-Classic\ngtk-cursor-theme-size=24\ngtk-application-prefer-dark-theme=1\n");
  await writeFile(join(source, "gtk-3.0/bookmarks"), "file:///tmp/orbit-example/Projects Projects\n");
  await writeFile(join(source, "gtk-4.0/settings.ini"), "[Settings]\ngtk-theme-name=adw-gtk3-dark\n");
  await writeFile(join(source, "gtk-4.0/gtk.css"), "window { color: red; }\n");
  await writeFile(join(source, "qt6ct/qt6ct.conf"), "[Appearance]\nstyle=kvantum-dark\n");
  await writeFile(join(source, "qt6ct/colors/Mocha.conf"), "[ColorScheme]\n");
  await writeFile(join(source, "Kvantum/kvantum.kvconfig"), "[General]\ntheme=Colloid\n");
  await writeFile(join(source, "Kvantum/Colloid/Colloid.kvconfig"), "[%General]\n");
  // Things that must never travel: documents, history, credentials, caches, symlinks out of the tree.
  await mkdir(join(source, "gnome-text-editor"), { recursive: true });
  await writeFile(join(source, "gnome-text-editor/session.gvariant"), "recent documents");
  await writeFile(join(source, "secret-token.json"), "{\"token\":\"never\"}");
  await mkdir(join(source, "google-chrome"), { recursive: true });
  await writeFile(join(source, "google-chrome/Local State"), "{}");
  await symlink("/etc/hostname", join(source, "qt6ct/colors/link.conf"));
  await writeFile(join(source, "gtk-3.0/servers"), "sibling inside a listed directory");
  await mkdir(join(source, "qt5ct"), { recursive: true });
  await symlink("/etc/hostname", join(source, "qt5ct/qt5ct.conf"));
  await mkdir(join(source, "Kvantum/a/b/c/d"), { recursive: true });
  await writeFile(join(source, "Kvantum/a/b/c/d/deep.kvconfig"), "deeper than the tree copy goes");
  await writeFile(join(source, "Kvantum/large.kvconfig"), "x".repeat(1_000_001));
  await writeFile(join(source, "kdeglobals"), "[General]\nColorScheme=Dark\nTerminalApplication=kitty\n[KFileDialog Settings]\nRecent Files[$e]=/tmp/orbit-example/secret.pdf\n[Colors:Window]\nBackgroundNormal=1,2,3\n");
  return source;
}

async function tree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await tree(join(root, entry.name), name)); else out.push(name);
  }
  return out.sort();
}

test("appearance copies theme settings and nothing else", async () => {
  const source = await fixtureHome();
  const target = await mkdtemp(join(tmpdir(), "orbit-appearance-target-"));
  const result = await applyAppearance(target, { configHome: source, dataHome: "/tmp/orbit-data-fixture", dataDirs: "/usr/share" });
  const copied = await tree(target);
  expect(copied).toEqual([
    "Kvantum/Colloid/Colloid.kvconfig", "Kvantum/kvantum.kvconfig",
    "gtk-3.0/bookmarks", "gtk-3.0/settings.ini", "gtk-4.0/gtk.css", "gtk-4.0/settings.ini",
    "kdeglobals", "qt6ct/colors/Mocha.conf", "qt6ct/qt6ct.conf",
  ]);
  expect(result.copied.sort()).toEqual(copied);
  const kde = await Bun.file(join(target, "kdeglobals")).text();
  expect(kde).toContain("ColorScheme=Dark");
  expect(kde).toContain("[Colors:Window]");
  expect(kde).not.toMatch(/TerminalApplication|Recent Files|secret|KFileDialog/);
});

test("a dark GTK theme becomes the colour scheme libadwaita reads without a portal", async () => {
  const source = await fixtureHome();
  const target = await mkdtemp(join(tmpdir(), "orbit-appearance-target-"));
  const { env, cursor } = await applyAppearance(target, { configHome: source, dataHome: "/tmp/orbit-data-fixture", dataDirs: "/usr/local/share:/usr/share", kdePlatformTheme: "/nonexistent/kde.so" });
  expect(env).toMatchObject({ ADW_DEBUG_COLOR_SCHEME: "prefer-dark", QT_QPA_PLATFORMTHEME: "qt6ct", XCURSOR_THEME: "Bibata-Modern-Classic", XCURSOR_SIZE: "24",
    XDG_DATA_DIRS: `${join(target, "..", "shared-data")}:/usr/local/share:/usr/share` });
  expect(cursor).toEqual({ theme: "Bibata-Modern-Classic", size: 24 });
});

test("a person with no theme configuration gets an untouched session", async () => {
  const source = await mkdtemp(join(tmpdir(), "orbit-appearance-empty-"));
  const target = await mkdtemp(join(tmpdir(), "orbit-appearance-target-"));
  const result = await applyAppearance(target, { configHome: source, dataHome: "/tmp/orbit-data-fixture", dataDirs: "/usr/share" });
  expect(result).toEqual({ copied: [], env: { XDG_DATA_DIRS: `${join(target, "..", "shared-data")}:/usr/share` } });
  expect(await tree(target)).toEqual([]);
});

test("a cursor name that is not a plain identifier is not passed to the compositor", async () => {
  const source = await mkdtemp(join(tmpdir(), "orbit-appearance-odd-"));
  await mkdir(join(source, "gtk-3.0"), { recursive: true });
  await writeFile(join(source, "gtk-3.0/settings.ini"), "[Settings]\ngtk-cursor-theme-name=Bad Name; exec x\ngtk-cursor-theme-size=9999\n");
  const target = await mkdtemp(join(tmpdir(), "orbit-appearance-target-"));
  const { env, cursor } = await applyAppearance(target, { configHome: source, dataHome: "/tmp/orbit-data-fixture", dataDirs: "/usr/share" });
  expect(cursor).toBeUndefined();
  expect(env.XCURSOR_THEME).toBeUndefined();
});

test("KDE applications get their own platform theme only when it is installed", async () => {
  const source = await mkdtemp(join(tmpdir(), "orbit-appearance-kde-"));
  await writeFile(join(source, "kdeglobals"), "[General]\nColorScheme=MaterialYouDark\n");
  const plugin = join(source, "KDEPlasmaPlatformTheme6.so");
  await writeFile(plugin, "");
  const first = await mkdtemp(join(tmpdir(), "orbit-appearance-target-")), second = await mkdtemp(join(tmpdir(), "orbit-appearance-target-"));
  expect((await applyAppearance(first, { configHome: source, dataHome: "/tmp/d", dataDirs: "/usr/share", kdePlatformTheme: plugin })).env.QT_QPA_PLATFORMTHEME).toBe("kde");
  expect((await applyAppearance(second, { configHome: source, dataHome: "/tmp/d", dataDirs: "/usr/share", kdePlatformTheme: join(source, "absent.so") })).env.QT_QPA_PLATFORMTHEME).toBeUndefined();
});

test("only icon, theme, font and colour scheme directories from the data home are shared", async () => {
  const source = await mkdtemp(join(tmpdir(), "orbit-appearance-empty-"));
  const dataHome = await mkdtemp(join(tmpdir(), "orbit-appearance-data-"));
  for (const name of ["icons", "themes", "fonts", "color-schemes", "applications", "Trash", "gvfs-metadata", "recently-used.xbel"]) await mkdir(join(dataHome, name), { recursive: true });
  const session = await mkdtemp(join(tmpdir(), "orbit-appearance-session-"));
  const target = join(session, "config");
  await mkdir(target);
  const { env } = await applyAppearance(target, { configHome: source, dataHome, dataDirs: `/usr/share:${dataHome}` });
  const links = (await readdir(join(session, "shared-data"))).sort();
  expect(links).toEqual(["color-schemes", "icons", "themes"]);
  expect(env.XDG_DATA_DIRS).toBe(`${join(session, "shared-data")}:/usr/share`);
  // Fonts are named by their real path in a fontconfig fragment, never linked or listed.
  const fragment = await Bun.file(join(target, "fontconfig/conf.d/10-orbit-person-fonts.conf")).text();
  expect(fragment).toContain(`<dir>${join(dataHome, "fonts")}</dir>`);
  expect(fragment).not.toContain("shared-data");
});

test("KDE settings keep appearance groups and drop dialog state and recent files", () => {
  const text = "[General]\nColorScheme=X\nfont=Sans,10\nTerminalApplication=kitty\nRecent Files[$e]=/tmp/orbit-example/a.pdf\n[KFileDialog Settings]\nShow hidden files=true\n[Icons]\nTheme=breeze\n[Colors:View]\nBackgroundNormal=1,2,3\n";
  expect(filterKdeGlobals(text)).toBe("[General]\nColorScheme=X\nfont=Sans,10\n[Icons]\nTheme=breeze\n[Colors:View]\nBackgroundNormal=1,2,3\n");
  expect(filterKdeGlobals("[KFileDialog Settings]\nx=1\n")).toBe("");
});
