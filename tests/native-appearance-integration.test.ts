import { expect, test } from "bun:test";
import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeAppearance, stageNativeAppearance } from "../src/native-appearance";
import { nativeOptionsFromEnv } from "../src/native-worker";
import { createWorkspaceDirectory } from "../src/workspace-storage";

const enabled = process.platform === "linux" ? test : test.skip;

enabled("owner color preference is explicit, private and limited to fixed enums", async () => {
  const directory = await createWorkspaceDirectory("appearance-color");
  try {
    const staged = await stageNativeAppearance(directory, directory, "prefer-dark");
    expect(await loadNativeAppearance(staged.directory)).toEqual({ "color-scheme": "prefer-dark" });
    expect(staged.copied).toContain("color-scheme");
    const path = join(staged.directory, "color-scheme");
    await writeFile(path, "prefer-dark\n", { mode: 0o600 });
    await expect(loadNativeAppearance(staged.directory)).rejects.toThrow("color preference");
    await writeFile(path, "prefer-light", { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadNativeAppearance(staged.directory)).rejects.toThrow("private unlinked");
    await expect(stageNativeAppearance(directory, directory, "system")).rejects.toThrow("color preference");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

enabled("owner appearance snapshots filter literal settings and freeze launch defaults", async () => {
  const directory = await createWorkspaceDirectory("appearance-integration");
  try {
    await mkdir(join(directory, "gtk-3.0"), { mode: 0o700 });
    await writeFile(join(directory, "gtk-3.0/settings.ini"),
      "[Settings]\ngtk-application-prefer-dark-theme=true\ngtk-modules=untrusted\n", { mode: 0o600 });
    const value = await loadNativeAppearance(directory);
    expect(value).toEqual({ "gtk-3.0/settings.ini": "[Settings]\ngtk-application-prefer-dark-theme=true\n" });
    expect(Object.isFrozen(value)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

enabled("owner appearance refuses public, linked and oversized snapshots", async () => {
  const directory = await createWorkspaceDirectory("appearance-refusal");
  try {
    const parent = join(directory, "gtk-3.0");
    await mkdir(parent, { mode: 0o700 });
    const path = join(parent, "settings.ini");
    await writeFile(path, "[Settings]\ngtk-theme-name=Adwaita\n", { mode: 0o600 });
    await chmod(parent, 0o755);
    await expect(loadNativeAppearance(directory)).rejects.toThrow("directory");
    await chmod(parent, 0o700);
    await chmod(path, 0o644);
    await expect(loadNativeAppearance(directory)).rejects.toThrow("private unlinked");
    await chmod(path, 0o600);
    await link(path, join(directory, "linked"));
    await expect(loadNativeAppearance(directory)).rejects.toThrow("private unlinked");
    await rm(join(directory, "linked"));
    await rm(path);
    await symlink(join(directory, "missing"), path);
    await expect(loadNativeAppearance(directory)).rejects.toThrow();
    await rm(path);
    await writeFile(path, "[Settings]\ngtk-theme-name=" + "x".repeat(60_000), { mode: 0o600 });
    await expect(loadNativeAppearance(directory)).rejects.toThrow("configuration budget");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native appearance is an absolute owner startup option requiring native configuration", () => {
  const keys = ["ORBIT_NATIVE_PLAN", "ORBIT_NATIVE_CONTROL", "ORBIT_NATIVE_APPEARANCE"] as const;
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.ORBIT_NATIVE_APPEARANCE = "/private/snapshot";
    expect(nativeOptionsFromEnv).toThrow("plan and control");
    process.env.ORBIT_NATIVE_PLAN = "/private/plan";
    process.env.ORBIT_NATIVE_CONTROL = "/private/control";
    process.env.ORBIT_NATIVE_APPEARANCE = "relative";
    expect(nativeOptionsFromEnv).toThrow("absolute owner");
    process.env.ORBIT_NATIVE_APPEARANCE = "/private/snapshot";
    expect(nativeOptionsFromEnv()?.appearanceDirectory).toBe("/private/snapshot");
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
});
