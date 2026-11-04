import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TestResultStatus = "passed" | "failed" | "timeout" | "invalid";

export interface TestResult {
  file: string;
  exit: number | null;
  seconds: number;
  pass: number;
  fail: number;
  skip: number;
  status: TestResultStatus;
  tail: string;
}

/** Classify Bun's summary without treating missing or malformed counts as success. */
export function summarizeTestResult(exit: number | null, timedOut: boolean, text: string) {
  const count = (word: string): number | null => {
    const matches = [...text.matchAll(new RegExp(`^[ \t]*(\\d+)[ \t]+${word}[ \t]*\\r?$`, "gm"))];
    if (matches.length !== 1) return null;
    const value = Number(matches[0]?.[1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  const pass = count("pass");
  const fail = count("fail");
  // Bun can omit the skip line when no tests are skipped.
  const skip = count("skip");
  const hasSkipLine = /^[ \t]*\d+[ \t]+skip[ \t]*\r?$/m.test(text);
  let status: TestResultStatus;
  if (timedOut) status = "timeout";
  else if (exit !== 0 || (fail !== null && fail > 0)) status = "failed";
  else if (pass === null || fail === null || (hasSkipLine && skip === null) || pass + (skip ?? 0) === 0) status = "invalid";
  else status = "passed";
  return { pass: pass ?? 0, fail: fail ?? 0, skip: skip ?? 0, status };
}

/** Empty selections and every non-passing file must fail the report. */
export function reportSucceeded(results: readonly Pick<TestResult, "status">[]): boolean {
  return results.length > 0 && results.every(result => result.status === "passed");
}

/** Run serial, bounded test processes, write the complete report, then propagate failure. */
async function main() {
  const label = process.argv[2] ?? process.platform;
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(label) || label === "." || label === "..") throw new Error("Invalid report label");
  const root = process.env.ORBIT_TEST_ROOT ?? join(import.meta.dir, "..");
  const reportRoot = process.env.ORBIT_TEST_REPORT_DIR ?? join(root, "output", "platform-tests");
  let only: RegExp | undefined;
  let selectionError: string | undefined;
  try {
    only = process.env.ORBIT_TEST_FILTER ? new RegExp(process.env.ORBIT_TEST_FILTER) : undefined;
  } catch {
    selectionError = "Invalid test file filter";
  }
  const files = selectionError ? [] : (await readdir(join(root, "tests"))).filter(name => name.endsWith(".test.ts") && (!only || only.test(name))).sort();
  if (!selectionError && files.length === 0) selectionError = "No matching test files";
  const results: TestResult[] = [];
  for (const file of files) {
    const started = performance.now();
    let timedOut = false;
    let exit: number | null = null;
    let text = "";
    try {
      const child = Bun.spawn([process.execPath, "test", join("tests", file)], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        text = `${out}\n${err}`;
        exit = code;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Do not put process errors or environment values into the report.
      text = "Could not run test process";
    }
    const summary = summarizeTestResult(exit, timedOut, text);
    const record: TestResult = { file, exit, seconds: Math.round((performance.now() - started) / 100) / 10, ...summary, tail: summary.status === "passed" ? "" : text.trim().split(/\r?\n/).slice(-12).join("\n") };
    results.push(record);
    console.log(`${record.status === "passed" ? "ok  " : "FAIL"} ${file} pass=${record.pass} fail=${record.fail} skip=${record.skip} ${record.seconds}s (${record.status})`);
  }
  await mkdir(reportRoot, { recursive: true });
  await writeFile(join(reportRoot, `${label}.json`), JSON.stringify({ label, platform: process.platform, bun: Bun.version, results, ...(selectionError ? { error: selectionError } : {}) }, null, 2));
  const bad = results.filter(result => result.status !== "passed");
  console.log(`\n${results.length - bad.length}/${results.length} files green on ${label}`);
  if (selectionError) console.error(selectionError);
  for (const item of bad) console.log(`--- ${item.file}\n${item.tail}`);
  if (selectionError || !reportSucceeded(results)) process.exitCode = 1;
}

if (import.meta.main) await main();
