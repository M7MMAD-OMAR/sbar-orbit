import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("private peer-qualified one-shot handshake", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_read_channel_server_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Include Python diagnostics when a fixture fails rather than hiding its traceback.
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 17 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 30000);
