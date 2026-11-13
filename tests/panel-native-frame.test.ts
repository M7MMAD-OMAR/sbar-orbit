import { expect } from "bun:test";
import { join } from "node:path";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("GTK frame surfaces are Linux-only");

test("native activity does not map duplicate GTK frame layers", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "panel_native_frame_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, code }, err).toEqual({ out: "", code: 0 });
  expect(err).toContain("Ran 3 tests");
  expect(err).toContain("OK");
});
