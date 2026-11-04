import { expect, test } from "bun:test";
import { reportSucceeded, summarizeTestResult } from "../scripts/platform-test-report";

const passed = " 2 pass\n 0 fail\n";

test("accepts passing and explicitly skipped test summaries", () => {
  expect(summarizeTestResult(0, false, passed)).toEqual({ pass: 2, fail: 0, skip: 0, status: "passed" });
  expect(summarizeTestResult(0, false, " 0 pass\n 3 skip\n 0 fail\n")).toEqual({ pass: 0, fail: 0, skip: 3, status: "skipped" });
  expect(summarizeTestResult(0, false, " 2 pass\n 1 skip\n 0 fail\n").status).toBe("passed");
});

test("rejects failed exits, reported failures, and timeouts", () => {
  expect(summarizeTestResult(1, false, passed).status).toBe("failed");
  expect(summarizeTestResult(null, false, "").status).toBe("failed");
  expect(summarizeTestResult(0, false, " 1 pass\n 1 fail\n").status).toBe("failed");
  expect(summarizeTestResult(0, true, passed).status).toBe("timeout");
});

test("rejects missing, duplicate, invalid and no-test summaries", () => {
  for (const output of ["", " 2 pass\n", " 0 pass\n 0 fail\n", " 1 pass\n 1 pass\n 0 fail\n",
    " 9007199254740992 pass\n 0 fail\n", " 1 pass\n 1 skip\n 1 skip\n 0 fail\n",
    " 1 pass\n NaN skip\n 0 fail\n", " 1 pass\n -1 skip\n 0 fail\n"]) {
    expect(summarizeTestResult(0, false, output).status).toBe("invalid");
  }
});

test("report success requires selected files and every file passing", () => {
  expect(reportSucceeded([])).toBe(false);
  expect(reportSucceeded([{ status: "passed" }])).toBe(true);
  expect(reportSucceeded([{ status: "skipped" }])).toBe(true);
  for (const status of ["failed", "timeout", "invalid"] as const) {
    expect(reportSucceeded([{ status: "passed" }, { status }])).toBe(false);
  }
});

test("report command returns nonzero after writing an empty selection report", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "orbit-report-test-"));
  try {
    const child = Bun.spawn([process.execPath, "run", "scripts/platform-test-report.ts", "fixture"], {
      env: { ...process.env, ORBIT_TEST_FILTER: "^no_such_test_file$", ORBIT_TEST_REPORT_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(err).toContain("No matching test files");
    expect(out).toContain("0 passed, 0 skipped, 0 failed files");
    const report = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    expect(report.error).toBe("No matching test files");
    expect(report.results).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report command preserves a real failed file and exits nonzero", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "orbit-report-fixture-"));
  try {
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "owned-failure.test.ts"), 'import { test, expect } from "bun:test"; test("intentional fixture failure", () => expect(1).toBe(2));\n');
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("../scripts/platform-test-report.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "run", script, "fixture"], {
      env: { ...process.env, ORBIT_TEST_ROOT: root, ORBIT_TEST_REPORT_DIR: join(root, "reports"), ORBIT_TEST_FILTER: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(out).toContain("FAIL owned-failure.test.ts");
    expect(err).toBe("");
    const report = JSON.parse(await readFile(join(root, "reports", "fixture.json"), "utf8"));
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ file: "owned-failure.test.ts", status: "failed", fail: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
