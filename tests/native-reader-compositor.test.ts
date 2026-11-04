import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("isolated synthetic Wayland reader lifecycle", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_reader_compositor_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 10 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 90000);
