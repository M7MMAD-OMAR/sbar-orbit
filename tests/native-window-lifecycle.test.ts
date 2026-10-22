import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("new same-client windows inherit floating geometry and handback restores their original rules", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_window_lifecycle_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 15_000);
