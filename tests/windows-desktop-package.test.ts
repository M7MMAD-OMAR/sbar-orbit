import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWindowsPayload, windowsDesktopArtifactName, windowsOverlayPath, WINDOWS_MANIFEST } from "../scripts/package-windows";
import { desktopSourceDigest, parseDesktopManifest, validateDesktopPayload } from "../src/windows-desktop-update";
import { fixtureVersions } from "../scripts/windows-desktop-acceptance";

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
    "src/windows-desktop-update.ts": "owned-overlay", "scripts/limited.ts": "owned-budget",
    "bin/sbar-orbit.cmd": "owned-source-launcher", "bin/sbar-orbit": "owned-posix-launcher",
    "node_modules/@modelcontextprotocol/sdk/package.json": "{}", "desktop/panel.py": "owned-linux-panel",
  };
  for (const [path, value] of Object.entries(files)) { await mkdir(join(source, path, ".."), { recursive: true }); await writeFile(join(source, path), value); }
  for (const [path, value] of Object.entries({ "Orbit.Desktop.exe": "MZ-owned-exe-fixture", "Orbit.Desktop.dll": "owned-dll", "ui/index.html": "Owned UI" })) {
    await mkdir(join(publishedDesktop, path, ".."), { recursive: true }); await writeFile(join(publishedDesktop, path), value);
  }
  const bun = join(root, "bun.exe"), launcher = join(root, "Orbit.Launcher.exe");
  await writeFile(bun, "MZ-owned-runtime-fixture"); await writeFile(launcher, "MZ-owned-launcher-fixture");
  return { root, source, publishedDesktop, output, bun, launcher, sourceRevision: "a".repeat(40) };
}

test("Windows artifact names and overlay paths cannot escape or collide with source", () => {
  expect(windowsDesktopArtifactName("9.9.9")).toBe("sbar-orbit-9.9.9-windows-x64-desktop.zip");
  for (const version of ["", "../9.9.9", "9.9.9/other", "9.9", "9.9.9--", "9.9.9\n"]) expect(() => windowsDesktopArtifactName(version)).toThrow();
  for (const path of ["runtime/bun.exe", "desktop/windows-app/Orbit.Desktop.exe", "desktop/windows-app/ui/index.html"]) expect(windowsOverlayPath(path)).toBe(true);
  for (const path of ["src/cli.ts", "desktop/panel.py", "runtime/other.exe", "../runtime/bun.exe", "desktop/windows-app/../bad", "desktop/windows-app/CON", "desktop/windows-app/bad.", "desktop/windows-app/x:stream"]) expect(windowsOverlayPath(path)).toBe(false);
});

test("overlay manifest and merged installer payload use same source version and exact updater schema", async () => {
  const options = await fixture();
  try {
    const before = await desktopSourceDigest(options.source);
    const result = await prepareWindowsPayload(options);
    expect(result.manifest.sourceDigest).toBe(before);
    expect(result.manifest.sourceRevision).toBe(options.sourceRevision);
    expect(result.manifest.bootstrapProtocol).toBe(1);
    expect(parseDesktopManifest(result.manifest, "9.9.9")).toEqual(result.manifest);
    expect(await validateDesktopPayload(result.merged, "9.9.9", before)).toEqual(result.manifest);
    expect(await desktopSourceDigest(result.merged)).toBe(before);
    expect(result.manifest.files.every(file => windowsOverlayPath(file.path))).toBe(true);
    expect(result.manifest.files.some(file => file.path === "package.json")).toBe(false);
    expect(result.manifest.files.some(file => file.path === "desktop/windows-app/Orbit.Launcher.exe")).toBe(true);
    expect(await readFile(join(result.merged, "desktop/panel.py"), "utf8")).toBe("owned-linux-panel");
    expect(await readFile(join(result.merged, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8")).toBe("{}");
    expect(JSON.parse(await readFile(join(result.overlay, WINDOWS_MANIFEST), "utf8"))).toEqual(result.manifest);
    await expect(prepareWindowsPayload(options)).rejects.toThrow();
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
  expect(installer).toContain("PrivilegesRequired=lowest"); expect(installer).toContain("windows-managed-install.ts");
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
  expect(acceptance).toContain('activateVersion(candidate, { root })');
  expect(acceptance).toContain('activateVersion(rollback, { root })');
  expect(acceptance).toContain('await client.ping()');
  expect(acceptance).toContain('sameInitializedStreamPing: true');
  expect(acceptance).toContain('allRelativeRuntimeModulesBundled: true');
  expect(acceptance).not.toContain('platform: "win32", run:');
  expect(acceptance).not.toContain('healthy: async');
  expect(workflow.indexOf('-Phase Probe')).toBeLessThan(workflow.indexOf('actions/setup-dotnet'));
  expect(build).toContain('vendorRedistributionReview');
  expect(build).toContain('Owned build disk reserve unavailable');
});
