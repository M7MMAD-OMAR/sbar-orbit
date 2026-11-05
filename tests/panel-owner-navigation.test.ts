import { expect, test } from "bun:test";
import { join } from "node:path";

test("owner card click reveal is separate from passive panel updates", async () => {
  // Pure AST-extracted production methods and local fake RPC/threads, no GTK/native actions.
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "panel_owner_navigation_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 9 tests"); expect(err).toContain("OK"); expect(err).not.toContain("skipped");
}, 10000);
