import { test, expect } from "bun:test";
import { parseViewport, requireInside, viewportLimits, defaultViewport } from "../src/viewport";
import { parseAction } from "../src/browser";
import { parseNativeAction } from "../src/fedora";

test("a surface is whole pixels inside the documented limits", () => {
  expect(parseViewport({ width: 1600, height: 1000 })).toEqual({ width: 1600, height: 1000 });
  for (const size of [{ width: 0, height: 800 }, { width: 1280.5, height: 800 }, { width: 1280, height: "800" },
    { width: viewportLimits.minimum - 1, height: 800 }, { width: viewportLimits.maximum + 1, height: 800 }])
    expect(() => parseViewport(size)).toThrow(/whole number of pixels/);
});

test("the cap is on total pixels, so an unusual shape is allowed and a huge surface is not", () => {
  expect(parseViewport({ width: 2400, height: 900 })).toEqual({ width: 2400, height: 900 });
  expect(() => parseViewport({ width: 3840, height: 2160 })).toThrow(/capped at/);
  expect(parseViewport({ width: 1920, height: 1200 })).toEqual({ width: 1920, height: 1200 });
  expect(() => parseViewport({ width: 1920, height: 1201 })).toThrow(/capped at/);
});

test("coordinates are checked against the session surface rather than a fixed size", () => {
  expect(requireInside({ width: 1920, height: 1080 }, 1500, 900)).toEqual({ x: 1500, y: 900 });
  expect(() => requireInside(defaultViewport, 1500, 900)).toThrow(/1280 by 800/);
  expect(() => requireInside({ width: 1920, height: 1080 }, -1, 10)).toThrow(/outside the session surface/);
  expect(() => requireInside({ width: 1920, height: 1080 }, Number.NaN, 10)).toThrow(/outside the session surface/);
});

test("both backends accept a resize action and bound input by the size they are given", () => {
  expect(parseAction({ type: "resize", width: 1600, height: 1000 })).toEqual({ type: "resize", width: 1600, height: 1000 });
  expect(parseNativeAction({ type: "resize", width: 1600, height: 1000 })).toEqual({ type: "resize", width: 1600, height: 1000 });

  const large = { width: 1920, height: 1080 };
  expect(parseNativeAction({ type: "pointer", x: 1500, y: 900 }, large)).toEqual({ type: "pointer", x: 1500, y: 900 });
  expect(() => parseNativeAction({ type: "pointer", x: 1500, y: 900 })).toThrow(/1280 by 800/);
  expect(parseAction({ type: "scroll", x: 1500, y: 900, deltaY: 2 }, large)).toMatchObject({ type: "scroll", x: 1500 });
  expect(() => parseAction({ type: "scroll", x: 1500, y: 900, deltaY: 2 })).toThrow(/1280 by 800/);
});

test("native window commands are a fixed list and their target is a reported window number", () => {
  expect(parseNativeAction({ type: "window", command: "fullscreen" })).toEqual({ type: "window", command: "fullscreen" });
  expect(parseNativeAction({ type: "window", command: "focus", tab: 3 })).toEqual({ type: "window", command: "focus", tab: 3 });
  expect(() => parseNativeAction({ type: "window", command: "kill" })).toThrow(/fullscreen, restore, focus, close/);
  expect(() => parseNativeAction({ type: "window", command: "focus", tab: 0 })).toThrow(/1-based number/);
});
