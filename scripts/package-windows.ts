import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { desktopSourceDigest, parseDesktopManifest, safeWindowsPayloadPath, MAX_EXPANDED_BYTES, MAX_ZIP_BYTES } from "../src/windows-desktop-update";
import { requireResourceBudget } from "../src/resource-budget";

export const WINDOWS_BOOTSTRAP_PROTOCOL = 1;
export const WINDOWS_MANIFEST = "desktop-manifest.json";
export function windowsDesktopArtifactName(version: string) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version)) throw new Error("Invalid Windows release version");
  return "sbar-orbit-" + version + "-windows-x64-desktop.zip";
}
export function windowsOverlayPath(path: string) {
  try { safeWindowsPayloadPath(path); } catch { return false; }
  return path.startsWith("desktop/windows-app/") || path === "runtime/bun.exe";
}
async function regularFiles(root: string, directory = ""): Promise<string[]> {
  const output: string[] = [];
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + "/" + item.name : item.name;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error("Redirected Windows payload refused");
    if (info.isDirectory()) output.push(...await regularFiles(root, path));
    else if (info.isFile()) output.push(path);
    else throw new Error("Windows payload requires regular files");
    if (output.length > 4096) throw new Error("Windows payload file bound exceeded");
  }
  return output.sort();
}
export interface WindowsPackageOptions {
  source: string; publishedDesktop: string; bun: string; launcher: string; output: string; sourceRevision: string;
}
export async function prepareWindowsPayload(options: WindowsPackageOptions) {
  for (const path of [options.source, options.publishedDesktop, options.bun, options.launcher, options.output])
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Canonical absolute Windows packaging paths required");
  if (!/^[0-9a-f]{40}$/.test(options.sourceRevision)) throw new Error("Exact source revision required");
  const inside = relative(options.source, options.output);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Error("Packaging output must be outside its source snapshot");
  const source = options.source;
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (pkg.name !== "sbar-orbit" || typeof pkg.version !== "string") throw new Error("Audited Orbit source package required");
  const artifactName = windowsDesktopArtifactName(pkg.version);
  const provenance = JSON.parse(await readFile(join(source, "SOURCE-COMMIT.json"), "utf8")) as Record<string, unknown>;
  if (provenance.schema !== 1 || provenance.version !== pkg.version || provenance.sourceCommit !== options.sourceRevision)
    throw new Error("Audited source commit does not match desktop build revision");
  for (const [path, directory] of [[source, true], [options.publishedDesktop, true], [options.bun, false], [options.launcher, false]] as const) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Regular packaging input required");
  }
  for (const required of ["bun.lock", "src/windows-managed-install.ts", "src/windows-desktop-update.ts", "src/cli.ts", "bin/sbar-orbit.cmd", "node_modules/@modelcontextprotocol/sdk/package.json"])
    if (!(await lstat(join(source, required))).isFile()) throw new Error("Complete offline production payload required");
  if (await Bun.file(join(source, WINDOWS_MANIFEST)).exists() || await Bun.file(join(source, "desktop/windows-app/Orbit.Desktop.exe")).exists())
    throw new Error("Source package already contains a desktop overlay");
  const sourceDigest = await desktopSourceDigest(source);
  const overlay = join(options.output, "overlay");
  const merged = join(options.output, "installer-payload");
  await mkdir(options.output, { recursive: true });
  await mkdir(overlay); await mkdir(merged);
  await mkdir(join(overlay, "desktop/windows-app"), { recursive: true });
  await cp(options.publishedDesktop, join(overlay, "desktop/windows-app"), { recursive: true, errorOnExist: true, force: false });
  await cp(options.launcher, join(overlay, "desktop/windows-app/Orbit.Launcher.exe"), { errorOnExist: true, force: false });
  await mkdir(join(overlay, "runtime"));
  await cp(options.bun, join(overlay, "runtime/bun.exe"), { errorOnExist: true, force: false });
  const paths = await regularFiles(overlay);
  for (const required of ["desktop/windows-app/Orbit.Desktop.exe", "desktop/windows-app/Orbit.Desktop.dll", "desktop/windows-app/Orbit.Launcher.exe", "desktop/windows-app/ui/index.html", "runtime/bun.exe"])
    if (!paths.includes(required)) throw new Error("Published native desktop payload is incomplete");
  let total = 0;
  const files: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    if (!windowsOverlayPath(path)) throw new Error("Overlay collides with source inputs");
    const bytes = await readFile(join(overlay, path)); total += bytes.length;
    if (total > MAX_EXPANDED_BYTES || bytes.length > 256 * 1024 * 1024) throw new Error("Desktop overlay byte bound exceeded");
    files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = parseDesktopManifest({ schema: 1, bootstrapProtocol: WINDOWS_BOOTSTRAP_PROTOCOL, version: pkg.version,
    platform: "win32", arch: "x64", sourceRevision: options.sourceRevision, sourceDigest, files }, pkg.version);
  await writeFile(join(overlay, WINDOWS_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await cp(source, merged, { recursive: true, force: false, errorOnExist: true });
  await cp(overlay, merged, { recursive: true, force: false, errorOnExist: true });
  return { version: pkg.version, overlay, merged, artifact: join(options.output, artifactName), manifest, bytes: total };
}
if (import.meta.main) {
  await requireResourceBudget();
  const [source, publishedDesktop, bun, launcher, output, sourceRevision, ...extra] = process.argv.slice(2);
  if (!source || !publishedDesktop || !bun || !launcher || !output || !sourceRevision || extra.length)
    throw new Error("Use package-windows SOURCE PUBLISHED_DESKTOP BUN_EXE LAUNCHER_EXE OUTPUT SOURCE_REVISION");
  if (process.platform !== "win32") throw new Error("Native Windows packaging runs on its Windows release runner");
  const result = await prepareWindowsPayload({ source, publishedDesktop, bun, launcher, output, sourceRevision });
  const zipScript = resolve(import.meta.dir, "../packaging/windows/zip.ps1");
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", zipScript, "-Source", result.overlay, "-Output", result.artifact], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Windows desktop ZIP packaging failed");
  if ((await lstat(result.artifact)).size > MAX_ZIP_BYTES) throw new Error("Desktop ZIP exceeds updater bound");
  const digest = createHash("sha256").update(await readFile(result.artifact)).digest("hex");
  await writeFile(result.artifact + ".sha256", digest + "  " + basename(result.artifact) + "\n", { flag: "wx" });
  await writeFile(result.artifact + ".build.json", JSON.stringify({ schema: 1, version: result.version, sha256: digest,
    sourceRevision, sourceDigest: result.manifest.sourceDigest, bootstrapProtocol: WINDOWS_BOOTSTRAP_PROTOCOL,
    authenticode: "unsigned", nativeApplicationControl: "unsupported", buildPins: JSON.parse(await readFile(resolve(import.meta.dir, "../desktop/windows/build-pins.json"), "utf8")) }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ artifact: result.artifact, sha256: digest, installerPayload: result.merged }));
}
