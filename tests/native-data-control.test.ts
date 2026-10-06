import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("native data-control admission rejects unavailable devices and clients", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_data_control_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 35_000);
