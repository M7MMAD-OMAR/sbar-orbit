import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { discoverApplications } from "../src/application-discovery";

(process.platform === "darwin" ? test : test.skip)("macOS discovery reads a real binary plist in an owned application bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-macos-metadata-"));
  try {
    const bundle = join(root, "Portable Drawing.app/Contents"); await mkdir(join(bundle, "MacOS"), { recursive: true });
    const executable = join(bundle, "MacOS/drawing"); await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const plist = join(bundle, "Info.plist");
    await writeFile(plist, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>drawing</string><key>CFBundleIdentifier</key><string>example.orbit.drawing</string></dict></plist>');
    const convert = Bun.spawn(["/usr/bin/plutil", "-convert", "binary1", plist], { stdout: "ignore", stderr: "pipe" });
    expect(await convert.exited).toBe(0);
    const inventory = await discoverApplications({ bundleRoots: [root] });
    expect(inventory.applications).toHaveLength(1);
    expect(inventory.applications[0]).toMatchObject({ id: "example.orbit.drawing", executable: await realpath(executable), packaging: "bundle", availability: "verified" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

(process.platform === "win32" ? test : test.skip)("Windows discovery resolves an owned current-user App Paths registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-windows-metadata-"));
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows system root is unavailable");
  const reg = win32.join(systemRoot, "System32", "reg.exe");
  const id = `orbit-discovery-${crypto.randomUUID()}.exe`;
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${id}`;
  const executable = join(root, id);
  let registered = false;
  try {
    await cp(win32.join(systemRoot, "System32", "cmd.exe"), executable);
    const create = Bun.spawn([reg, "add", key, "/ve", "/t", "REG_SZ", "/d", executable, "/f"], { stdout: "ignore", stderr: "pipe" });
    expect(await create.exited).toBe(0); registered = true;
    const inventory = await discoverApplications({ query: id });
    expect(inventory.applications).toHaveLength(1);
    expect(inventory.applications[0]).toMatchObject({ id, packaging: "registry", availability: "verified" });
    expect(inventory.applications[0]?.executable.toLowerCase()).toBe((await realpath(executable)).toLowerCase());
  } finally {
    if (registered) {
      const remove = Bun.spawn([reg, "delete", key, "/f"], { stdout: "ignore", stderr: "ignore" });
      if (await remove.exited !== 0) throw new Error("Owned App Paths fixture cleanup failed");
    }
    await rm(root, { recursive: true, force: true });
  }
});
