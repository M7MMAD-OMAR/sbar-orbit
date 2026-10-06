import { lstat, mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function within(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
export async function bundleInventory(root: string) {
  const canonical = await realpath(root);
  const files: Record<string, { kind: string; mode: number; bytes?: number; sha256?: string; target?: string }> = {};
  let bytes = 0, regularFiles = 0, directories = 0, links = 0;
  async function walk(path: string) {
    const info = await lstat(path), key = relative(root, path) || ".", mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !within(canonical, await realpath(path))) throw new Error("Bundle link escapes owned inventory");
      files[key] = { kind: "link", mode, target }; links++;
    } else if (info.isDirectory()) {
      files[key] = { kind: "directory", mode }; directories++;
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else if (info.isFile()) {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
      files[key] = { kind: "file", mode, bytes: info.size, sha256: hasher.digest("hex") };
      bytes += info.size; regularFiles++;
    } else throw new Error("Unsupported bundle resource kind");
  }
  if (!(await lstat(root)).isDirectory()) throw new Error("App bundle root must be a real directory");
  await walk(root);
  return { files, sha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(files)).digest("hex"),
    bytes, regularFiles, directories, links };
}
export function copiedDefaultArgs<T extends unknown[]>(args: T, executable: string): T {
  const options = args[2], egress = args[5];
  if (egress !== undefined && (egress === null || typeof egress !== "object" || !("tier" in egress) || egress.tier !== "in-browser") || options !== undefined && (options === null || typeof options !== "object" || "executable" in options))
    throw new Error("Controlled browser selection refuses an explicit executable or egress owner");
  const selected = [...args];
  selected[2] = { ...(options as object | undefined), executable };
  return selected as T;
}
export function captureFactoryAdapter<Owner, Args extends unknown[], Result, State>(
  original: (this: Owner, ...args: Args) => Promise<Result>, active: () => State | undefined,
  executable: (state: State) => string | undefined,
  observed: (promise: Promise<Result>, state: State, args: Args) => void,
  refused: (state: State, error: unknown) => void,
) {
  return function(this: Owner, ...args: Args): Promise<Result> {
    const state = active();
    if (state === undefined) return original.apply(this, args);
    let selected = args;
    const pinned = executable(state);
    if (pinned !== undefined) {
      try { selected = copiedDefaultArgs(args, pinned); }
      catch (error) { refused(state, error); throw error; }
    }
    const promise = original.apply(this, selected);
    try { observed(promise, state, selected); }
    catch (error) { try { refused(state, error); } catch {} }
    return promise;
  };
}
class MetadataTimeout extends Error {
  constructor(readonly ownedExitConfirmed: boolean) {
    super("Bundle metadata timed out; owned exit confirmation recorded, descendant cleanup not measured");
  }
}
async function metadata(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const collected = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([collected, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 45000); })]);
    if (result === undefined) {
      const exitWithin = async () => {
        let exitTimer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([child.exited.then(() => true, () => false), new Promise<false>(resolve => { exitTimer = setTimeout(() => resolve(false), 5000); })]); }
        finally { clearTimeout(exitTimer); }
      };
      try { child.kill("SIGTERM"); } catch {}
      let confirmed = await exitWithin();
      if (!confirmed) { try { child.kill("SIGKILL"); } catch {} confirmed = await exitWithin(); }
      throw new MetadataTimeout(confirmed);
    }
    const [stdout, stderr, exitCode] = result;
    if (exitCode) throw new Error(`Bundle metadata command failed with code ${exitCode}; stderr bytes ${Buffer.byteLength(stderr)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}
export async function macBundleInventory(root: string) {
  await metadata(["/usr/bin/codesign", "--verify", "--deep", "--strict", root]);
  const resources = await bundleInventory(root);
  const attributes = (await metadata(["/usr/bin/xattr", "-lr", root])).split(root).join("<owned-bundle>");
  const version = (await metadata(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", join(root, "Contents/Info.plist")])).trim();
  if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Signed bundle version metadata is not numeric");
  return { ...resources, version, signatureVerified: true,
    attributesSha256: new Bun.CryptoHasher("sha256").update(attributes).digest("hex") };
}
export async function prepareOwnedBundle(executable: string, temporaryRoot: string) {
  if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || process.env.ORBIT_TEST_NATIVE === "1" || !isAbsolute(temporaryRoot))
    throw new Error("Bundle copying requires an owned disposable macOS CI runner");
  if (!process.env.RUNNER_TEMP || temporaryRoot !== await realpath(process.env.RUNNER_TEMP))
    throw new Error("Copy root differs from the disposable runner temporary directory");
  const match = /^(.*\.app)\/(Contents\/MacOS\/[^/]+)$/.exec(executable);
  const originalBundle = match?.[1], executableSuffix = match?.[2];
  if (!originalBundle || !executableSuffix || resolve(executable) !== executable)
    throw new Error("Selected executable is not a complete app bundle entry point");
  const owner = await mkdtemp(join(temporaryRoot, "orbit-capture-owned-"));
  const bundle = join(owner, "ControlledChrome.app");
  try {
    const originalBefore = await macBundleInventory(originalBundle);
    await metadata(["/usr/bin/ditto", "--rsrc", "--extattr", "--acl", originalBundle, bundle]);
    const originalAfter = await macBundleInventory(originalBundle), copied = await macBundleInventory(bundle);
    if (originalBefore.sha256 !== originalAfter.sha256 || originalBefore.sha256 !== copied.sha256 ||
      originalBefore.attributesSha256 !== originalAfter.attributesSha256 || originalBefore.attributesSha256 !== copied.attributesSha256 || originalBefore.version !== copied.version || originalBefore.version !== originalAfter.version)
      throw new Error("App bundle copy resources differ or original changed while copying");
    const selected = join(bundle, executableSuffix), info = await lstat(selected);
    if (!info.isFile() || !(info.mode & 0o111)) throw new Error("Copied entry point is not an executable regular file");
    return { owner, bundle, executable: selected, originalBundle, originalBefore, copied };
  } catch (error) {
    // Retain owned files on metadata timeout because descendant cleanup is not measured.
    if (error instanceof MetadataTimeout) throw error;
    try { await rm(owner, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Copy admission and owned cleanup failed"); }
    throw error;
  }
}
