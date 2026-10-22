import { expect, test } from "bun:test";
import { join } from "node:path";

test("floating placement respects custom size, scaled monitor work areas and measured bounds", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_window_geometry_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stdout, stderr, code }).toMatchObject({ stdout: "", code: 0 });
  expect(stderr).toContain("Ran 7 tests");
  expect(stderr).toContain("OK");
});
