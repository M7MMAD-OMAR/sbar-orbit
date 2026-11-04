import { expect, test } from "bun:test";
import { join } from "node:path";

for (const [fixture, cases] of [
  ["native_reader_png_test.py", 28],
  ["native_reader_bootstrap_test.py", 26],
] as const) {
  (process.platform === "linux" ? test : test.skip)("fixed reader capture owned fixtures: " + fixture, async () => {
    // Generated PNGs and mocked bootstrap syscalls only, no native provider or signals.
    const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, fixture)], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
    expect(err).toContain("Ran " + cases + " tests");
    expect(err).toContain("OK");
    expect(err).not.toContain("skipped");
  }, 10000);
}
