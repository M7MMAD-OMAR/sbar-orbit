// Collect actual fixture results; this runner does not repair or classify capture failures.
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultChromeExecutable } from "../src/chrome";
import { captureTimeoutMs } from "../src/browser";
import { requireResourceBudget } from "../src/resource-budget";

if (process.platform !== "darwin") throw new Error("This observation requires a disposable macOS runner");
if (process.env.ORBIT_TEST_NATIVE === "1") throw new Error("Native preparation is outside this diagnostic");
if (captureTimeoutMs() !== 3000) throw new Error("The diagnostic requires the unchanged 3000 ms capture budget");
await requireResourceBudget();
const output = join(process.cwd(), "output/macos-capture-diagnostic");
await mkdir(output, { recursive: true });
const selectedExecutable = defaultChromeExecutable();
if (!selectedExecutable) throw new Error("No selected disposable Chrome executable");
const executable: string = selectedExecutable;
const instrumentation = ["tests/capture-diagnostic.ts", "tests/capture-diagnostic.test.ts",
  "tests/mcp.test.ts", "tests/observe-policy.test.ts", "src/browser.ts", "src/chrome.ts",
  "experiments/macos-capture-diagnostic.ts", ".github/workflows/macos-capture-diagnostic.yml"];

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
  const selected = defaultChromeExecutable();
  return { commit: (await command(["git", "rev-parse", "HEAD"])).trim(),
    worktree: await command(["git", "status", "--porcelain"]), files,
    productionTree: await command(["git", "ls-tree", "-r", "HEAD", "--", "src", "package.json", "bun.lock", "bunfig.toml", "scripts/limited.ts"]),
    browser: { executable, selectedMatches: selected === executable, sha256: await digest(executable),
      version: (await command([executable, "--version"])).trim() }, bun: Bun.version,
    macOS: (await command(["sw_vers"])).trim(), captureBudgetMs: captureTimeoutMs() };
}
const before = await snapshot();
await writeFile(join(output, "before.json"), JSON.stringify(before, null, 2) + "\n");
if (!before.browser.selectedMatches) throw new Error("Selected Chrome changed before collection");
const arms: Record<string, unknown>[] = [];
let overallExit = 0;
for (const arm of ["isolated", "full-suite"]) {
  const args = arm === "isolated" ? ["tests/mcp.test.ts", "tests/observe-policy.test.ts"] : [];
  const argv = [process.execPath, "--smol", "run", "scripts/limited.ts", process.execPath, "--smol", "test", ...args];
  const started = performance.now();
  const child = Bun.spawn(argv, { env: { ...process.env, ORBIT_TEST_CAPTURE_DIAGNOSTIC: "1", ORBIT_TEST_NATIVE: "0" },
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
  const cleanupConfirmed = !timedOut && ["mcp", "observe-policy"].every(fixture => closed.some(event => event.fixture === fixture)) &&
    closed.every(event => event.cleanupConfirmed === true && event.invalid === false && Array.isArray(event.pending) && !event.pending.length);
  const identities = events.filter(event => event.captureDiagnostic === "browser.identity.bytes");
  const version = before.browser.version.match(/\d+(?:\.\d+)+/)?.[0];
  const connected = events.filter(event => event.captureDiagnostic === "browser.connected");
  const identityConfirmed = identities.length >= 2 && identities.every(event => event.executableSha256 === before.browser.sha256) &&
    connected.length >= 2 && connected.every(event => event.version === version);
  const after = await snapshot();
  await writeFile(join(output, `${arm}.after.json`), JSON.stringify(after, null, 2) + "\n");
  const sourceAndBrowserStable = JSON.stringify(before) === JSON.stringify(after);
  const invalid = timedOut || !sourceAndBrowserStable || !identityConfirmed ||
    !events.some(event => event.captureDiagnostic === "mcp.result") ||
    events.some(event => event.captureDiagnostic === "diagnostic.invalid" || event.captureDiagnostic === "capture.budget" && event.budgetMs !== 3000);
  arms.push({ arm, argv, exitCode, timedOut, durationMs: performance.now() - started, cleanupConfirmed,
    descendantCleanup: timedOut ? "not measured after owned launcher termination" : "fixture shutdown outcomes only; no survivor measurement",
    sourceAndBrowserStable, identityConfirmed, invalid, events, scope: "actual instrumented fixture observations; no cause or survivor verdict" });
  await writeFile(join(output, "observations.json"), JSON.stringify({ arms }, null, 2) + "\n");
  if (exitCode || invalid || !cleanupConfirmed) overallExit = exitCode || 2;
  if (timedOut || invalid || !cleanupConfirmed) {
    if (arm === "isolated") await writeFile(join(output, "full-suite-not-measured.txt"), "First-arm cleanup or provenance was not confirmed\n");
    break;
  }
}
process.exitCode = overallExit;
