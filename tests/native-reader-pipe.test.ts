import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("bounded reader pipe controlled Popen and owned FIFO fixtures", async () => {
  // Controlled FIFO fixtures plus two finite owned stdlib children; no cgroup/native/stop qualification.
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_reader_pipe_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 51 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped");
}, 10000);
