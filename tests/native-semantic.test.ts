import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("semantic wire dispatch uses owned D-Bus fixtures with current admission and no replay", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_semantic_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 120_000);

(process.platform === "linux" ? test : test.skip)("semantic worker binds the exact action, identity and owner admission without replay", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_semantic_actions_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 30_000);
