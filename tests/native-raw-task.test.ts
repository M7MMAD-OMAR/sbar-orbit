import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("raw task retains setup, cleanup and report storage failures", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_raw_task_test.py")],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 3 tests");
  expect(stderr).toContain("OK");
}, 15_000);
