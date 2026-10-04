import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("owner plugin preparation preserves pins and refuses changed or linked artifacts", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_plugin_bundle.py")], {
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ output, error, code }).toMatchObject({ output: "", code: 0 });
  expect(error).toContain("Ran 12 tests");
  expect(error).toContain("OK");
});
