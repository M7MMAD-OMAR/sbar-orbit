import { OrbitError } from "./errors";

/**
 * Which renderer the private compositor draws with. Pixman is the default and the only mode proven
 * to need no device: about 3 ms of compositor CPU per frame at 1280 by 800, measured in
 * docs/porting.md. A GPU renderer is an opt in, never a fallback the backend reaches for on its own,
 * and it is refused without a pinned render node: unpinned, wlroots autopicks a device, and on a
 * hybrid laptop that was the discrete one, the one that costs the person power. The environment is
 * the switch because it is per broker and per experiment, and never per session request: an agent
 * cannot ask for the person's GPU.
 */
export type NativeRenderer = { renderer: "pixman" | "gles2" | "vulkan"; device?: string; env: Record<string, string> };

export const renderNodePattern = /^\/dev\/dri\/renderD\d+$/;

export function nativeRendererFromEnv(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = path => { try { return require("node:fs").statSync(path).isCharacterDevice(); } catch { return false; } }): NativeRenderer {
  const renderer = (env.ORBIT_NATIVE_RENDERER ?? "pixman").trim().toLowerCase();
  const device = env.ORBIT_NATIVE_RENDER_DEVICE?.trim();
  if (renderer === "pixman") {
    if (device) throw new OrbitError("INVALID_REQUEST", "ORBIT_NATIVE_RENDER_DEVICE only applies to a GPU renderer; unset it or set ORBIT_NATIVE_RENDERER to gles2 or vulkan");
    return { renderer, env: { WLR_RENDERER: "pixman" } };
  }
  if (renderer !== "gles2" && renderer !== "vulkan")
    throw new OrbitError("INVALID_REQUEST", `ORBIT_NATIVE_RENDERER must be pixman, gles2 or vulkan, not "${renderer}"`);
  if (!device)
    throw new OrbitError("UNSUPPORTED", `A GPU renderer needs a pinned render node: set ORBIT_NATIVE_RENDER_DEVICE to one of /dev/dri/renderD*; an unpinned pick can land on the person's discrete GPU`);
  if (!renderNodePattern.test(device)) throw new OrbitError("INVALID_REQUEST", `ORBIT_NATIVE_RENDER_DEVICE must be a /dev/dri/renderD* node, not "${device}"`);
  if (!exists(device)) throw new OrbitError("UNSUPPORTED", `Render node ${device} is not a character device on this machine`);
  return { renderer, device, env: { WLR_RENDERER: renderer, WLR_RENDER_DRM_DEVICE: device } };
}

/**
 * Which renderer actually bound, read from the compositor's own log rather than assumed from what was
 * asked for. sway logs only errors by default, so a GPU session runs it with -V, where wlroots 0.19
 * announces the GLES2 renderer, the GL driver behind it and the render node it opened. Pixman is the
 * reading when pixman was asked and no GPU line appeared; a GPU renderer that was asked for and did
 * not announce itself is reported as none, and the backend refuses the session on that.
 */
export function rendererBound(asked: NativeRenderer["renderer"], compositorLog: string): { bound: string; driver?: string } {
  const driver = /GL renderer: (.+)$/m.exec(compositorLog)?.[1]?.trim();
  if (/Creating GLES2 renderer/.test(compositorLog)) return { bound: "gles2", ...(driver ? { driver } : {}) };
  if (/Creating Vulkan renderer|vulkan renderer/i.test(compositorLog) && !/Failed to create a Vulkan renderer|Cannot create Vulkan renderer/.test(compositorLog)) return { bound: "vulkan" };
  if (asked === "pixman") return { bound: "pixman" };
  return { bound: "none" };
}
