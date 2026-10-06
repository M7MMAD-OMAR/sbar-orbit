// Collect actual fixture results; this runner does not repair or classify capture failures.
import { mkdir, writeFile, stat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultChromeExecutable } from "../src/chrome";
import { captureTimeoutMs } from "../src/browser";
import { requireResourceBudget } from "../src/resource-budget";
import { writeCaptureArmRecord } from "./capture-diagnostic-record";
import { macBundleInventory, prepareOwnedBundle } from "./capture-browser-copy";

if (process.platform !== "darwin") throw new Error("This observation requires a disposable macOS runner");
if (process.env.ORBIT_TEST_NATIVE === "1") throw new Error("Native preparation is outside this diagnostic");
if (captureTimeoutMs() !== 3000) throw new Error("The diagnostic requires the unchanged 3000 ms capture budget");
await requireResourceBudget();
const output = join(process.cwd(), "output/macos-capture-diagnostic");
await mkdir(output, { recursive: true });
const selectedExecutable = defaultChromeExecutable();
if (!selectedExecutable) throw new Error("No selected disposable Chrome executable");
const controlled = process.env.ORBIT_CAPTURE_CONTROLLED_BROWSER === "1";
const temporaryRoot = process.env.RUNNER_TEMP;
if (controlled && !temporaryRoot) throw new Error("Missing owned CI temporary root");
const copy = controlled ? await prepareOwnedBundle(selectedExecutable, await realpath(temporaryRoot ?? "")) : undefined;
const executable: string = copy?.executable ?? selectedExecutable;
let copyRemovalSafe = false;
try {
if (copy) await writeFile(join(output, "copy-before.json"), JSON.stringify(copy, null, 2) + "\n");
const instrumentation = ["tests/capture-diagnostic.ts", "tests/capture-diagnostic.test.ts",
  "tests/mcp.test.ts", "tests/observe-policy.test.ts", "tests/preview.test.ts", "src/browser.ts", "src/chrome.ts",
  "experiments/macos-capture-diagnostic.ts", ".github/workflows/macos-capture-diagnostic.yml"];
instrumentation.push("experiments/capture-diagnostic-record.ts", "tests/capture-diagnostic-record.test.ts",
  "experiments/capture-browser-copy.ts", "tests/capture-browser-copy.test.ts");

async function command(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
    new Response(child.stderr).text(), child.exited]);
  if (exitCode) throw new Error(`Metadata command failed with code ${exitCode}, stderr bytes ${Buffer.byteLength(stderr)}`);
  return stdout;
}
async function digest(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const bytes of Bun.file(path).stream()) hasher.update(bytes);
  return hasher.digest("hex");
}
async function snapshot() {
  const tracked = (await command(["git", "ls-files", "--cached", "-z"])).split("\0").filter(Boolean);
  const paths = [...new Set([...tracked, ...instrumentation])].sort();
  const files: Record<string, { sha256: string; mode: number }> = {};
  for (const path of paths) files[path] = { sha256: await digest(path), mode: (await stat(path)).mode };
  const selected = copy ? executable : defaultChromeExecutable();
  const resources = copy ? await macBundleInventory(copy.bundle) : undefined;
  return { commit: (await command(["git", "rev-parse", "HEAD"])).trim(),
    worktree: await command(["git", "status", "--porcelain"]), files,
    productionTree: await command(["git", "ls-tree", "-r", "HEAD", "--", "src", "package.json", "bun.lock", "bunfig.toml", "scripts/limited.ts"]),
    browser: { executable, selectedMatches: selected === executable, sha256: await digest(executable),
      version: resources ? resources.version : (await command([executable, "--version"])).trim(),
      bundleSha256: resources?.sha256, attributesSha256: resources?.attributesSha256, signatureVerified: resources?.signatureVerified, resources: resources && { bytes: resources.bytes, regularFiles: resources.regularFiles, directories: resources.directories, links: resources.links } }, bun: Bun.version,
    macOS: (await command(["sw_vers"])).trim(), captureBudgetMs: captureTimeoutMs() };
}
const before = await snapshot();
await writeFile(join(output, "before.json"), JSON.stringify(before, null, 2) + "\n");
if (copy && (before.browser.bundleSha256 !== copy.copied.sha256 || before.browser.attributesSha256 !== copy.copied.attributesSha256)) throw new Error("Copied bundle changed before collection");
if (!before.browser.selectedMatches) throw new Error("Selected Chrome changed before collection");
const arms: Record<string, unknown>[] = [];
let overallExit = 0;
for (const arm of ["isolated", "full-suite"]) {
  const args = arm === "isolated" ? ["tests/mcp.test.ts", "tests/observe-policy.test.ts", "tests/preview.test.ts",
    "-t", "MCP stdio negotiates|the adapter tells|a session whose policy allows|observation stays available while"] : [];
  const argv = [process.execPath, "--smol", "run", "scripts/limited.ts", process.execPath, "--smol", "test", ...args];
  const started = performance.now();
  copyRemovalSafe = false;
  const child = Bun.spawn(argv, { env: { ...process.env, ORBIT_TEST_CAPTURE_DIAGNOSTIC: "1", ORBIT_TEST_NATIVE: "0",
    ORBIT_CAPTURE_COPY_EXECUTABLE: copy?.executable, ORBIT_CAPTURE_COPY_OWNER: copy?.owner },
    stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, arm === "isolated" ? 120000 : 900000);
  let stdout: string, stderr: string, exitCode: number;
  try { [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
  finally { clearTimeout(timer); }
  await writeFile(join(output, `${arm}.stdout.log`), stdout);
  await writeFile(join(output, `${arm}.stderr.log`), stderr);
  const events: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    try { const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && "captureDiagnostic" in value) events.push(value as Record<string, unknown>);
    } catch {}
  }
  const closed = events.filter(event => event.captureDiagnostic === "registration.closed");
  const cleanupConfirmed = !timedOut && ["mcp", "observe-policy", "preview-concurrent"].every(fixture => closed.some(event => event.fixture === fixture)) &&
    closed.every(event => event.cleanupConfirmed === true && event.invalid === false && Array.isArray(event.pending) && !event.pending.length);
  copyRemovalSafe = cleanupConfirmed;
  const identities = events.filter(event => event.captureDiagnostic === "browser.identity.bytes");
  const version = before.browser.version.match(/\d+(?:\.\d+)+/)?.[0];
  const connected = events.filter(event => event.captureDiagnostic === "browser.connected");
  const identityConfirmed = identities.length >= 3 && identities.every(event => event.executableSha256 === before.browser.sha256) &&
    connected.length >= 3 && connected.every(event => event.version === version);
  copyRemovalSafe = false;
  const after = await snapshot();
  const bundleAfter = copy ? await macBundleInventory(copy.bundle) : undefined;
  const originalAfter = copy ? await macBundleInventory(copy.originalBundle) : undefined;
  copyRemovalSafe = cleanupConfirmed;
  if (copy) await writeFile(join(output, `${arm}.copy-after.json`), JSON.stringify({ copied: bundleAfter, original: originalAfter }, null, 2) + "\n");
  await writeFile(join(output, `${arm}.after.json`), JSON.stringify(after, null, 2) + "\n");
  const sourceAndBrowserStable = JSON.stringify(before) === JSON.stringify(after);
  const sourceManifestSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(before.files)).digest("hex");
  const sourceManifestAfterSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(after.files)).digest("hex");
  const sourceChanged = sourceManifestSha256 !== sourceManifestAfterSha256 || before.commit !== after.commit ||
    before.worktree !== after.worktree || before.productionTree !== after.productionTree;
  const browserChanged = JSON.stringify(before.browser) !== JSON.stringify(after.browser);
  const invalid = timedOut || !sourceAndBrowserStable || !identityConfirmed ||
    !!copy && (bundleAfter?.sha256 !== copy.copied.sha256 || bundleAfter?.sha256 !== after.browser.bundleSha256 ||
      bundleAfter?.attributesSha256 !== copy.copied.attributesSha256 || bundleAfter?.attributesSha256 !== after.browser.attributesSha256) ||
    !events.some(event => event.captureDiagnostic === "mcp.result") ||
    events.some(event => event.captureDiagnostic === "diagnostic.invalid" || event.captureDiagnostic === "capture.budget" && event.budgetMs !== 3000);
  const armRecord = { arm, argv, exitCode, timedOut, durationMs: performance.now() - started, cleanupConfirmed,
    descendantCleanup: timedOut ? "not measured after owned launcher termination" : "fixture shutdown outcomes only; no survivor measurement",
    sourceAndBrowserStable, sourceChanged, browserChanged, identityConfirmed, invalid, events,
    selection: copy ? "owned app bundle copy" : "ordinary default",
    bundleSha256: copy?.copied.sha256, bundleAfterSha256: bundleAfter?.sha256,
    bundleAttributesSha256: copy?.copied.attributesSha256, bundleAttributesAfterSha256: bundleAfter?.attributesSha256,
    originalBundleChanged: copy ? copy.originalBefore.sha256 !== originalAfter?.sha256 || copy.originalBefore.attributesSha256 !== originalAfter?.attributesSha256 : undefined,
    bundleResourceBytes: bundleAfter?.bytes, bundleResourceFiles: bundleAfter?.regularFiles,
    bundleResourceDirectories: bundleAfter?.directories, bundleResourceLinks: bundleAfter?.links,
    sourceManifestSha256, sourceManifestAfterSha256, browserSha256: before.browser.sha256,
    browserAfterSha256: after.browser.sha256, scope: "actual instrumented fixture observations; no cause or survivor verdict" };
  arms.push(armRecord);
  try {
    writeCaptureArmRecord(armRecord, { sourceCommit: before.commit,
      sourceManifestSha256, sourceManifestAfterSha256, browserSha256: before.browser.sha256,
      browserAfterSha256: after.browser.sha256, browserVersion: version });
  } catch {}
  await writeFile(join(output, "observations.json"), JSON.stringify({ arms }, null, 2) + "\n");
  if (exitCode || invalid || !cleanupConfirmed) overallExit = exitCode || 2;
  if (timedOut || invalid || !cleanupConfirmed) {
    if (arm === "isolated") await writeFile(join(output, "full-suite-not-measured.txt"), "First-arm cleanup or provenance was not confirmed\n");
    break;
  }
}
process.exitCode = overallExit;
} finally {
  if (copy) {
    let removed = false;
    try { if (copyRemovalSafe) { await rm(copy.owner, { recursive: true, force: false }); removed = true; } }
    finally {
      await writeFile(join(output, "copy-cleanup.json"), JSON.stringify({ ownedBundleRemoved: removed, retainedForUnconfirmedCleanup: !copyRemovalSafe }) + "\n");
      console.log(JSON.stringify({ captureDiagnosticCopyCleanup: { ownedBundleRemoved: removed, retainedForUnconfirmedCleanup: !copyRemovalSafe } }));
    }
  }
}
