import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("owned Unix listener peer qualification", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_read_peer_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 27 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 15000);
