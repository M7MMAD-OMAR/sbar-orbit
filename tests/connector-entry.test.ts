import { DEPENDENCY_INVENTORY, writeWindowsDependencyInventory } from "../src/windows-dependencies";
import runtimeVector from "./fixtures/windows-runtime-source-v2.json";
import { BUN_LICENSE_PATH, parseRuntimeSource, runtimeDescriptorId, RUNTIME_RECEIPT } from "../src/windows-runtime-source";
import { version } from "../package.json";
import { expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { mkdir, writeFile, copyFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fixtureRoot } from "./platform-support";
import { releaseFixture } from "./managed-release-fixture";
import { sealRelease } from "../src/managed-identity";
import { DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME, DESKTOP_MANIFEST, desktopSourceDigest } from "../src/windows-desktop-update";
import { connectorEntry, connectorEnvironment } from "../src/connector-entry";

test("an agent host is handed the launcher, not an interpreter and a source file", () => {
  expect(connectorEntry({ launcher: "/prefix/bin/sbar-orbit", source: "/opt/orbit", platform: "linux" }))
    .toEqual({ command: "/prefix/bin/sbar-orbit", args: ["mcp"] });
});

test("the entry names no checkout, no version and no interpreter", () => {
  const entry = connectorEntry({ launcher: "/prefix/bin/sbar-orbit", source: "/srv/checkouts/sbar-orbit-0.1.0", platform: "linux" });
  const printed = JSON.stringify(entry);
  expect(printed).not.toContain("checkouts");
  expect(printed).not.toContain("0.1.0");
  expect(printed).not.toContain("bun");
});

test("the same source under two prefixes gives two entries, which is what an upgrade switches", () => {
  const source = "/opt/orbit";
  expect(connectorEntry({ launcher: "/a/bin/sbar-orbit", source, platform: "linux" }).command)
    .not.toBe(connectorEntry({ launcher: "/b/bin/sbar-orbit", source, platform: "linux" }).command);
});

test("a run with no launcher linked still produces a usable entry", () => {
  expect(connectorEntry({ source: "/opt/orbit", platform: "linux", interpreter: "/usr/bin/bun" }))
    .toEqual({ command: "/usr/bin/bun", args: [join("/opt/orbit", "src/mcp.ts")] });
});

test("Windows names its own launcher, and the suffix is added once", () => {
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit", source: "C:\\orbit", platform: "win32" }))
    .toEqual({ command: "C:\\orbit\\bin\\sbar-orbit.cmd", args: ["mcp"] });
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit.cmd", source: "C:\\orbit", platform: "win32" }).command)
    .toBe("C:\\orbit\\bin\\sbar-orbit.cmd");
});

test("a host that cannot spawn a .cmd is given the interpreter and the module", () => {
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit", source: "C:\\orbit", platform: "win32",
    interpreter: "C:\\orbit\\bun.exe", preferInterpreter: true }))
    .toEqual({ command: "C:\\orbit\\bun.exe", args: [join("C:\\orbit", "src/mcp.ts")] });
});

/**
 * The flag is advertised by the Linux launcher's own help, so it has to do something there. It used
 * to be honoured on win32 alone, which meant a Linux user following that help got back the launcher
 * again, with no error and no note saying the flag had been ignored.
 */
test("the same escape hatch works on Linux, where the launcher is an extensionless script", () => {
  expect(connectorEntry({ launcher: "/prefix/bin/sbar-orbit", source: "/opt/orbit", platform: "linux",
    interpreter: "/usr/bin/bun", preferInterpreter: true }))
    .toEqual({ command: "/usr/bin/bun", args: [join("/opt/orbit", "src/mcp.ts")] });
});

test("generated adapter environment carries the current release for host cache invalidation", () => {
  expect(connectorEnvironment("/owner/broker.sock")).toEqual({ ORBIT_SOCKET: "/owner/broker.sock", ORBIT_CLIENT_VERSION: version });
});

/** Synthetic byte-sealed native image, never executed as a Windows acceptance claim. */
async function nativeFixture(root: string, release = "1.2.3") {
  const directory = join(root, "versions", release); await releaseFixture(directory, release, false);
  const sourceDigest = await desktopSourceDigest(directory), files = [];
  for (const path of [DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME, BUN_LICENSE_PATH]) {
    const bytes = "owned native connector fixture " + release + " " + path;
    await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes);
    files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(join(directory, "node_modules/@modelcontextprotocol/sdk"), { recursive: true });
  await writeFile(join(directory, "node_modules/@modelcontextprotocol/sdk/package.json"), "{}");
  const dependencyInventory = await writeWindowsDependencyInventory(directory);
  files.push({ path: DEPENDENCY_INVENTORY, sha256: dependencyInventory.sha256 });
  const runtimeSource = parseRuntimeSource({ ...runtimeVector.runtimeSource, executableSha256: files.find(file => file.path === DESKTOP_RUNTIME)!.sha256, executableBytes: (await readFile(join(directory, DESKTOP_RUNTIME))).length, license: { ...runtimeVector.runtimeSource.license, sha256: files.find(file => file.path === BUN_LICENSE_PATH)!.sha256 } });
  await writeFile(join(directory, RUNTIME_RECEIPT), JSON.stringify({ ...runtimeVector.receipt, orbitVersion: release, executableSha256: runtimeSource.executableSha256, executableBytes: runtimeSource.executableBytes, descriptorId: runtimeDescriptorId(runtimeSource) }));
  await writeFile(join(directory, DESKTOP_MANIFEST), JSON.stringify({ schema: 2, bootstrapProtocol: 2, version: release, platform: "win32", arch: "x64", sourceRevision: "a".repeat(40), sourceDigest, runtimeSource, files }));
  await sealRelease(directory, release, join(directory, DESKTOP_RUNTIME)); return { directory, files };
}
async function installedNativeFixture() {
  const root = await fixtureRoot("orbit-native-connector-"), fixture = await nativeFixture(root);
  await mkdir(join(root, "bin")); await copyFile(join(fixture.directory, DESKTOP_LAUNCHER), join(root, "bin/Orbit.exe"));
  await writeFile(join(root, "windows-bootstrap.json"), JSON.stringify({ schema: 2, bootstrapProtocol: 2, version: "1.2.3", launcherDigest: fixture.files.find(file => file.path === DESKTOP_LAUNCHER)!.sha256 }));
  await writeFile(join(root, "current.txt"), fixture.directory); return { root, ...fixture };
}
test("validated native Windows MCP stays stable with or without --no-launcher", async () => {
  const fixture = await installedNativeFixture();
  try {
    const expected = { command: join(fixture.root, "bin/Orbit.exe"), args: ["--cli", fixture.root, "mcp"] };
    for (const preferInterpreter of [false, true]) expect(connectorEntry({ source: fixture.directory, platform: "win32", preferInterpreter, interpreter: "unused-versioned-bun" })).toEqual(expected);
    expect(connectorEntry({ source: join(fixture.root, "current"), platform: "win32" })).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain("versions");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("an arbitrary exe path or env hint does not establish native bootstrap authority", async () => {
  const fixture = await installedNativeFixture();
  try {
    expect(connectorEntry({ source: join(fixture.root, "unmanaged"), launcher: join(fixture.root, "bin/Orbit.exe"), platform: "win32" }).command).not.toBe(join(fixture.root, "bin/Orbit.exe"));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("tampered stable native image is refused rather than falling back to a versioned interpreter", async () => {
  const fixture = await installedNativeFixture();
  try {
    await writeFile(join(fixture.root, "bin/Orbit.exe"), "foreign image");
    expect(() => connectorEntry({ source: fixture.directory, platform: "win32", preferInterpreter: true })).toThrow();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("native MCP entry refuses recovery admission and incompatible bootstrap protocol", async () => {
  const fixture = await installedNativeFixture();
  try {
    await writeFile(join(fixture.root, "activation-recovery.json"), "{}");
    expect(() => connectorEntry({ source: fixture.directory, platform: "win32" })).toThrow();
    await rm(join(fixture.root, "activation-recovery.json"));
    const path = join(fixture.directory, DESKTOP_MANIFEST), manifest = JSON.parse(await readFile(path, "utf8")); manifest.bootstrapProtocol = 3;
    await writeFile(path, JSON.stringify(manifest)); expect(() => connectorEntry({ source: fixture.directory, platform: "win32" })).toThrow();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("compatible retained origin and a newer current payload still produce one stable MCP image", async () => {
  const fixture = await installedNativeFixture();
  try {
    const next = await nativeFixture(fixture.root, "1.2.4"); await writeFile(join(fixture.root, "current.txt"), next.directory);
    for (const source of [fixture.directory, next.directory]) expect(connectorEntry({ source, platform: "win32", preferInterpreter: true })).toEqual({ command: join(fixture.root, "bin/Orbit.exe"), args: ["--cli", fixture.root, "mcp"] });
    const original = join(fixture.directory, DESKTOP_MANIFEST), manifest = JSON.parse(await readFile(original, "utf8"));
    manifest.files.find((file: { path: string }) => file.path === DESKTOP_LAUNCHER).sha256 = "f".repeat(64);
    await writeFile(original, JSON.stringify(manifest)); expect(() => connectorEntry({ source: next.directory, platform: "win32" })).toThrow();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
