import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { themeCss, themeCandidates, loadTheme } from "../src/theme";

test("a flat Material You palette becomes custom properties", () => {
  const css = themeCss({ surface: "#121314", on_surface: "#e3e2e2", primary: "#b9c9d0", ignored_role: "#ff0000" });
  expect(css).toContain("--surface:#121314");
  expect(css).toContain("--on-surface:#e3e2e2");
  expect(css).toContain("--primary:#b9c9d0");
  expect(css).not.toContain("ignored_role");
});

test("a nested Orbit theme file carries colours and fonts", () => {
  const css = themeCss({ colors: { surface: "#ffffff" }, fonts: { main: "Google Sans Flex", monospace: "JetBrains Mono NF" } });
  expect(css).toContain('--font-main:"Google Sans Flex",system-ui,sans-serif');
  expect(css).toContain('--font-mono:"JetBrains Mono NF",ui-monospace,monospace');
});

test("a dark surface declares a dark colour scheme and a light one does not", () => {
  expect(themeCss({ surface: "#121314" })).toContain("color-scheme:dark");
  expect(themeCss({ surface: "#f1f4f8" })).toContain("color-scheme:light");
});

test("values that are not plain colours or family names never reach the stylesheet", () => {
  const css = themeCss({
    surface: "red;}body{background:url(http://example.com/beacon.png)",
    on_surface: "var(--x)", primary: "#zzzzzz",
    colors: undefined,
  });
  expect(css).toBe("");
  const fonts = themeCss({ surface: "#121314", fonts: { main: 'Bad", url(http://example.com/f.woff2); x:"' } });
  expect(fonts).not.toContain("example.com");
  expect(fonts).not.toContain("--font-main");
});

test("input that is not a palette produces no stylesheet", () => {
  for (const value of [null, "text", 7, ["#121314"], {}]) expect(themeCss(value)).toBe("");
});

test("candidates follow the environment rather than a fixed personal path", () => {
  expect(themeCandidates({ ORBIT_THEME: "/tmp/custom.json" })).toEqual(["/tmp/custom.json"]);
  const home = "/tmp/orbit-home-fixture";
  const candidates = themeCandidates({ HOME: home, XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined });
  expect(candidates[0]).toBe(`${home}/.config/sbar-orbit/theme.json`);
  expect(candidates.every(path => path.startsWith(`${home}/`))).toBe(true);
});

test("a missing or unreadable theme leaves the shipped palette in place", async () => {
  const directory = await mkdtemp("/tmp/orbit-theme-");
  expect(await loadTheme({ ORBIT_THEME: join(directory, "absent.json") })).toBe("");
  const broken = join(directory, "broken.json");
  await writeFile(broken, "{ not json");
  expect(await loadTheme({ ORBIT_THEME: broken })).toBe("");
  const palette = join(directory, "colors.json");
  await writeFile(palette, JSON.stringify({ surface: "#121314", on_surface: "#e3e2e2" }));
  expect(await loadTheme({ ORBIT_THEME: palette })).toContain("--surface:#121314");
});

test("the viewer paints from tokens rather than fixed colours", async () => {
  const style = await Bun.file("viewer/style.css").text();
  const literals = style.replaceAll(/var\(--[a-z-]+,\s*[^)]*\)/g, "var()");
  // The agent pointer keeps fixed colours on purpose: it is drawn over arbitrary page content.
  const pointer = literals.slice(literals.indexOf("#agent-pointer{"), literals.indexOf("#agent-pointer.near-right"));
  expect(literals.replace(pointer, "")).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  expect(await Bun.file("viewer/index.html").text()).toContain('href="/theme.css"');
});
