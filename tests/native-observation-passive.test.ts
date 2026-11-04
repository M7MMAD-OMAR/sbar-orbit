import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("passive native observation omits cursor refresh without claiming input quiescence", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_observation_passive_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 29 tests");
  expect(err).toContain("OK");
  expect(err).not.toContain("skipped=");
}, 10000);
