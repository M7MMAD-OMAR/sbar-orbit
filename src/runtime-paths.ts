import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const chromeExecutables = ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

/**
 * The Fedora packages the bootstrap downloads and unpacks, declared here rather than only in the shell
 * script, because the runtime directory is named after them and `tests/native-runtime.test.ts` checks
 * that the two lists still agree. Change one and the test names the other.
 */
export const nativeRuntimePins = ["sway-1.11-3.fc44.x86_64", "wlroots0.19-0.19.3-1.fc44.x86_64", "libliftoff-0.5.0-5.fc44.x86_64"];

export type NativeRuntime = { runtime: string; executables: string; pointer: string };
const pathsFor = (runtime: string): NativeRuntime => ({ runtime, executables: join(runtime, "root/usr/bin"), pointer: join(runtime, "pointer") });

/**
 * One built runtime per pinned package set, shared by every version of Orbit that pins the same set.
 * Legible first, then a digest of the whole set, so a person can see what is in the directory and two
 * pins that differ anywhere still get different directories.
 */
export function nativeRuntimeName(pins: string[] = nativeRuntimePins) {
  const leading = pins[0]?.replace(/\.x86_64$/, "") ?? "runtime";
  return `${leading}-${createHash("sha256").update(pins.join(" ")).digest("hex").slice(0, 6)}`;
}

export function sharedRuntimeRoot() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "sbar-orbit/runtime");
}

/**
 * Where a built runtime can be. `shared` is where new builds go: outside every version directory, so a
 * version swap keeps native sessions working instead of silently taking them away. `inSource` is where
 * every runtime built before 14 September 2026 is, inside whichever source tree built it, and it stays
 * readable rather than being orphaned by the move.
 */
export function nativeRuntimeLocations(project: string) {
  return { shared: pathsFor(join(sharedRuntimeRoot(), nativeRuntimeName())), inSource: pathsFor(join(project, ".runtime/sway")) };
}

async function complete(paths: NativeRuntime) {
  return await Bun.file(join(paths.executables, "sway")).exists() && await Bun.file(paths.pointer).exists();
}

/** The runtime a session should use, preferring the shared one, and saying which it found. */
export async function usableNativeRuntime(project: string): Promise<NativeRuntime & { source: "shared" | "in-source" | "none" }> {
  const { shared, inSource } = nativeRuntimeLocations(project);
  if (await complete(shared)) return { ...shared, source: "shared" };
  if (await complete(inSource)) return { ...inSource, source: "in-source" };
  return { ...shared, source: "none" };
}

/**
 * What the built compositor links against. The bootstrap unpacks its packages rather than installing
 * them, so their dependencies are the machine's to have; this is the resolved list for the pinned
 * Fedora 44 packages, read from their RPM requirements on 13 September 2026.
 */
export const nativeRuntimePackages = "cairo gdk-pixbuf2 glib2 json-c lcms2 libdisplay-info libdrm libevdev libglvnd-egl libglvnd-gles libinput libseat libwayland-client libwayland-cursor libwayland-server libxcb libxkbcommon mesa-libgbm pango pcre2 pixman systemd-libs vulkan-loader xcb-util-errors xcb-util-renderutil xcb-util-wm";
