import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux" || process.env.ORBIT_TEST_NATIVE !== "1")("native target view places the visible cursor in logical surface coordinates", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_view_test.py")],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 6 tests");
  expect(stderr).toContain("OK");
}, 10_000);
