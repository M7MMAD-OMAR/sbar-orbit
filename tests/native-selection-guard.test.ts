import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("native selection stays private through membership revocation and device recreation", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_selection_guard_test.py")],
    { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output }).toEqual({ code: 0, output: "" });
  expect(error).toContain("Ran 8 tests");
}, 45_000);
