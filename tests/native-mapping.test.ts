import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("native mapping accepts the exact file on its actual filesystem and refuses replacement or extras", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_mapping_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 8 tests");
  expect(err).toContain("OK");
}, 15_000);
