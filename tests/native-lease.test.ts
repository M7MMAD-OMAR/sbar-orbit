import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("native unit leases reject changed invocation and foreign process identities", async () => {
  const script = join(import.meta.dir, "../experiments/ghost-cursor/native_lease_test.py");
  const child = Bun.spawn(["/usr/bin/python3", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 11 tests");
  expect(stderr).toContain("OK");
}, 15_000);
