import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("private lab cleanup rejects stale PIDs and signals retained process identities", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/lab_cleanup_test.py")],
    { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output, error }).toMatchObject({ code: 0 });
  expect(error).toContain("Ran 7 tests");
});
