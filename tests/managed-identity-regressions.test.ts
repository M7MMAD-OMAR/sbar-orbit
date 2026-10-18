import { createHash } from "node:crypto";
import * as ipc from "../src/ipc";
import { managedTarget } from "../src/managed-entry";
import { installService, serviceUnitDrift } from "../src/service";
import { expect, spyOn, test } from "bun:test";
import { mkdir, rm, symlink, writeFile, readFile, realpath, lstat, readdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activateVersion, currentVersion, prepareManagedInstall, pruneVersions, prepareVersion, preparedVersions } from "../src/update";
import { managedLifecycle, type CommandRunner } from "../src/managed-lifecycle";
import { brokerTaskXml } from "../src/windows-autostart";
import { fixtureRoot } from "./platform-support";

// These cases import only APIs present in the actual inherited lifecycle source.
// They can run unchanged on that snapshot. No new identity API is a baseline dependency.
test.skipIf(process.platform === "win32")("current pointer outside its own versions root is refused", async () => {
  const root = await fixtureRoot("orbit-identity-outside-");
  try {
    const owned = await contractRelease(root, "1.2.3"), foreign = await contractRelease(join(root, "foreign"), "1.2.3");
    await select(root, owned);
    expect(await currentVersion(root)).toBe("1.2.3");
    await rm(join(root, "current"));
    await select(root, foreign);
    await expect(currentVersion(root)).rejects.toThrow("Pointer must name one canonical prepared version in its own managed root");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prune retains every version when durable recovery admission is pending", async () => {
  const root = await fixtureRoot("orbit-identity-prune-");
  try {
    await mkdir(join(root, "versions/1.2.3"), { recursive: true });
    await writeFile(join(root, "activation-recovery.json"), JSON.stringify({ phase: "pending", rollbackTarget: "1.2.3" }));
    await expect(pruneVersions(root, 0)).rejects.toThrow();
    expect(await Bun.file(join(root, "activation-recovery.json")).exists()).toBe(true);
    await mkdir(join(root, "versions/1.2.3"), { recursive: false }).then(
      () => { throw new Error("Prune removed a protected version"); },
      error => { expect(error.code).toBe("EEXIST"); });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adoption dry-run refuses an existing durable recovery marker", async () => {
  const root = await fixtureRoot("orbit-identity-adoption-");
  try {
    const source = await contractRelease(join(root, "release"), "1.2.3"), managed = join(root, "managed");
    await mkdir(managed);
    expect(await prepareManagedInstall(source, { root: managed, dryRun: true })).toBe(join(managed, "current"));
    await writeFile(join(managed, "activation-recovery.json"), "{}");
    await expect(prepareManagedInstall(source, { root: managed, dryRun: true })).rejects.toThrow("Update recovery is pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registered task reconstructs its recorded renamed runtime instead of the updater", async () => {
  const sid = "S-1-5-21-1-2-3-1000", launcher = "C:\\Orbit & tools\\sbar-orbit.cmd";
  const xml = brokerTaskXml(launcher, sid, { ORBIT_BUN: "C:\\Installed Bun\\bun-pinned.exe" });
  const calls: string[][] = [];
  const run: CommandRunner = async argv => {
    calls.push(argv);
    if (argv.includes("/Query")) return { ok: true, output: xml };
    if (argv[0] === "powershell.exe") return { ok: true, output: "Ready" };
    return { ok: true, output: "" };
  };
  const lifecycle = managedLifecycle({ launcher, socket: "fixture", platform: "win32", run, sid: async () => sid });
  expect(await lifecycle.restart()).toMatchObject({ ok: true });
  expect(calls.some(argv => argv.includes("/End"))).toBe(true);
  // This asserts ownership reconstruction only. Ready is not descendant stop evidence.
});

// Independent contract fixture, usable unchanged on the inherited source without a new API import.
async function contractRelease(root: string, version: string, runtime = process.execPath) {
  const directory = join(root, "versions", version);
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "sbar-orbit", version }), "bun.lock": "{}\n",
    "bin/sbar-orbit": "#!/bin/sh\nexit 0\n", "bin/sbar-orbit.cmd": "@echo off\r\n",
    "src/cli.ts": "export {};\n", "src/mcp.ts": "export {};\n", "scripts/limited.ts": "export {};\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes, { mode: 0o700 });
  }
  const entries: [string, string][] = [];
  async function visit(relative: string) {
    const path = join(directory, relative), info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`);
    else entries.push([relative, hash(await readFile(path))]);
  }
  for (const name of ["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]) await visit(name);
  const pin = await realpath(runtime);
  await writeFile(join(directory, "orbit-release-identity.json"), JSON.stringify({ schema: 1, version, archiveIntegrity: null,
    releaseDigest: hash(JSON.stringify(entries)), runtime: pin, runtimeDigest: hash(await readFile(pin)) }));
  return directory;
}

async function select(root: string, target: string) {
  if (process.platform === "win32") await writeFile(join(root, "current.txt"), target);
  else await symlink(target, join(root, "current"));
}

test("same version changed shipped bytes is refused rather than relabeled current", async () => {
  const root = await fixtureRoot("orbit-identity-changed-");
  try {
    const target = await contractRelease(root, "1.2.3");
    await select(root, target);
    expect(await currentVersion(root)).toBe("1.2.3");
    await writeFile(join(target, "src/cli.ts"), "export const changed = true;\n");
    await expect(currentVersion(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replaced runtime bytes is refused with the same version and path", async () => {
  const root = await fixtureRoot("orbit-identity-runtime-");
  try {
    const runtime = join(root, process.platform === "win32" ? "bun-pinned.exe" : "bun-pinned");
    await copyFile(process.execPath, runtime);
    const target = await contractRelease(root, "1.2.3", runtime);
    await select(root, target);
    expect(await currentVersion(root)).toBe("1.2.3");
    await writeFile(runtime, "replacement runtime bytes");
    await expect(currentVersion(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current.txt cannot select another managed root", async () => {
  const root = await fixtureRoot("orbit-identity-txt-");
  try {
    const owned = join(root, "owned"), foreign = join(root, "foreign");
    await contractRelease(owned, "1.2.3");
    const target = await contractRelease(foreign, "1.2.3");
    const ownedTarget = join(owned, "versions/1.2.3");
    await writeFile(join(owned, "current.txt"), ownedTarget);
    expect(await managedTarget(owned)).toBe(ownedTarget);
    await writeFile(join(owned, "current.txt"), target);
    await expect(managedTarget(owned)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current pointer storage errors are not reported as an absent installation", async () => {
  const root = await fixtureRoot("orbit-identity-pointer-storage-");
  try {
    expect(await currentVersion(root)).toBeNull();
    await mkdir(join(root, process.platform === "win32" ? "current.txt" : "current"));
    await expect(currentVersion(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("versions storage errors are not reported as no prepared versions", async () => {
  const root = await fixtureRoot("orbit-identity-version-storage-");
  try {
    expect(await preparedVersions(root)).toEqual([]);
    await writeFile(join(root, "versions"), "foreign regular file");
    await expect(preparedVersions(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same version with different feed archive identity cannot reuse an existing release", async () => {
  const root = await fixtureRoot("orbit-identity-archive-");
  try {
    await contractRelease(root, "1.2.3");
    const result = await prepareVersion({ version: "1.2.3", tarball: "fixture://unrequested", integrity: "sha512-ZGlmZmVyZW50", publishedAt: "2026-09-01" },
      { download: async () => { throw new Error("An existing conflicting release must remain untouched"); } }, { root });
    expect(result).toMatchObject({ prepared: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Unix ownership uses the recorded renamed runtime and account roots with a different updater", async () => {
  const root = await fixtureRoot("orbit-identity-unix-record-");
  const previous = { ORBIT_BUN: process.env.ORBIT_BUN, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    const launcher = join(root, "orbit"), runtime = join(dirname(process.execPath), "bun-pinned");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.ORBIT_BUN = runtime; process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CONFIG_HOME = join(root, "config");
    await installService(launcher, root);
    expect(await serviceUnitDrift(root, launcher)).toMatchObject({ current: true });
    // Preserve a real recorded renamed pin even when the old installer ignored ORBIT_BUN.
    for (const unit of ["sbar-orbit.service", "sbar-orbit-update.service"]) {
      const path = join(root, unit);
      await writeFile(path, (await readFile(path, "utf8")).replaceAll(process.execPath, runtime));
    }
    process.env.ORBIT_BUN = process.execPath; process.env.XDG_DATA_HOME = join(root, "other-data"); process.env.XDG_CONFIG_HOME = join(root, "other-config");
    expect(await serviceUnitDrift(root, launcher)).toMatchObject({ current: true });
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test("version-only old broker cannot satisfy exact release health", async () => {
  const root = await fixtureRoot("orbit-identity-health-");
  let doctor: ReturnType<typeof spyOn> | undefined;
  try {
    await contractRelease(root, "0.1.0"); await contractRelease(root, "0.2.0");
    const base = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }) };
    expect(await activateVersion("0.1.0", { ...base, healthy: async () => true })).toMatchObject({ activated: true });
    doctor = spyOn(ipc, "call").mockImplementation(async () => ({ version: await currentVersion(root) }));
    expect(await activateVersion("0.2.0", base)).toMatchObject({ activated: false, rolledBack: true, rollbackHealthy: false });
    expect(await currentVersion(root)).toBe("0.1.0");
  } finally { doctor?.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
