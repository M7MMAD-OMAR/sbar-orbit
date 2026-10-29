import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("settled capture waits for a changed frame and reports every outcome", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_settle_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 13 tests");
  expect(stderr).toContain("OK");
}, 10_000);
