import { test, expect } from "bun:test";
import { nativeRendererFromEnv, rendererBound } from "../src/native-renderer";

const present = (path: string) => path === "/dev/dri/renderD128";

test("pixman is the default and needs no device", () => {
  expect(nativeRendererFromEnv({}, present)).toEqual({ renderer: "pixman", env: { WLR_RENDERER: "pixman" } });
  expect(nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: " Pixman " }, present).renderer).toBe("pixman");
});

test("a GPU renderer is refused without a pinned render node", () => {
  expect(() => nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: "gles2" }, present)).toThrow(/pinned render node/);
  expect(() => nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: "gles2", ORBIT_NATIVE_RENDER_DEVICE: "/dev/dri/card1" }, present)).toThrow(/renderD/);
  expect(() => nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: "gles2", ORBIT_NATIVE_RENDER_DEVICE: "/dev/dri/renderD200" }, present)).toThrow(/not a character device/);
  expect(() => nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: "software" }, present)).toThrow(/pixman, gles2 or vulkan/);
  expect(() => nativeRendererFromEnv({ ORBIT_NATIVE_RENDER_DEVICE: "/dev/dri/renderD128" }, present)).toThrow(/only applies to a GPU renderer/);
});

test("a pinned GPU renderer hands wlroots exactly the device it was given", () => {
  expect(nativeRendererFromEnv({ ORBIT_NATIVE_RENDERER: "gles2", ORBIT_NATIVE_RENDER_DEVICE: "/dev/dri/renderD128" }, present))
    .toEqual({ renderer: "gles2", device: "/dev/dri/renderD128", env: { WLR_RENDERER: "gles2", WLR_RENDER_DRM_DEVICE: "/dev/dri/renderD128" } });
});

test("what bound is read from the compositor's log, never assumed", () => {
  expect(rendererBound("pixman", "00:00:00.001 [INFO] [sway/main.c:xxx] Sway version 1.11\n")).toEqual({ bound: "pixman" });
  expect(rendererBound("gles2", "[wlr] [render/gles2/renderer.c:538] Creating GLES2 renderer\n[wlr] [render/gles2/renderer.c:541] GL renderer: Mesa Intel(R) Graphics (RPL-S)\n")).toEqual({ bound: "gles2", driver: "Mesa Intel(R) Graphics (RPL-S)" });
  expect(rendererBound("gles2", "[wlr] [render/egl.c:xxx] Failed to create EGL display\nFailed to create a GLES2 renderer\n")).toEqual({ bound: "none" });
  expect(rendererBound("pixman", "[wlr] [render/gles2/renderer.c:xxx] Creating GLES2 renderer\n")).toEqual({ bound: "gles2" });
});
