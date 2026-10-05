import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("native color preference refuses foreign environments and escaped scope identities", async () => {
  const script = join(import.meta.dir, "../experiments/ghost-cursor/native_application_color_scheme_test.py");
  const child = Bun.spawn(["/usr/bin/python3", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 5 tests");
  expect(stderr).toContain("OK");
}, 15_000);
