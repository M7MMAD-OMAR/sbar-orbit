import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("original opening outcomes qualify process and geometry evidence without native calls", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_opening_outcomes_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 10000);
