import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("text with a character the seat keymap lacks is refused as typed, not uncertain", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_text_refusal_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
  const worker = await Bun.file(join(import.meta.dir, "../src/native/session_worker.py")).text();
  expect(worker).toContain('"TEXT_UNSUPPORTED" if isinstance(error, UnsupportedText)');
  const session = await Bun.file(join(import.meta.dir, "../src/session.ts")).text();
  expect(session).not.toMatch(/const uncertain = \[[^\]]*TEXT_UNSUPPORTED/);
  expect(session).not.toMatch(/const uncertain = \[[^\]]*TARGET_CLOSED/);
  expect(worker).toContain('"TARGET_CLOSED" if isinstance(error, TargetClosed)');
}, 30000);
