import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("bounded helper receipt owned pipe and child fixtures", async () => {
  // Synthetic record fixtures, not actual compositor teardown/sync or provider qualification.
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_reader_receipt_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 29 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 10000);
