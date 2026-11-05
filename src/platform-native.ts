import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { discoverApplications } from "./application-discovery";
import type { DiscoveryOptions } from "./applications/types";
import { OrbitError } from "./errors";

export type PlatformNativeRegistration = { applicationId: string; executable: string; bundlePath?: string };

/** Resolve only the exact existing OS registration; never accept a caller command or profile. */
export async function resolvePlatformNativeApplication(applicationId: string, platform: NodeJS.Platform = process.platform, options: DiscoveryOptions = {}): Promise<PlatformNativeRegistration> {
  if (!["darwin", "win32"].includes(platform)) throw new OrbitError("UNSUPPORTED", "No platform-native registration adapter for this system");
  if (!applicationId || applicationId.length > 512 || /[\0\r\n]/.test(applicationId)) throw new OrbitError("INVALID_REQUEST", "An exact application registration is required");
  const result = await discoverApplications({ ...options, platform, includeRunning: false, query: undefined });
  if (result.truncated) throw new OrbitError("UNSUPPORTED", "Application registration enumeration was incomplete");
  const matches = result.applications.filter(app => app.id === applicationId && app.availability === "verified"
    && (platform === "win32" ? app.packaging === "registry" && app.sources.includes("App Paths") : app.packaging === "bundle"));
  if (matches.length !== 1) throw new OrbitError("INVALID_REQUEST", "Application registration is missing or ambiguous");
  const selected = matches[0]!;
  if (platform === "win32") return { applicationId, executable: selected.executable };
  const sources = selected.sources.filter(source => source.startsWith("bundle:"));
  if (sources.length !== 1) throw new OrbitError("INVALID_REQUEST", "Application bundle registration is ambiguous");
  const bundlePath = await realpath(sources[0]!.slice("bundle:".length));
  if (!isAbsolute(bundlePath) || !bundlePath.endsWith(".app") || !(await stat(bundlePath)).isDirectory()) throw new OrbitError("UNSUPPORTED", "Registered application bundle is unavailable");
  return { applicationId, executable: selected.executable, bundlePath };
}

/** Fixed helper commands only. Their native API/permission checks run before handoff. */
export function platformNativeEntry(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return ["/usr/bin/python3", "-I", join(import.meta.dir, "native/platform_macos.py")];
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.WINDIR;
    if (!root || !win32.isAbsolute(root) || !/^[A-Za-z]:[\\/]/.test(root) || /[\0\r\n]/.test(root)) throw new OrbitError("UNSUPPORTED", "An absolute local Windows system directory is required");
    return [win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "native/platform_windows.ps1")];
  }
  throw new OrbitError("UNSUPPORTED", "This system has no platform-native helper");
}
