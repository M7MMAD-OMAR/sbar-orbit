import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWindowsPayload, auditPublicWindowsPayload, copyExclusiveTree, windowsDesktopArtifactName, windowsOverlayPath, WINDOWS_MANIFEST } from "../scripts/package-windows";
import { desktopSourceDigest, parseDesktopManifest, validateDesktopPayload, validatePublicDesktopOverlay } from "../src/windows-desktop-update";
import { fixtureVersions } from "../scripts/windows-desktop-acceptance";
import { parseRuntimeSource, runtimeDescriptorId } from "../src/windows-runtime-source";
import runtimeVector from "./fixtures/windows-runtime-source-v2.json";
import { DEPENDENCY_INVENTORY, parseWindowsDependencies } from "../src/windows-dependencies";

test("offline activation fixture versions are new private assemblies, never public release evidence", () => {
  expect(fixtureVersions("0.4.3", "12345")).toEqual({ activation: "0.4.4-ci.activation.12345", rollback: "0.4.4-ci.rollback.12345" });
  for (const [base, run] of [["bad", "123"], ["0.4.3", "../123"], ["0.4.3", "123\n"], ["0.4.3\n", "123"], ["0.4.65534", "123"]]) expect(() => fixtureVersions(base!, run!)).toThrow();
});

// Tiny owned byte fixtures validate packaging only. They are not Windows binaries or GUI acceptance evidence.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-windows-package-"));
  const source = join(root, "source"), publishedDesktop = join(root, "published"), output = join(root, "output");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "sbar-orbit", version: "9.9.9" }), "bun.lock": "owned-lock",
    "SOURCE-COMMIT.json": JSON.stringify({ schema: 1, version: "9.9.9", sourceCommit: "a".repeat(40) }),
    "src/cli.ts": "owned-cli", "src/mcp.ts": "owned-mcp", "src/windows-managed-install.ts": "owned-install",
    "src/windows-desktop-update.ts": "owned-overlay", "src/windows-runtime-source.ts": "owned-runtime-policy", "src/windows-dependencies.ts": "owned-dependency-policy", "scripts/limited.ts": "owned-budget",
    "bin/sbar-orbit.cmd": "owned-source-launcher", "bin/sbar-orbit": "owned-posix-launcher",
    "node_modules/@modelcontextprotocol/sdk/package.json": "{}", "desktop/panel.py": "owned-linux-panel",
  };
  for (const [path, value] of Object.entries(files)) { await mkdir(join(source, path, ".."), { recursive: true }); await writeFile(join(source, path), value); }
  for (const [path, value] of Object.entries({ "Orbit.Desktop.exe": "MZ-owned-exe-fixture", "Orbit.Desktop.dll": "owned-dll", "ui/index.html": "Owned UI", "notices/bun/LICENSE.md": runtimeVector.licenseBytes })) {
    await mkdir(join(publishedDesktop, path, ".."), { recursive: true }); await writeFile(join(publishedDesktop, path), value);
  }
  const bun = join(root, "bun.exe"), launcher = join(root, "Orbit.Launcher.exe"), bootstrap = join(root, "Orbit.RuntimeBootstrap.exe");
  await writeFile(bun, runtimeVector.runtimeBytes); await writeFile(launcher, "MZ-owned-launcher-fixture"); await writeFile(bootstrap, "MZ-owned-framework-bootstrap-fixture");
  return { root, source, publishedDesktop, output, bun, launcher, bootstrap, runtimeSource: parseRuntimeSource(runtimeVector.runtimeSource), sourceRevision: "a".repeat(40) };
}

test("exclusive tree copy merges existing owned directories but never overwrites a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-exclusive-copy-"));
  const first = join(root, "first"), second = join(root, "second"), collision = join(root, "collision"), output = join(root, "output");
  try {
    for (const path of [first, second, collision]) await mkdir(join(path, "nested"), { recursive: true });
    await mkdir(output);
    await writeFile(join(first, "nested/a.txt"), "first");
    await writeFile(join(first, "skip.txt"), "excluded");
    await writeFile(join(second, "nested/b.txt"), "second");
    await writeFile(join(collision, "nested/a.txt"), "must-not-overwrite");
    await writeFile(join(output, "owner-marker.txt"), "preserve");
    await copyExclusiveTree(first, output, { exclude: new Set(["skip.txt"]) });
    await copyExclusiveTree(second, output);
    expect(await readFile(join(output, "nested/a.txt"), "utf8")).toBe("first");
    expect(await readFile(join(output, "nested/b.txt"), "utf8")).toBe("second");
    expect(await Bun.file(join(output, "skip.txt")).exists()).toBe(false);
    await expect(copyExclusiveTree(collision, output)).rejects.toThrow();
    expect(await readFile(join(output, "nested/a.txt"), "utf8")).toBe("first");
    expect(await readFile(join(output, "owner-marker.txt"), "utf8")).toBe("preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows artifact names and overlay paths cannot escape or collide with source", () => {
  expect(windowsDesktopArtifactName("9.9.9")).toBe("sbar-orbit-9.9.9-windows-x64-desktop.zip");
  for (const version of ["", "../9.9.9", "9.9.9/other", "9.9", "9.9.9--", "9.9.9\n"]) expect(() => windowsDesktopArtifactName(version)).toThrow();
  for (const path of ["desktop/windows-app/Orbit.Desktop.exe", "desktop/windows-app/ui/index.html", "node_modules/@modelcontextprotocol/sdk/package.json"]) expect(windowsOverlayPath(path)).toBe(true);
  for (const path of ["src/cli.ts", "desktop/panel.py", "runtime/bun.exe", "runtime/other.exe", "../runtime/bun.exe", "desktop/windows-app/../bad", "desktop/windows-app/CON", "desktop/windows-app/bad.", "desktop/windows-app/x:stream", "desktop/windows-app/@foo/index.js", "node_modules/@bad!/package.json", "node_modules/plain/@foo/file.js"]) expect(windowsOverlayPath(path)).toBe(false);
});

test("overlay manifest and merged installer payload use same source version and exact updater schema", async () => {
  const options = await fixture();
  try {
    const before = await desktopSourceDigest(options.source);
    const result = await prepareWindowsPayload(options);
    expect(result.manifest.sourceDigest).toBe(before);
    expect(result.manifest.sourceRevision).toBe(options.sourceRevision);
    expect(result.manifest.bootstrapProtocol).toBe(2);
    expect(parseDesktopManifest(result.manifest, "9.9.9")).toEqual(result.manifest);
    expect(await validatePublicDesktopOverlay(result.overlay, "9.9.9", before)).toEqual(result.manifest);
    await expect(validateDesktopPayload(result.merged, "9.9.9", before)).rejects.toThrow();
    expect(await Bun.file(join(result.merged, "runtime/bun.exe")).exists()).toBe(false);
    expect(result.installerAudit.noKnownRuntimeBytes).toBe(true);
    expect(await desktopSourceDigest(result.merged)).toBe(before);
    expect(result.manifest.files.every(file => windowsOverlayPath(file.path) || file.path === "runtime/bun.exe")).toBe(true);
    expect(result.manifest.files.some(file => file.path === "package.json")).toBe(false);
    expect(result.manifest.files.some(file => file.path === "desktop/windows-app/Orbit.Launcher.exe")).toBe(true);
    expect(await readFile(join(result.merged, "desktop/panel.py"), "utf8")).toBe("owned-linux-panel");
    expect(await readFile(join(result.merged, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8")).toBe("{}");
    expect(JSON.parse(await readFile(join(result.overlay, WINDOWS_MANIFEST), "utf8"))).toEqual(result.manifest);
    await expect(prepareWindowsPayload(options)).rejects.toThrow();
  } finally { await rm(options.root, { recursive: true, force: true }); }
});

test("public overlay carries the exact sealed dependency tree and rejects changed dependency bytes", async () => {
  const options = await fixture();
  try {
    const result = await prepareWindowsPayload(options);
    expect(result.manifest.files.some(file => file.path === DEPENDENCY_INVENTORY)).toBe(true);
    const entries = parseWindowsDependencies(await readFile(join(result.overlay, DEPENDENCY_INVENTORY), "utf8"));
    expect(entries.map(entry => entry.path)).toEqual(["node_modules/@modelcontextprotocol/sdk/package.json"]);
    expect(await readFile(join(result.overlay, entries[0]!.path), "utf8")).toBe("{}");
    await writeFile(join(result.overlay, "node_modules/@modelcontextprotocol/sdk/package.json"), '{"changed":true}');
    await expect(validatePublicDesktopOverlay(result.overlay, "9.9.9", result.manifest.sourceDigest)).rejects.toThrow();
  } finally { await rm(options.root, { recursive: true, force: true }); }
});

test("public payload rejects renamed runtime and archive bytes, never fills the public runtime hole", async () => {
  const options = await fixture();
  try {
    const result = await prepareWindowsPayload(options);
    await writeFile(join(result.merged, "desktop/windows-app/innocent.dat"), runtimeVector.runtimeBytes);
    await expect(auditPublicWindowsPayload(result.merged, options.runtimeSource)).rejects.toThrow("renamed Bun");
    expect(runtimeDescriptorId(options.runtimeSource)).toBe(runtimeVector.descriptorId);
  } finally { await rm(options.root, { recursive: true, force: true }); }
});

test("packager rejects nested output, invalid revision and previously merged source", async () => {
  const options = await fixture();
  try {
    await expect(prepareWindowsPayload({ ...options, output: join(options.source, "output") })).rejects.toThrow();
    await expect(prepareWindowsPayload({ ...options, sourceRevision: "not-a-commit" })).rejects.toThrow();
    await writeFile(join(options.source, WINDOWS_MANIFEST), "{}");
    await expect(prepareWindowsPayload(options)).rejects.toThrow("Source package already contains a desktop overlay");
  } finally { await rm(options.root, { recursive: true, force: true }); }
});

(process.platform === "win32" ? test.skip : test)("packager rejects redirected GUI payload instead of shipping a link", async () => {
  const options = await fixture();
  try {
    await symlink(options.bun, join(options.publishedDesktop, "redirected.dll"));
    await expect(prepareWindowsPayload(options)).rejects.toThrow("Redirected Windows payload refused");
  } finally { await rm(options.root, { recursive: true, force: true }); }
});

test("desktop source explicitly declares native GUI, fixed bridge, prerequisites and no signing/control claim", async () => {
  const project = await readFile(join(import.meta.dir, "../desktop/windows/Orbit.Desktop.csproj"), "utf8");
  const form = await readFile(join(import.meta.dir, "../desktop/windows/MainForm.cs"), "utf8");
  const ui = await readFile(join(import.meta.dir, "../desktop/windows/ui/index.html"), "utf8");
  const installer = await readFile(join(import.meta.dir, "../packaging/windows/Orbit.iss"), "utf8");
  const workflow = await readFile(join(import.meta.dir, "../.github/workflows/windows-desktop.yml"), "utf8");
  expect(project).toContain("<OutputType>WinExe</OutputType>"); expect(project).toContain("net10.0-windows");
  expect(form).toContain("CoreWebView2PermissionState.Deny"); expect(form).toContain("args.Source != AppOrigin");
  expect(ui).toContain("Application control is not available on Windows yet"); expect(ui).toContain("unsigned");
  expect(installer).toContain("PrivilegesRequired=lowest"); expect(installer).toContain("Orbit.RuntimeBootstrap.exe");
  expect(installer).toContain("ACCEPTBUNRUNTIMEDOWNLOAD"); expect(installer).toContain("BUNRUNTIMEARCHIVE");
  expect(installer).not.toContain("orbit-offline-payload\\runtime\\bun.exe");
  expect(installer).toContain("--automatic-updates"); expect(installer).toContain("CloseApplications=no");
  expect(workflow).toContain("workflow_dispatch"); expect(workflow).not.toContain("contents: write");
  expect(workflow).not.toContain("gh release");
  const context = await readFile(join(import.meta.dir, "../desktop/windows/ReleaseContext.cs"), "utf8");
  const bridge = await readFile(join(import.meta.dir, "../desktop/windows/DesktopBridge.cs"), "utf8");
  const launcher = await readFile(join(import.meta.dir, "../packaging/windows/OrbitLauncher.cs"), "utf8");
  const nativeSeal = await readFile(join(import.meta.dir, "../packaging/windows/PreparedRelease.cs"), "utf8");
  const managedSeal = await readFile(join(import.meta.dir, "../src/managed-identity.ts"), "utf8");
  const nativeInputs = nativeSeal.match(/Inputs = [{]([^}]+)[}]/)?.[1]?.match(/"[^"]+"/g)?.map(value => JSON.parse(value));
  const managedInputJson = managedSeal.match(/const inputs = (.+);/)?.[1];
  const managedInputs = managedInputJson ? JSON.parse(managedInputJson) : undefined;
  expect(nativeInputs).toHaveLength(15);
  expect(nativeInputs).toEqual(managedInputs);
  expect(context.indexOf("PreparedRelease.Attest")).toBeLessThan(context.indexOf("Process.Start(start)"));
  expect(context).toContain('SamePath(answer, "root", ManagedRoot)');
  expect(context).toContain('SamePath(answer, "directory", SourceRoot)');
  expect(bridge.indexOf("release.VerifyAsync")).toBeLessThan(bridge.indexOf("Process.Start(start)"));
  expect(bridge).toContain('command == "connector-config" ? "connector-config.ts" : "cli.ts"');
  expect(bridge).toContain('start.Environment["ORBIT_LAUNCHER"] = Path.Combine(release.ManagedRoot, "bin", "sbar-orbit.cmd")');
  expect(ui).toContain('data-command="connector-config"');
  expect(launcher.indexOf("PreparedRelease.Attest")).toBeLessThan(launcher.indexOf("var verified = Verify"));
  expect(launcher).toContain('args.Length == 4 && args[2] == "serve" && args[3] == "--managed-socket"');
  expect(launcher).toContain("KillOwnedVerifierTree");
  expect(installer).toContain("function PrepareToInstall");
  expect(installer).toContain("dontcopy noencryption");
  expect(installer).not.toContain("ssPostInstall");
  expect(installer).toContain("UninstallFilesDir={localappdata}");
  expect(installer).toContain("DefaultDirName={localappdata}\\sbar-orbit\\managed");
  const acceptance = await readFile(join(import.meta.dir, "../scripts/windows-desktop-acceptance.ts"), "utf8");
  const build = await readFile(join(import.meta.dir, "../packaging/windows/build.ps1"), "utf8");
  expect(acceptance).toContain('process.env.GITHUB_ACTIONS === "true"');
  expect(acceptance).toContain('actual MCP transport must be mapped'.replace('actual', 'Actual'));
  expect(acceptance).toContain('[activationHost, "--cli", root, "update", "activate", candidate]');
  expect(acceptance).toContain('"--cli", root, "update", "activate", rollback');
  expect(acceptance).toContain('await client.ping()');
  expect(acceptance).toContain('sameInitializedStreamPing: true');
  expect(acceptance).toContain('allRelativeRuntimeModulesBundled: true');
  expect(acceptance).not.toContain('platform: "win32", run:');
  expect(acceptance).not.toContain('healthy: async');
  expect(workflow.indexOf('-Phase Probe')).toBeLessThan(workflow.indexOf('actions/setup-dotnet'));
  expect(build).toContain('vendorRedistributionReview');
  expect(build).toContain('Owned build disk reserve unavailable');
  expect(build).toContain('/main:Orbit.Shared.RuntimeBootstrap');
  expect(build).toContain('dependency-should-not-execute.txt');
  expect(build).toContain('versionedUpdaterNativeRefused');
  expect(acceptance).toContain('nativeVersionedHost: true');
  const prepared = await readFile(join(import.meta.dir, "../packaging/windows/PreparedRelease.cs"), "utf8");
  expect(prepared).toContain("VerifyDependencies(directory);");
  expect(prepared).toContain("Dependency hard link refused");
  expect(prepared).toContain("Unknown or empty dependency directory");
  expect(build).toContain('/define:NETFRAMEWORK');
  expect(build).not.toContain('bun build --compile');
  const pins = JSON.parse(await readFile(join(import.meta.dir, "../desktop/windows/build-pins.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(import.meta.dir, "../desktop/windows/packages.lock.json"), "utf8"));
  expect(pins.webView2.nugetContentHash).not.toBe(pins.webView2.sha512);
  expect(lock.dependencies["net10.0-windows7.0"]["Microsoft.Web.WebView2"].contentHash).toBe(pins.webView2.nugetContentHash);
  expect(parseRuntimeSource(pins.runtimeSource).executableSha256).toBe("cb1d8e6564e655e49d30cead359750a1cbbd12f42651caa4b62244d7bd93c244");
  const native = await readFile(join(import.meta.dir, "../packaging/windows/RuntimeSource.cs"), "utf8");
  expect(native).toContain("Explicit upstream download consent");
  expect(native).toContain("Runtime ZIP member overlap");
  expect(native).toContain("Runtime executable digest/CRC differs");
});
