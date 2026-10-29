import { expect } from "bun:test";
import { resolve } from "node:path";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the About page is drawn by the GTK desktop panel's module, which exists on Linux only");

async function python(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["/usr/bin/python3", ...args], {
    env: { PATH: process.env.PATH ?? "", PYTHONPATH: resolve("desktop"), HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

test("the data module is read and acted on through a fake command seam", async () => {
  const run = await python([resolve("tests/about_data_test.py")]);
  expect(run.code).toBe(0);
  expect(run.err).toContain("OK");
});

test("the page imports with no display and says every word in both languages", async () => {
  const run = await python(["-c", `
import json, panel_about as p
en, ar = set(p.UI["en"]), set(p.UI["ar"])
print(json.dumps({"missing": sorted(en ^ ar), "ar": p.language_of(None, "ar"), "lang": p.language_of(None, "fr"),
  "up": p.duration(3725, "en"), "none": p.duration(None, "en"),
  "fix": p.fix_commands({"state": "match"}), "mismatch": len(p.fix_commands({"state": "source_mismatch", "directory": "/d"}))}))`],
  { DISPLAY: "", WAYLAND_DISPLAY: "", LANG: "en_US.UTF-8", LC_ALL: "" });
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({ missing: [], ar: "ar", lang: "en", up: "1 h 2 min", none: "Not available", fix: [], mismatch: 2 });
});
