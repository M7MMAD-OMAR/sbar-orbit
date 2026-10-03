import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterNativeAppearance, stageNativeAppearance } from "../src/native-appearance";

test("native visual filtering excludes state, expansion suffixes and unknown keys", () => {
  expect(filterNativeAppearance("[Settings]\ngtk-theme-name=Adwaita\ngtk-font-name=Sans 11\ngtk-print-preview-command=secret\n[Other]\ngtk-theme-name=wrong\n", "gtk"))
    .toBe("[Settings]\ngtk-theme-name=Adwaita\ngtk-font-name=Sans 11\n");
  expect(filterNativeAppearance("[General]\nColorScheme=Dark\nTerminalApplication=secret\nfont[$e]=secret\n[General][$i]\nfont=secret\n[Icons]\nTheme=breeze\nUnknown=secret\n[Colors:View]\nBackgroundNormal=1,2,3\nDocument=secret\n[ColorEffects:Inactive]\nEnable=true\n[KFileDialog Settings]\nRecent Files=secret\n", "kde"))
    .toBe("[General]\nColorScheme=Dark\n\n[Icons]\nTheme=breeze\n\n[Colors:View]\nBackgroundNormal=1,2,3\n\n[ColorEffects:Inactive]\nEnable=true\n");
});

test("native filter applies later literal values and refuses malformed section leakage", () => {
  expect(filterNativeAppearance("[Settings]\ngtk-theme-name=Light\ngtk-theme-name=Dark\n[Broken\ngtk-font-name=secret\n[Settings]\n#comment\ngtk-icon-theme-name=icons\n", "gtk"))
    .toBe("[Settings]\ngtk-theme-name=Dark\ngtk-icon-theme-name=icons\n");
});

test.skipIf(process.platform !== "linux")("staging creates private filtered files and leaves source untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-appearance-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "gtk-4.0"), { recursive: true });
    const text = "[Settings]\ngtk-theme-name=Adwaita\ngtk-cursor-theme-size=32\ngtk-print-preview-command=secret\n";
    await writeFile(join(source, "gtk-4.0/settings.ini"), text);
    await writeFile(join(source, "kdeglobals"), "[General]\nColorScheme=Dark\nTerminalApplication=secret\n");
    await writeFile(join(source, "bookmarks"), "secret");
    await mkdir(join(source, "dconf"));
    await writeFile(join(source, "dconf/user"), "secret");
    const result = await stageNativeAppearance(source, root);
    expect(result.copied).toEqual(["gtk-4.0/settings.ini", "kdeglobals"]);
    expect(result.absent).toEqual(["gtk-3.0/settings.ini"]);
    expect(result.themeMatch).toBe("not measured");
    expect((await lstat(result.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(result.directory, "gtk-4.0/settings.ini"))).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(result.directory, "gtk-4.0/settings.ini")).text()).not.toContain("secret");
    expect(await Bun.file(join(source, "gtk-4.0/settings.ini")).text()).toBe(text);
    expect((await readdir(result.directory)).sort()).toEqual(["gtk-4.0", "kdeglobals"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("unsupported symlink and oversized sources fail and remove partial staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-appearance-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "gtk-3.0"), { recursive: true });
    await writeFile(join(source, "gtk-3.0/settings.ini"), "[Settings]\ngtk-theme-name=Adwaita\n");
    await symlink("gtk-3.0/settings.ini", join(source, "kdeglobals"));
    await expect(stageNativeAppearance(source, root)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["source"]);
    await rm(join(source, "kdeglobals"));
    await writeFile(join(source, "kdeglobals"), "x".repeat(1_000_001));
    await expect(stageNativeAppearance(source, root)).rejects.toThrow("bounded regular file");
    expect(await readdir(root)).toEqual(["source"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("untrusted staging parent is refused before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-appearance-"));
  try {
    await chmod(root, 0o777);
    await expect(stageNativeAppearance(root, root)).rejects.toThrow("private");
    expect(await readdir(root)).toEqual([]);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});


test("prototype-named KDE groups are excluded without breaking valid visual keys", () => {
  expect(filterNativeAppearance("[constructor]\nfont=secret\n[toString]\nTheme=secret\n[__proto__]\nwidgetStyle=secret\n[General]\nfont=Sans,11\n", "kde"))
    .toBe("[General]\nfont=Sans,11\n");
});

test.skipIf(process.platform !== "linux")("missing source root and invalid UTF-8 fail, but absent optional settings remain explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-appearance-"));
  try {
    await expect(stageNativeAppearance(join(root, "missing"), root)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    const source = join(root, "source");
    await mkdir(source);
    const empty = await stageNativeAppearance(source, root);
    expect(empty.absent).toHaveLength(3);
    expect(empty.copied).toEqual([]);
    expect(empty.themeMatch).toBe("not measured");
    await rm(empty.directory, { recursive: true });
    await writeFile(join(source, "kdeglobals"), Buffer.from([0xff]));
    await expect(stageNativeAppearance(source, root)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["source"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
