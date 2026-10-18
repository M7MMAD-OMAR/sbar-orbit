import { expect, test } from "bun:test";

// This is a source admission regression, not runtime compositor measurement.
// Overlay this unchanged test alone onto exact unfixed source for ordinary failure.
test("browser experiment cannot discover or spawn an ambient compositor observer", async () => {
  const source = await Bun.file(new URL("../experiments/browser.test.ts", import.meta.url)).text();
  expect(source).not.toMatch(/Bun\.which\(["']hyprctl["']\)/);
  expect(source).not.toMatch(/Bun\.spawn\(\[["']hyprctl["']/);
});
