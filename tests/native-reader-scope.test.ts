import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("owned reader leaf fake-kernel lifecycle and durable debt fixtures", async () => {
  // This wrapper runs only owned fake-kernel fixtures, not an actual cgroup qualification.
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_reader_scope_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 76 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 10000);

test("manual reader kernel probe help never starts Python or native work", async () => {
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "native-reader-probe-preload.ts"), join(import.meta.dir, "../experiments/reader-scope-probe.ts"), "--help"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(err).toBe("");
  expect(out).toContain("No desktop/app operations");
});

test("manual reader kernel probe mixed arguments refuse before native work", async () => {
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "native-reader-probe-preload.ts"), join(import.meta.dir, "../experiments/reader-scope-probe.ts"), "--run", "--help"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  expect(out).toBe("");
  expect(err).toContain("Use --help");
  expect(err).not.toContain("Unexpected reader helper spawn");
});
