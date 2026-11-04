import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { desktopSourceDigest, DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_MANIFEST, DESKTOP_RUNTIME,
  extractDesktopZip, mergeDesktopOverlay, parseDesktopManifest, safeWindowsPayloadPath, validateDesktopPayload } from "../src/windows-desktop-update";
import { admittedWindowsBootstrap, installWindowsManaged, recordWindowsReleaseFiles, selectWindowsBootstrap, verifyWindowsCurrent } from "../src/windows-managed-install";
import { brokerTaskXml } from "../src/windows-autostart";
import { taskOwned, windowsDesktopUpdateTaskXml, type CommandRunner, type ManagedLifecycle } from "../src/managed-lifecycle";
import { releaseDigest, sealRelease } from "../src/managed-identity";
import { pruneVersions } from "../src/update";

// Byte strings are synthetic owned fixtures, NOT Windows executable/build/runtime acceptance.
const version = "0.0.0-fixture.1", sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const directories: string[] = [];
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "orbit-windows-managed-fixture-"))); directories.push(directory); return directory; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function put(directory: string, path: string, bytes: string | Buffer) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), bytes); }
async function payload() {
  const directory = await temporary();
  for (const [path, bytes] of Object.entries({
    "package.json": JSON.stringify({ name: "sbar-orbit", version }), "bun.lock": "owned fixture lock",
    "bin/sbar-orbit": "owned shell stub", "bin/sbar-orbit.cmd": "owned cmd stub", "src/cli.ts": "owned CLI fixture",
    "src/mcp.ts": "owned MCP fixture", "src/connector-config.ts": "owned connector fixture", "scripts/limited.ts": "owned budget fixture",
    "src/windows-managed-install.ts": "owned central source fixture", "node_modules/@modelcontextprotocol/sdk/package.json": "{}",
  })) await put(directory, path, bytes);
  const sourceDigest = await desktopSourceDigest(directory);
  const files = [DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME].map(path => ({ path, sha256: sha("owned fixture " + path) }));
  for (const file of files) await put(directory, file.path, "owned fixture " + file.path);
  const manifest = { schema: 1, bootstrapProtocol: 1, version, platform: "win32", arch: "x64", sourceRevision: "a".repeat(40), sourceDigest, files };
  await put(directory, DESKTOP_MANIFEST, JSON.stringify(manifest));
  return { directory, manifest };
}
function crc(bytes: Buffer) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
type ZipEntry = { name: string; bytes?: Buffer; external?: number; method?: number; offset?: number; localExtra?: Buffer };
function zip(entries: ZipEntry[]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = entry.bytes ?? Buffer.from("owned fixture"), method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes, extra = entry.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc(bytes), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc(bytes), 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE((entry.external ?? 0) >>> 0, 38); record.writeUInt32LE(entry.offset ?? offset, 42);
    locals.push(local, name, extra, compressed); central.push(record, name); offset += local.length + name.length + extra.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function unpack(entries: ZipEntry[], alter?: (bytes: Buffer) => void) {
  const directory = await temporary(), archive = join(directory, "fixture.zip"), destination = join(directory, "out");
  const bytes = zip(entries); alter?.(bytes); await writeFile(archive, bytes);
  await extractDesktopZip(archive, destination); return { directory, destination };
}

describe("bounded Windows path and manifest contract", () => {
  for (const path of ["../escape", "/absolute", "C:/file", "desktop\\file", "desktop//file", "desktop/./file", "desktop/a/../file", "desktop/file:ads",
    "desktop/CON", "desktop/nul.txt", "desktop/com1.log", "desktop/LPT9", "desktop/trailing.", "desktop/trailing ", "desktop/control\nname"]) {
    test("refuses " + JSON.stringify(path), () => expect(() => safeWindowsPayloadPath(path)).toThrow());
  }
  test("requires complete explicit same-version coherent manifest", async () => {
    const { manifest } = await payload();
    expect(parseDesktopManifest(manifest, version).bootstrapProtocol).toBe(1);
    for (const patch of [{ version: "other" }, { bootstrapProtocol: 2 }, { platform: "linux" }, { sourceDigest: "unknown" }, { sourceRevision: "main" }, { extra: true }, { files: manifest.files.slice(0, 2) }])
      expect(() => parseDesktopManifest({ ...manifest, ...patch }, version)).toThrow();
    expect(() => parseDesktopManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0]!, path: manifest.files[0]!.path.toUpperCase() }] }, version)).toThrow();
  });
  test("source digest stays equal to source-only managed digest and ignores only overlay", async () => {
    const { directory, manifest } = await payload();
    expect(await desktopSourceDigest(directory)).toBe(manifest.sourceDigest);
    const source = await temporary();
    for (const path of ["package.json", "bun.lock", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "src/cli.ts", "src/mcp.ts", "scripts/limited.ts"]) await put(source, path, "owned " + path);
    expect(await desktopSourceDigest(source)).toBe(await releaseDigest(source));
    await put(directory, "src/new.ts", "changed source"); expect(await desktopSourceDigest(directory)).not.toBe(manifest.sourceDigest);
  });
  test("all runtime and desktop files must be covered; bytes and source digest checked", async () => {
    const { directory, manifest } = await payload();
    await validateDesktopPayload(directory, version, manifest.sourceDigest);
    await put(directory, "runtime/extra.dll", "unlisted"); await expect(validateDesktopPayload(directory, version)).rejects.toThrow();
    await rm(join(directory, "runtime/extra.dll")); await put(directory, DESKTOP_EXE, "tampered");
    await expect(validateDesktopPayload(directory, version)).rejects.toThrow();
  });
  test("source directory depth is bounded even when no files are present", async () => {
    const directory = await temporary(); await mkdir(join(directory, "src", ...Array(34).fill("deep")), { recursive: true });
    await expect(desktopSourceDigest(directory)).rejects.toThrow();
  });
});

describe("ZIP32 quarantined extraction", () => {
  test("stored and deflated data extract under one fresh canonical stage", async () => {
    const { destination } = await unpack([{ name: DESKTOP_RUNTIME, method: 8 }, { name: DESKTOP_EXE }]);
    expect(await readFile(join(destination, DESKTOP_RUNTIME), "utf8")).toBe("owned fixture");
  });
  for (const [label, entries] of [
    ["casefold duplicate", [{ name: DESKTOP_EXE }, { name: DESKTOP_EXE.toUpperCase() }]],
    ["casefold directory", [{ name: "desktop/windows-app/a.dll" }, { name: "Desktop/windows-app/b.dll" }]],
    ["source collision path", [{ name: "src/cli.ts" }]], ["traversal", [{ name: "desktop/windows-app/../../outside" }]],
    ["symlink type", [{ name: DESKTOP_RUNTIME, external: 0xa000 << 16 }]],
    ["reparse flag", [{ name: DESKTOP_RUNTIME, external: 0x400 }]],
    ["overlap", [{ name: DESKTOP_RUNTIME }, { name: DESKTOP_RUNTIME + ".bad", offset: 0 }]],
    ["ZIP64 local extra", [{ name: DESKTOP_RUNTIME, localExtra: Buffer.from([1, 0, 0, 0]) }]],
  ] as [string, ZipEntry[]][]) test(label, async () => { await expect(unpack(entries)).rejects.toThrow(); });
  test("overlapping valid local frames are rejected before any output file is written", async () => {
    const nested = zip([{ name: DESKTOP_EXE }]);
    const body = nested.subarray(0, nested.readUInt32LE(nested.length - 6));
    const directory = await temporary(), archive = join(directory, "overlap.zip"), output = join(directory, "out");
    await writeFile(archive, zip([{ name: DESKTOP_RUNTIME, bytes: body }, { name: DESKTOP_EXE, offset: 30 + Buffer.byteLength(DESKTOP_RUNTIME) }]));
    await expect(extractDesktopZip(archive, output)).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  });
  test("directory entries count toward the bounded archive entry budget", async () => {
    await expect(unpack(Array.from({ length: 4353 }, (_, index) => ({ name: "desktop/windows-app/d-" + index + "/", bytes: Buffer.alloc(0) })))).rejects.toThrow();
  });
  test("declared too many entries or malformed local headers refuse before writes", async () => {
    await expect(unpack([{ name: DESKTOP_RUNTIME }], bytes => bytes.writeUInt16LE(5000, bytes.length - 12))).rejects.toThrow();
    await expect(unpack([{ name: DESKTOP_RUNTIME }], bytes => bytes.writeUInt32LE(0, 0))).rejects.toThrow();
  });
  test("existing destination and a redirected destination ancestor are refused", async () => {
    const directory = await temporary(), archive = join(directory, "a.zip"), destination = join(directory, "existing");
    await writeFile(archive, zip([{ name: DESKTOP_RUNTIME }])); await mkdir(destination);
    await expect(extractDesktopZip(archive, destination)).rejects.toThrow();
    const redirect = join(directory, "redirect"); await symlink(destination, redirect, process.platform === "win32" ? "junction" : "dir");
    await expect(extractDesktopZip(archive, join(redirect, "out"))).rejects.toThrow();
    expect(await readdir(destination)).toEqual([]);
  });
  test("verified overlay merge is exclusive and cannot replace source files", async () => {
    const { directory, manifest } = await payload(); const source = await temporary();
    const parsed = parseDesktopManifest(manifest, version);
    await mergeDesktopOverlay(directory, source, parsed); await validateDesktopPayload(source, version, manifest.sourceDigest);
    await expect(mergeDesktopOverlay(directory, source, parsed)).rejects.toThrow();
  });
});

async function installFixture(automaticUpdates = false, health = true) {
  const { directory, manifest } = await payload(), base = await temporary(), root = join(base, "sbar-orbit"), socket = join(base, "broker.sock");
  const commands: string[][] = [], scheduling: boolean[] = [];
  const run: CommandRunner = async argv => { commands.push([...argv]); return { ok: true, output: argv[0] === "powershell.exe" ? "ABSENT" : "" }; };
  const lifecycle: ManagedLifecycle = { admit: async () => ({ ok: true, output: "owned fixture admission" }), restart: async () => ({ ok: true, output: "" }), schedule: async on => { scheduling.push(on); return { ok: true, output: "" }; } };
  return { directory, manifest, base, root, socket, commands, scheduling, run,
    options: { root, socket, platform: "win32" as const, sid: "S-1-5-21-1000", automaticUpdates, run, lifecycle, healthy: async () => health } };
}
describe("central fresh Windows installation with owned OS recorders", () => {
  test("initial payload/GUI/CLI/runtime become one verified current version", async () => {
    const fixture = await installFixture();
    const result = await installWindowsManaged(fixture.directory, fixture.options);
    expect(result.ok).toBe(true); expect(result.reused).toBe(false);
    expect((await verifyWindowsCurrent(fixture.root)).runtime).toBe(join(fixture.root, "versions", version, DESKTOP_RUNTIME));
    expect(await readFile(join(fixture.root, "current.txt"), "utf8")).toBe(join(fixture.root, "versions", version));
    expect(fixture.commands.filter(argv => argv.includes("/Create"))).toHaveLength(1);
    expect(fixture.scheduling).toEqual([]);
  });
  test("explicit initial on registers updater; preserved off never silently re-enables", async () => {
    const first = await installFixture(true); await installWindowsManaged(first.directory, first.options); expect(first.scheduling).toEqual([true]);
    const second = await installFixture(true); await mkdir(second.root); await writeFile(join(second.root, "automatic"), "off\n");
    const result = await installWindowsManaged(second.directory, second.options); expect(result.automaticUpdates).toBe(false); expect(second.scheduling).toEqual([]);
  });
  test("same-version reinstall requires admission and exact healthy identity", async () => {
    const fixture = await installFixture(); await installWindowsManaged(fixture.directory, fixture.options);
    const before = fixture.commands.length; const result = await installWindowsManaged(fixture.directory, fixture.options);
    expect(result.reused).toBe(true); expect(fixture.commands.length).toBe(before);
    await expect(installWindowsManaged(fixture.directory, { ...fixture.options, healthy: async () => false })).rejects.toThrow();
  });
  test("failed initial health retains barrier and a reinstall cannot reuse or clear it", async () => {
    const fixture = await installFixture(false, false);
    await expect(installWindowsManaged(fixture.directory, fixture.options)).rejects.toThrow();
    const barrier = await readFile(join(fixture.root, "activation-recovery.json"), "utf8"), before = fixture.commands.length;
    await expect(installWindowsManaged(fixture.directory, { ...fixture.options, healthy: async () => true })).rejects.toThrow();
    expect(fixture.commands.length).toBe(before); expect(await readFile(join(fixture.root, "activation-recovery.json"), "utf8")).toBe(barrier);
    await expect(verifyWindowsCurrent(fixture.root)).rejects.toThrow();
  });
  test("existing endpoint, foreign task or unknown root never starts a new broker", async () => {
    const endpoint = await installFixture(); await writeFile(endpoint.socket, "owned endpoint fixture");
    await expect(installWindowsManaged(endpoint.directory, endpoint.options)).rejects.toThrow();
    expect(endpoint.commands.some(argv => argv.includes("/Create"))).toBe(false);
    const foreign = await installFixture();
    await expect(installWindowsManaged(foreign.directory, { ...foreign.options, run: async () => ({ ok: true, output: "PRESENT" }) })).rejects.toThrow();
    const unknown = await installFixture(); await mkdir(unknown.root); await writeFile(join(unknown.root, "owner-work.txt"), "preserve");
    await expect(installWindowsManaged(unknown.directory, unknown.options)).rejects.toThrow();
    expect(await readFile(join(unknown.root, "owner-work.txt"), "utf8")).toBe("preserve"); expect(unknown.commands).toEqual([]);
  });
  test("checkout or unexpected private inputs are never copied into installed state", async () => {
    const fixture = await installFixture(); await mkdir(join(fixture.directory, ".git"));
    await expect(installWindowsManaged(fixture.directory, fixture.options)).rejects.toThrow();
    expect(fixture.commands).toEqual([]);
  });
  test("deep source directories and redirected input refuse before native commands", async () => {
    const fixture = await installFixture(); await mkdir(join(fixture.directory, "node_modules", ...Array(34).fill("deep")), { recursive: true });
    await expect(installWindowsManaged(fixture.directory, fixture.options)).rejects.toThrow();
    expect(fixture.commands.some(argv => argv.includes("/Create"))).toBe(false);
  });
});

test("dedicated automatic task uses exact versioned Bun, not a locked native host", () => {
  const sid = "S-1-5-21-1000", launcher = "C:\\Orbit\\bin\\sbar-orbit.cmd";
  const environment = { ORBIT_MANAGED_ENV_SCHEMA: "1", ORBIT_BUN: "C:\\Orbit\\versions\\1.2.3\\runtime\\bun.exe" };
  const xml = windowsDesktopUpdateTaskXml(launcher, sid, environment);
  expect(taskOwned(xml, launcher, sid, true)).toBe(true);
  expect(xml).toContain("scripts\\limited.ts"); expect(xml).toContain("src\\cli.ts");
  expect(xml).not.toContain("&quot;" + launcher + "&quot; update run");
  expect(taskOwned(brokerTaskXml(launcher, sid, environment, true), launcher, sid)).toBe(true);
});

async function nextCandidate(root: string) {
  const source = await payload(), nextVersion = "0.0.0-fixture.2";
  await put(source.directory, "package.json", JSON.stringify({ name: "sbar-orbit", version: nextVersion }));
  const files = [DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME].map(path => ({ path, sha256: sha("next owned fixture " + path) }));
  for (const file of files) await put(source.directory, file.path, "next owned fixture " + file.path);
  await put(source.directory, DESKTOP_MANIFEST, JSON.stringify({ ...source.manifest, version: nextVersion, sourceRevision: "b".repeat(40), sourceDigest: await desktopSourceDigest(source.directory), files }));
  const directory = join(root, "versions", nextVersion); await cp(source.directory, directory, { recursive: true });
  await sealRelease(directory, nextVersion, join(directory, DESKTOP_RUNTIME)); await recordWindowsReleaseFiles(directory);
  await writeFile(join(root, "current.txt"), directory); return { directory, version: nextVersion };
}
test("compatible idle-host lock retains admitted origin while GUI CLI runtime advance together", async () => {
  const fixture = await installFixture(); await installWindowsManaged(fixture.directory, fixture.options);
  const oldBytes = await readFile(join(fixture.root, "bin/Orbit.exe")), next = await nextCandidate(fixture.root);
  const selected = await selectWindowsBootstrap(fixture.root, { replace: async () => { throw Object.assign(new Error("owned simulated sharing violation"), { code: "EBUSY" }); } });
  expect(selected.bootstrapRetained).toBe(true); expect(selected.bootstrapVersion).toBe(version);
  expect(selected.version).toBe(next.version); expect(selected.runtime).toBe(join(next.directory, DESKTOP_RUNTIME)); expect(selected.desktopPath).toBe(join(next.directory, DESKTOP_EXE));
  expect(await readFile(join(fixture.root, "bin/Orbit.exe"))).toEqual(oldBytes);
  const windowsPrune = async () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try { return await pruneVersions(fixture.root, 0); } finally { Object.defineProperty(process, "platform", saved); }
  };
  const pinned = await windowsPrune(); expect(pinned).toMatchObject({ removed: [], supported: false });
  expect(pinned.kept.sort()).toEqual([version, next.version].sort());
  expect((await admittedWindowsBootstrap(fixture.root)).version).toBe(version);
  const upgraded = await selectWindowsBootstrap(fixture.root); expect(upgraded.bootstrapRetained).toBe(false);
  expect((await admittedWindowsBootstrap(fixture.root)).version).toBe(next.version);
  const retained = await windowsPrune(); expect(retained).toMatchObject({ removed: [], supported: false });
  expect(retained.kept.sort()).toEqual([version, next.version].sort());
});
test("sharing fallback never accepts a tampered old host or incompatible protocol", async () => {
  const fixture = await installFixture(); await installWindowsManaged(fixture.directory, fixture.options); await nextCandidate(fixture.root);
  await expect(selectWindowsBootstrap(fixture.root, { replace: async path => { await writeFile(path, "foreign image"); throw Object.assign(new Error("denied"), { code: "EPERM" }); } })).rejects.toThrow();
  const another = await installFixture(); await installWindowsManaged(another.directory, another.options); const next = await nextCandidate(another.root);
  const manifestPath = join(next.directory, DESKTOP_MANIFEST), manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.bootstrapProtocol = 2; await writeFile(manifestPath, JSON.stringify(manifest));
  let touched = false; await expect(selectWindowsBootstrap(another.root, { replace: async () => { touched = true; } })).rejects.toThrow(); expect(touched).toBe(false);
});
test.skipIf(process.platform !== "win32")("real Windows deny-delete handle retains compatible host without closing the holder (not MCP E2E)", async () => {
  const fixture = await installFixture(); await installWindowsManaged(fixture.directory, fixture.options); const next = await nextCandidate(fixture.root);
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const api = dlopen("kernel32.dll", { CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr }, CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 } });
  const name = Buffer.from(join(fixture.root, "bin/Orbit.exe") + "\0", "utf16le");
  const handle = api.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0, null);
  try {
    if (!handle || Number(handle) < 0 || Number(handle) > Number.MAX_SAFE_INTEGER) throw new Error("Owned Windows sharing fixture could not open its handle");
    const selected = await selectWindowsBootstrap(fixture.root); expect(selected.bootstrapRetained).toBe(true); expect(selected.version).toBe(next.version);
    expect((await admittedWindowsBootstrap(fixture.root)).version).toBe(version);
  } finally { if (handle && Number(handle) >= 0 && Number(handle) <= Number.MAX_SAFE_INTEGER) api.symbols.CloseHandle(handle); api.close(); }
});
