import { join } from "node:path";

export const chromeExecutables = ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
export function nativeRuntimePaths(project: string) {
  const runtime = join(project, ".runtime/sway");
  return { runtime, executables: join(runtime, "root/usr/bin"), pointer: join(runtime, "pointer") };
}
