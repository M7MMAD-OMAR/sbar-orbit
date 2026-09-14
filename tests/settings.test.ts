import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The settings schema is Python, because the panel is, and it is exercised here the way everything else
 * in this repository is exercised: by running it. The alternative, a second description of the same
 * settings in TypeScript, is exactly the drift the schema exists to prevent.
 */
const SCHEMA = resolve("desktop/orbit_settings.py");

async function python(code: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], {
    env: { ...process.env, ...environment, PYTHONPATH: resolve("desktop") }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code_ = await child.exited;
  if (code_ !== 0) throw new Error(`python failed: ${err.trim().split("\n").at(-1)}`);
  return JSON.parse(out || "null");
}

async function config(args: string[], home: string) {
  const child = Bun.spawn(["/usr/bin/python3", SCHEMA, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, out: out.trim(), err: err.trim() };
}

test("a value the command line accepts is the value the panel would keep", async () => {
  // The panel used to hold this logic inline and the command line did not exist. Two validators would
  // mean a value accepted at a terminal and silently clamped on screen, which is worse than a refusal.
  const checked = await python(`import json, orbit_settings as s
print(json.dumps({
  "tooBig": s.coerce("size", 999),
  "text": s.coerce("size", "12"),
  "notANumber": s.coerce("size", "large"),
  "edge": s.coerce("edge", "LEFT"),
  "wrongEdge": s.coerce("edge", "diagonal"),
  "switchOff": s.coerce("frame", "off"),
  "switchNonsense": s.coerce("frame", "later"),
  "accent": s.coerce("frameColor", "accent"),
  "badColour": s.coerce("frameColor", "green"),
  "unknown": s.coerce("wallpaper", 1),
}))`);
  // Out of range is clamped and says so, rather than being refused or accepted silently.
  expect(checked.tooBig).toEqual([40, "size was clamped to 40, its range is 6 to 40."]);
  expect(checked.text).toEqual([12, null]);
  expect(checked.notANumber[0]).toBeNull();
  expect(checked.edge).toEqual(["left", null]);
  expect(checked.wrongEdge[0]).toBeNull();
  expect(checked.switchOff).toEqual([false, null]);
  expect(checked.switchNonsense[0]).toBeNull();
  expect(checked.accent).toEqual(["accent", null]);
  expect(checked.badColour[0]).toBeNull();
  expect(checked.unknown[1]).toContain("no setting called wallpaper");
});

test("a settings file full of nonsense still produces a panel that draws", async () => {
  const loaded = await python(`import json, orbit_settings as s
print(json.dumps(s.validate({"edge": "diagonal", "size": "huge", "position": 9, "colors": {"working": "not a colour", "idle": "#112233", "wat": "#000000"}, "motion": "yes", "unknown": 1})))`);
  expect(loaded.edge).toBe("right");
  expect(loaded.size).toBe(8);
  // Clamped rather than refused: a position outside the screen is a mark nobody can see.
  expect(loaded.position).toBe(1);
  // A good colour beside a bad one keeps the good one.
  expect(loaded.colors.idle).toBe("#112233");
  expect(loaded.colors.working).toBe("#255fce");
  expect(loaded.colors).not.toHaveProperty("wat");
  expect(loaded).not.toHaveProperty("unknown");
});

test("the search answers the word a person has in mind, not the one on the label", async () => {
  const found = await python(`import json, orbit_settings as s
print(json.dumps({q: [e["key"] for e in s.search(q)] for q in
  ["glow", "boot", "startup", "transparent", "animation", "hide", "توهج", "بدء", "شفافية", "لون", "نonsense"]}))`);
  // None of these words appears in the label of the setting they find.
  expect(found.boot).toEqual(["autostart"]);
  expect(found.startup).toEqual(["autostart"]);
  expect(found.transparent).toEqual(["blend"]);
  expect(found.animation).toEqual(expect.arrayContaining(["framePulse", "motion"]));
  expect(found.hide).toEqual(["hideWhenIdle"]);
  // Arabic finds the same settings, because the person this was built for searches in it and every
  // label in the window is English.
  expect(found["توهج"]).toEqual(["frame", "framePulse", "frameColor"]);
  expect(found["بدء"]).toEqual(["autostart"]);
  expect(found["شفافية"]).toEqual(expect.arrayContaining(["blend"]));
  expect(found["لون"].length).toBeGreaterThan(0);
  expect(found["نonsense"]).toEqual([]);
});

test("every setting is searchable, described, and reachable from the command line", async () => {
  const shape = await python(`import json, orbit_settings as s
print(json.dumps({
  "keys": [e["key"] for e in s.SCHEMA],
  "missingTerms": [e["key"] for e in s.SCHEMA if len(e["terms"]) < 4],
  "missingArabic": [e["key"] for e in s.SCHEMA if not any(any("\\u0600" <= ch <= "\\u06ff" for ch in t) for t in e["terms"])],
  "missingDescription": [e["key"] for e in s.SCHEMA if len(e["description"]) < 20],
  "unknownGroup": [e["key"] for e in s.SCHEMA if e["group"] not in s.GROUPS],
  "findsItself": [e["key"] for e in s.SCHEMA if e["key"] not in [f["key"] for f in s.search(e["key"])]],
}))`);
  // A setting nobody can find is a setting that is not there, so this is a gate rather than a report.
  expect(shape.missingTerms).toEqual([]);
  expect(shape.missingArabic).toEqual([]);
  expect(shape.missingDescription).toEqual([]);
  expect(shape.unknownGroup).toEqual([]);
  expect(shape.findsItself).toEqual([]);
  expect(shape.keys).toContain("autostart");
});

test("the command line reads and writes the same file the panel does", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-config-"));
  try {
    // Nothing written yet: the defaults answer, rather than an error about a missing file.
    expect((await config(["get", "size"], home)).out).toBe("8");
    expect((await config(["set", "size", "14"], home)).ok).toBe(true);
    expect((await config(["get", "size"], home)).out).toBe("14");

    // On disk, private, and exactly what the panel loads.
    const path = join(home, "sbar-orbit", "panel.json");
    expect(JSON.parse(await readFile(path, "utf8")).size).toBe(14);
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o600);

    // A nested colour is addressed by its own name, and a bad one is refused rather than stored.
    expect((await config(["set", "colors.working", "#ff0000"], home)).ok).toBe(true);
    expect((await config(["get", "colors.working"], home)).out).toBe('"#ff0000"');
    const refused = await config(["set", "colors.working", "red"], home);
    expect(refused.ok).toBe(false);
    expect(refused.err).toContain("#rrggbb");
    expect((await config(["get", "colors.working"], home)).out).toBe('"#ff0000"');

    // A value out of range is clamped and the clamp is printed, so nobody discovers it by looking at
    // the screen and wondering.
    const clamped = await config(["set", "size", "999"], home);
    expect(clamped.ok).toBe(true);
    expect(clamped.err).toContain("clamped to 40");
    expect((await config(["get", "size"], home)).out).toBe("40");

    // And back to where it started, one setting or all of them.
    expect((await config(["reset", "size"], home)).ok).toBe(true);
    expect((await config(["get", "size"], home)).out).toBe("8");
    expect((await config(["reset"], home)).ok).toBe(true);
    expect((await config(["get", "colors.working"], home)).out).toBe('"#255fce"');

    // An unknown setting is a refusal that names the thing, not a stack trace.
    const unknown = await config(["set", "wallpaper", "blue"], home);
    expect(unknown.ok).toBe(false);
    expect(unknown.err).toContain("no setting called wallpaper");

    // Searching from a terminal is the same index the window filters with, and exits non zero when
    // nothing matches so a script can tell.
    const search = await config(["search", "توهج"], home);
    expect(search.ok).toBe(true);
    expect(JSON.parse(search.out).map((e: { key: string }) => e.key)).toEqual(["frame", "framePulse", "frameColor"]);
    // "wallpaper" is not in any label and is in the description of the blending setting, which is the
    // behaviour this search exists for, so the empty case needs a word that is genuinely absent.
    expect(JSON.parse((await config(["search", "wallpaper"], home)).out).map((e: { key: string }) => e.key)).toEqual(["blend"]);
    expect((await config(["search", "printer"], home)).ok).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a settings file that cannot be read leaves it alone rather than overwriting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-config-broken-"));
  try {
    const path = join(home, "sbar-orbit", "panel.json");
    await mkdir(join(home, "sbar-orbit"), { recursive: true, mode: 0o700 });
    await writeFile(path, "{ this is not json");
    // The defaults are used, the person is told, and their file is still their file: a truncating write
    // here would throw away every choice they had made because of one bad character.
    const reading = await config(["get", "size"], home);
    expect(reading.out).toBe("8");
    expect(reading.err).toContain("using defaults and leaving the file alone");
    expect(await readFile(path, "utf8")).toBe("{ this is not json");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("every word the schema owns is carried in both languages", async () => {
  // The viewer renders these rather than keeping its own copy, so a label or a description added
  // without its Arabic would go quietly back to English for an Arabic reader, and nothing would fail.
  expect(await python(`
import json, orbit_settings as o
print(json.dumps([[e["key"], field] for e in o.SCHEMA for field in ("group", "label", "description") if e[field] not in o.ARABIC]))`)).toEqual([]);
  expect(await python(`
import json, orbit_settings as o
owned = {e[field] for e in o.SCHEMA for field in ("group", "label", "description")}
print(json.dumps([k for k in o.ARABIC if k not in owned]))`)).toEqual([]);
  // And each described setting carries the translation beside the English, which is what the page reads.
  const described = await python(`
import json, orbit_settings as o
print(json.dumps(o.describe(o.BY_KEY["edge"], o.defaults()), ensure_ascii=False))`) as { arabic: Record<string, string> };
  expect(described.arabic).toMatchObject({ label: "حافة الشاشة" });
});
