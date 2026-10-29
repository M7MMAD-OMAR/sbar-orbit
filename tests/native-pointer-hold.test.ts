import { expect, test } from "bun:test";
import { join } from "node:path";
import { orbitActionSchema } from "../src/mcp";
import { classify } from "../src/policy";

const target = { appId: "a".repeat(32), windowId: "b".repeat(32) };

(process.platform === "linux" ? test : test.skip)("press, hold, release and drag parse and transport as strict native actions", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_pointer_hold_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 30000);

test("the action schema accepts the new pointer actions and nothing extra", () => {
  expect(orbitActionSchema.parse({ type: "mouse-down", ...target, x: 1, y: 2 })).toMatchObject({ type: "mouse-down" });
  expect(orbitActionSchema.parse({ type: "mouse-up", ...target, x: 1, y: 2, button: "right" })).toMatchObject({ type: "mouse-up" });
  expect(orbitActionSchema.parse({ type: "drag", ...target, x: 1, y: 2, toX: 30, toY: 40 })).toMatchObject({ type: "drag" });
  expect(orbitActionSchema.safeParse({ type: "drag", ...target, x: 1, y: 2 }).success).toBe(false);
  expect(orbitActionSchema.safeParse({ type: "mouse-down", ...target, x: 1, y: 2, toX: 3 }).success).toBe(false);
});

test("the new pointer actions are written actions, not silently trusted as reads", () => {
  for (const type of ["mouse-down", "mouse-up", "drag"]) expect(classify(type)).toBe("write");
});

test("the plugin releases a held button on every end of a hold", async () => {
  const source = await Bun.file(join(import.meta.dir, "../experiments/ghost-cursor/plugin/ghostinput.cpp")).text();
  // returnClientPointer is the one exit used by owner input, handback, release and the hold timeout.
  const exit = source.slice(source.indexOf("static void returnClientPointer"), source.indexOf("static void returnClientKeyboard"));
  expect(exit).toContain("WL_POINTER_BUTTON_STATE_RELEASED");
  const unload = source.slice(source.indexOf("PLUGIN_EXIT"));
  expect(unload).toContain("WL_POINTER_BUTTON_STATE_RELEASED");
  expect(source).toContain("hoverHold = std::chrono::seconds(15)");
});
