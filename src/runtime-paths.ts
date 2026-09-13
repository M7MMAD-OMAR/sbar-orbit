import { join } from "node:path";

export const chromeExecutables = ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
export function nativeRuntimePaths(project: string) {
  const runtime = join(project, ".runtime/sway");
  return { runtime, executables: join(runtime, "root/usr/bin"), pointer: join(runtime, "pointer") };
}

/**
 * What the built compositor links against. The bootstrap unpacks its packages rather than installing
 * them, so their dependencies are the machine's to have; this is the resolved list for the pinned
 * Fedora 44 packages, read from their RPM requirements on 13 September 2026.
 */
export const nativeRuntimePackages = "cairo gdk-pixbuf2 glib2 json-c lcms2 libdisplay-info libdrm libevdev libglvnd-egl libglvnd-gles libinput libseat libwayland-client libwayland-cursor libwayland-server libxcb libxkbcommon mesa-libgbm pango pcre2 pixman systemd-libs vulkan-loader xcb-util-errors xcb-util-renderutil xcb-util-wm";
