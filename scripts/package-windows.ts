import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { desktopSourceDigest, parseDesktopManifest, safeWindowsPayloadPath, validatePublicDesktopOverlay, windowsFileDigest, MAX_EXPANDED_BYTES, MAX_ZIP_BYTES } from "../src/windows-desktop-update";
import { parseRuntimeSource, runtimeDescriptorId, type RuntimeSourceV2 } from "../src/windows-runtime-source";
import { requireResourceBudget } from "../src/resource-budget";
import { DEPENDENCY_INVENTORY, writeWindowsDependencyInventory } from "../src/windows-dependencies";

export const WINDOWS_BOOTSTRAP_PROTOCOL = 2;
export const WINDOWS_MANIFEST = "desktop-manifest.json";
export function windowsDesktopArtifactName(version: string) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version) || /[\r\n]/.test(version)) throw new Error("Invalid Windows release version");
  return "sbar-orbit-" + version + "-windows-x64-desktop.zip";
}
export function windowsOverlayPath(path: string) {
  try { safeWindowsPayloadPath(path); } catch { return false; }
  return path.startsWith("desktop/windows-app/") || path.startsWith("node_modules/");
}
async function regularFiles(root: string, directory = "", depth = 0): Promise<string[]> {
  if (depth > 32) throw new Error("Windows payload depth exceeded");
  const output: string[] = [];
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + "/" + item.name : item.name, info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error("Redirected Windows payload refused");
    if (info.isDirectory()) output.push(...await regularFiles(root, path, depth + 1));
    else if (info.isFile()) output.push(path); else throw new Error("Windows payload requires regular files");
    if (output.length > 20000) throw new Error("Windows payload file bound exceeded");
  }
  return output.sort();
}
/** Merge only directory containers; every file remains an exclusive fresh copy. */
export async function copyExclusiveTree(source: string, target: string, options: { exclude?: ReadonlySet<string>; pathPrefix?: string } = {}) {
  for (const root of [source, target]) {
    const info = await lstat(root);
    if (!isAbsolute(root) || resolve(root) !== root || !info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("Canonical regular Windows copy roots required");
  }
  const files = await regularFiles(source); let bytes = 0;
  for (const path of files) {
    if (options.exclude?.has(path.split("/")[0] ?? "")) continue;
    safeWindowsPayloadPath(options.pathPrefix ? options.pathPrefix + "/" + path : path);
    const input = join(source, path), output = join(target, path), info = await lstat(input);
    bytes += info.size;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024 || bytes > 1024 * 1024 * 1024) throw new Error("Windows copy input exceeds regular payload bounds");
    await mkdir(dirname(output), { recursive: true });
    for (let parent = dirname(output);; parent = dirname(parent)) {
      const directory = await lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(parent) !== resolve(parent)) throw new Error("Redirected Windows copy destination refused");
      if (parent === target) break;
      if (!parent.startsWith(target + sep) || dirname(parent) === parent) throw new Error("Windows copy destination escapes payload");
    }
    await copyFile(input, output, constants.COPYFILE_EXCL);
  }
}

/** Audit public source/GUI/dependencies, never a hydrated private directory. */
export async function auditPublicWindowsPayload(root: string, value: RuntimeSourceV2) {
  const source = parseRuntimeSource(value), files = await regularFiles(root);
  let total = 0;
  for (const path of files) {
    const info = await lstat(join(root, path)); total += info.size;
    if (total > 1024 * 1024 * 1024 || info.size > 256 * 1024 * 1024) throw new Error("Public Windows payload bound exceeded");
    if (path.split("/")[0]?.toLowerCase() === "runtime" || path === "runtime-source-receipt.json" || /(^|\/)bun[.]exe$/i.test(path)) throw new Error("Public Windows payload contains private runtime state");
    const digest = await windowsFileDigest(join(root, path));
    if (digest === source.executableSha256 || digest === source.archiveSha256) throw new Error("Public Windows payload contains renamed Bun bytes");
    const prefix = Buffer.from(await Bun.file(join(root, path)).slice(0, 8).arrayBuffer());
    if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) || /[.](?:zip|nupkg|tar|tgz|7z)$/i.test(path)) throw new Error("Public payload archives require a separate no-runtime audit");
    if (/[.]exe$/i.test(path) && info.size > 16 * 1024 * 1024) throw new Error("Public bootstrap must be a thin native executable, never a Bun-compiled engine");
  }
  return { schema: 2, filesChecked: files.length, bytesChecked: total, noKnownRuntimeBytes: true, noRuntimeDirectory: true, runtimeDescriptorId: runtimeDescriptorId(source) };
}
export interface WindowsPackageOptions {
  source: string; publishedDesktop: string; launcher: string; bootstrap: string; output: string; sourceRevision: string; runtimeSource: RuntimeSourceV2;
}
export async function prepareWindowsPayload(options: WindowsPackageOptions) {
  for (const path of [options.source, options.publishedDesktop, options.launcher, options.bootstrap, options.output])
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Canonical absolute Windows packaging paths required");
  if (!/^[0-9a-f]{40}$/.test(options.sourceRevision)) throw new Error("Exact source revision required");
  const inside = relative(options.source, options.output);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Error("Packaging output must be outside its source snapshot");
  const runtimeSource = parseRuntimeSource(options.runtimeSource), source = options.source;
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (pkg.name !== "sbar-orbit" || typeof pkg.version !== "string") throw new Error("Audited Orbit source package required");
  const artifactName = windowsDesktopArtifactName(pkg.version);
  const provenance = JSON.parse(await readFile(join(source, "SOURCE-COMMIT.json"), "utf8")) as Record<string, unknown>;
  if (provenance.schema !== 1 || provenance.version !== pkg.version || provenance.sourceCommit !== options.sourceRevision) throw new Error("Audited source commit does not match desktop build revision");
  for (const [path, directory] of [[source, true], [options.publishedDesktop, true], [options.launcher, false], [options.bootstrap, false]] as const) {
    const info = await lstat(path); if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Regular packaging input required");
  }
  for (const required of ["bun.lock", "src/windows-managed-install.ts", "src/windows-desktop-update.ts", "src/windows-runtime-source.ts", "src/windows-dependencies.ts", "src/cli.ts", "bin/sbar-orbit.cmd", "node_modules/@modelcontextprotocol/sdk/package.json"])
    if (!(await lstat(join(source, required))).isFile()) throw new Error("Complete offline production payload required");
  if (await Bun.file(join(source, WINDOWS_MANIFEST)).exists() || await Bun.file(join(source, "desktop/windows-app/Orbit.Desktop.exe")).exists()) throw new Error("Source package already contains a desktop overlay");
  const sourceDigest = await desktopSourceDigest(source), overlay = join(options.output, "overlay"), merged = join(options.output, "installer-payload");
  await mkdir(options.output, { recursive: true }); await mkdir(overlay); await mkdir(merged);
  await mkdir(join(overlay, "desktop/windows-app"), { recursive: true });
  await copyExclusiveTree(options.publishedDesktop, join(overlay, "desktop/windows-app"));
  await copyFile(options.launcher, join(overlay, "desktop/windows-app/Orbit.Launcher.exe"), constants.COPYFILE_EXCL);
  await copyFile(options.bootstrap, join(overlay, "desktop/windows-app/Orbit.RuntimeBootstrap.exe"), constants.COPYFILE_EXCL);
  await mkdir(join(overlay, "node_modules"));
  await copyExclusiveTree(join(source, "node_modules"), join(overlay, "node_modules"), { pathPrefix: "node_modules" });
  await writeWindowsDependencyInventory(overlay);
  const paths = (await regularFiles(overlay)).filter(path => path.startsWith("desktop/windows-app/"));
  for (const required of ["desktop/windows-app/Orbit.Desktop.exe", "desktop/windows-app/Orbit.Desktop.dll", "desktop/windows-app/Orbit.Launcher.exe", "desktop/windows-app/Orbit.RuntimeBootstrap.exe", "desktop/windows-app/ui/index.html", "desktop/windows-app/notices/bun/LICENSE.md", DEPENDENCY_INVENTORY])
    if (!paths.includes(required)) throw new Error("Published native desktop payload is incomplete");
  let total = 0; const files: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    if (!windowsOverlayPath(path)) throw new Error("Overlay collides with source inputs");
    total += (await lstat(join(overlay, path))).size; if (total > MAX_EXPANDED_BYTES) throw new Error("Desktop overlay byte bound exceeded");
    files.push({ path, sha256: await windowsFileDigest(join(overlay, path)) });
  }
  files.push({ path: "runtime/bun.exe", sha256: runtimeSource.executableSha256 });
  const manifest = parseDesktopManifest({ schema: 2, bootstrapProtocol: 2, version: pkg.version, platform: "win32", arch: "x64", sourceRevision: options.sourceRevision, sourceDigest, runtimeSource, files }, pkg.version);
  await writeFile(join(overlay, WINDOWS_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await validatePublicDesktopOverlay(overlay, pkg.version, sourceDigest);
  await copyExclusiveTree(source, merged, { exclude: new Set(["node_modules"]) }); await copyExclusiveTree(overlay, merged);
  const overlayAudit = await auditPublicWindowsPayload(overlay, runtimeSource), installerAudit = await auditPublicWindowsPayload(merged, runtimeSource);
  return { version: pkg.version, overlay, merged, artifact: join(options.output, artifactName), manifest, bytes: total, overlayAudit, installerAudit };
}
if (import.meta.main) {
  await requireResourceBudget();
  const [source, publishedDesktop, launcher, bootstrap, output, sourceRevision, descriptorFlag, descriptorPath, ...extra] = process.argv.slice(2);
  if (!source || !publishedDesktop || !launcher || !bootstrap || !output || !sourceRevision || descriptorFlag !== "--runtime-source" || !descriptorPath || extra.length) throw new Error("Use package-windows SOURCE GUI LAUNCHER NATIVE_BOOTSTRAP OUTPUT REV --runtime-source ABS_DESCRIPTOR_JSON");
  if (process.platform !== "win32") throw new Error("Native Windows packaging runs on its Windows release runner");
  const runtimeSource = parseRuntimeSource(JSON.parse(await readFile(descriptorPath, "utf8")));
  const result = await prepareWindowsPayload({ source, publishedDesktop, launcher, bootstrap, output, sourceRevision, runtimeSource });
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", resolve(import.meta.dir, "../packaging/windows/zip.ps1"), "-Source", result.overlay, "-Output", result.artifact], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Windows desktop ZIP packaging failed");
  if ((await lstat(result.artifact)).size > MAX_ZIP_BYTES) throw new Error("Desktop ZIP exceeds updater bound");
  const digest = await windowsFileDigest(result.artifact);
  await writeFile(result.artifact + ".sha256", digest + "  " + basename(result.artifact) + "\n", { flag: "wx" });
  await writeFile(result.artifact + ".build.json", JSON.stringify({ version: result.version, sha256: digest, sourceRevision, sourceDigest: result.manifest.sourceDigest,
    bootstrapProtocol: 2, runtimeSource, authenticode: "unsigned", nativeApplicationControl: "unsupported", publicationReadiness: false, ...result.overlayAudit, installerAudit: result.installerAudit }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ artifact: result.artifact, sha256: digest, installerPayload: result.merged, containsBundledRuntime: false }));
}
