import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("fixed protected channel client real owned process and listener fixtures", async () => {
  // Real SO_PEERPIDFD/SO_PEERCRED, but no production broker/conversation or app enrollment.
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_read_channel_client_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 27 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 20000);
