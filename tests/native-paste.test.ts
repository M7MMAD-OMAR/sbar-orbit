import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("untypeable text is pasted through a restored shared clipboard", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_paste_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
  const session = await Bun.file(join(import.meta.dir, "../src/native/session.py")).text();
  expect(session).toContain("except UnsupportedText:");
  expect(session).toContain("paste_text(self.plan");
}, 30000);
