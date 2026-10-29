import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the settings page is drawn by the GTK desktop panel's module, which exists on Linux only");
import { resolve } from "node:path";

/**
 * `desktop/panel_settings.py` is rendered in a compositor for its frames; what is checked here is the part
 * that must hold without one: it imports with no display, it renders from the one schema, search answers
 * both languages, validation messages reach the row, and every word the page owns exists in both languages.
 */
async function python(code: string) {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], {
    env: { PATH: process.env.PATH ?? "", PYTHONPATH: resolve("desktop"), HOME: process.env.HOME ?? "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited !== 0) throw new Error(`python failed: ${err.trim().split("\n").at(-1)}`);
  return JSON.parse(out || "null");
}

test("the page module imports with no display and no GTK in play", async () => {
  const result = await python(`import json, sys, panel_settings as p
print(json.dumps({"gtk": "gi" in sys.modules, "build": callable(p.build_settings_page)}))`);
  expect(result.build).toBe(true);
  expect(result.gtk).toBe(false);
});

test("the page groups the schema's own settings, in the page's language", async () => {
  const out = await python(`import json, orbit_settings as s, panel_settings as p
print(json.dumps({
  "all": [[g, [e["key"] for e in es]] for g, es in p.grouped("", "en")],
  "ar": [g for g, _ in p.grouped("", "ar")],
  "covered": sorted(e["key"] for _, es in p.grouped("", "en") for e in es) == sorted(e["key"] for e in s.SCHEMA),
}))`);
  expect(out.covered).toBe(true);
  expect(out.all[0][0]).toBe("Startup");
  expect(out.ar[0]).toBe("بدء التشغيل");
});

test("search answers an Arabic word and an English word with the schema's own matching", async () => {
  const out = await python(`import json, panel_settings as p
keys = lambda q, l: [e["key"] for _, es in p.grouped(q, l) for e in es]
print(json.dumps({"glowAr": keys("توهج", "ar"), "glowEn": keys("glow", "en"), "edgeAr": keys("حافة", "ar"),
  "none": keys("zzzz", "en"), "bootEn": keys("boot", "en")}))`);
  expect(out.glowAr).toEqual(["frame", "framePulse", "frameColor"]);
  expect(out.glowEn).toEqual(expect.arrayContaining(["frame", "framePulse", "frameColor"]));
  expect(out.edgeAr).toContain("edge");
  expect(out.none).toEqual([]);
  expect(out.bootEn).toEqual(["autostart"]);
});

test("each setting says when it applies, and only the glow settings wait for a handoff", async () => {
  const out = await python(`import json, orbit_settings as s, panel_settings as p
print(json.dumps({"handoff": [e["key"] for e in s.SCHEMA if e["applies"] == "handoff"],
  "en": p.applies_text(s.BY_KEY["frameColor"], "en"), "now": p.applies_text(s.BY_KEY["size"], "en"),
  "ar": p.applies_text(s.BY_KEY["frame"], "ar"), "described": s.describe(s.BY_KEY["framePulse"], s.defaults())["applies"]}))`);
  expect(out.handoff).toEqual(["frame", "framePulse", "frameColor"]);
  expect(out.en).toBe("Applies at the next handoff");
  expect(out.now).toBe("Applies now");
  expect(out.ar).toBe("يسري عند التسليم التالي");
  expect(out.described).toBe("handoff");
});

test("validation speaks through the schema's own coerce, so a page and a terminal agree", async () => {
  const out = await python(`import json, panel_settings as p
print(json.dumps({"big": p.validate_text("size", 999), "bad": p.validate_text("edge", "diagonal"),
  "ok": p.validate_text("blend", "60"), "hexBad": p.hex_message("#12zz99", "en"), "hexGood": p.hex_message("#00a86b", "en"),
  "accent": p.hex_message("accent", "en"), "hexAr": p.hex_message("red", "ar")}))`);
  expect(out.big).toEqual([40, "size was clamped to 40, its range is 6 to 40."]);
  expect(out.bad[0]).toBeNull();
  expect(out.bad[1]).toContain("one of left, right, top, bottom");
  expect(out.ok).toEqual([60, null]);
  expect(out.hexBad).toContain("#12zz99");
  expect(out.hexGood).toBeNull();
  expect(out.accent).toBeNull();
  // An Arabic sentence carries the colour format isolated left to right so the hash does not wander.
  expect(out.hexAr).toContain("⁦#rrggbb⁩");
});

test("a value written through the page's path is what the schema loads back", async () => {
  const out = await python(`import json, os, tempfile, orbit_settings as s
d = tempfile.mkdtemp(); path = os.path.join(d, "panel.json")
settings, _ = s.load(path)
settings["size"], note = s.coerce("size", 22)
settings["colors"] = s.coerce("colors", {**settings["colors"], "working": "#00a86b"})[0]
print(json.dumps({"failure": s.save(settings, path), "loaded": s.load(path)[0], "mode": oct(os.stat(path).st_mode & 0o777)}))`);
  expect(out.failure).toBeNull();
  expect(out.loaded.size).toBe(22);
  expect(out.loaded.colors.working).toBe("#00a86b");
  expect(out.mode).toBe("0o600");
});

test("every word the page owns exists in both languages, and the schema's Arabic covers every row", async () => {
  const out = await python(`import json, orbit_settings as s, panel_settings as p
print(json.dumps({"sameKeys": sorted(p.UI["en"]) == sorted(p.UI["ar"]),
  "noArabicRow": [e["key"] for e in s.SCHEMA if not all(e[f] in s.ARABIC for f in ("group", "label", "description"))],
  "noChoice": [c for e in s.SCHEMA for c in (e["choices"] or ()) if c != "accent" and c not in p.CHOICES_AR],
  "noState": [k for k in s.STATE_KEYS if k not in p.CHOICES_AR]}))`);
  expect(out.sameKeys).toBe(true);
  expect(out.noArabicRow).toEqual([]);
  expect(out.noChoice).toEqual([]);
  expect(out.noState).toEqual([]);
});

test("the page carries no long dash and no Arabic-Indic digit", async () => {
  const source = await Bun.file(resolve("desktop/panel_settings.py")).text();
  expect(source).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  expect(source).not.toMatch(new RegExp("[" + String.fromCharCode(0x660) + "-" + String.fromCharCode(0x669) + "]"));
});
