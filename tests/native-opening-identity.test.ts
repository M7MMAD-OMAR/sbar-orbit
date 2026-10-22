import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("activation correlation binds exact requests and rejects unrelated or ambiguous surfaces", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_opening_identity_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output }, error).toEqual({ code: 0, output: "" });
  expect(error).toContain("Ran 5 tests");
}, 45_000);
