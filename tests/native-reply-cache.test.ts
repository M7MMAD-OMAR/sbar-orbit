import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("native capture replay retains one image without consuming mutation cache budget", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_reply_cache_test.py")],
    { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output, errors: errors.includes("OK") }).toEqual({ code: 0, output: "", errors: true });
});
