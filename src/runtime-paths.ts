import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix } from "node:path";

export const chromeExecutables = ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

/**
 * The same question on Windows, where there are no fixed paths.
 *
 * It lives here rather than in `chrome.ts` because two callers need it and one of them must not pull
 * Playwright in: `doctor --report` answers on a machine with no broker and no browser session, and
 * importing the launcher to ask which browsers exist would load a browser automation library to
 * answer a filesystem question. The two used to disagree, and the disagreement was visible: a guest
 * where Edge launched and rendered reported `browsers: []` and `browserBackendSupported: false`.
 *
 * Install roots first, registry second. `App Paths` is the documented answer and the roots are the
 * common one, so the registry is the fallback: reading it costs a process and a present file does not.
 * Chrome before Edge, because a profile is tied to the branding that wrote it and Chrome is what
 * Orbit's other measurements were taken against.
 */
export type WindowsBrowser = { id: string; executable: string; profileDirectory: string };

/** Spawning `reg` is injected so the rule can be pinned from a host that has no registry. */
export type RegistryProbe = (exe: string) => string | undefined;

export function windowsBrowserInstalls(env = process.env, registry: RegistryProbe = registeredPath): WindowsBrowser[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
  const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const known = [
    { id: "google-chrome", leaf: "Google\\Chrome\\Application\\chrome.exe", exe: "chrome.exe", data: join(local, "Google\\Chrome\\User Data") },
    { id: "chromium", leaf: "Chromium\\Application\\chrome.exe", exe: "chrome.exe", data: join(local, "Chromium\\User Data") },
    { id: "microsoft-edge", leaf: "Microsoft\\Edge\\Application\\msedge.exe", exe: "msedge.exe", data: join(local, "Microsoft\\Edge\\User Data") },
  ];
  const found: WindowsBrowser[] = [];
  const claimed = new Set<string>();
  for (const candidate of known) {
    const executable = roots.map(root => join(root, candidate.leaf)).find(path => Bun.file(path).size > 0)
      ?? registry(candidate.exe);
    if (!executable) continue;
    // App Paths is keyed by FILE NAME, and Chrome and Chromium both ship `chrome.exe`, so the
    // registry cannot tell the two brandings apart. Without this, a Chrome installed outside the
    // three install roots was reported twice: once correctly, and once as a `chromium` install that
    // does not exist, carrying Chrome's binary and Chromium's profile directory. First candidate
    // wins, which is the same Chrome before Chromium order the install roots already use.
    if (claimed.has(executable.toLowerCase())) continue;
    claimed.add(executable.toLowerCase());
    found.push({ id: candidate.id, executable, profileDirectory: candidate.data });
  }
  return found;
}

function registeredPath(exe: string): string | undefined {
  // Absolute, never through PATH. This spawn decides which binary Orbit launches as the session
  // browser, and every Linux helper in this tree is already spawned absolutely for the same reason:
  // resolving through PATH lets whatever the agent host exported choose the program. `%SystemRoot%`
  // rather than a literal, because Windows is not always installed on C:.
  const system32 = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32");
  const registry = join(system32, "reg.exe");
  for (const hive of ["HKCU", "HKLM"]) {
    // `reg` is on every Windows install and is still spawned defensively: a host without it should
    // report no browser, not throw out of a capability probe that a person runs to find out why
    // nothing works.
    let output: string;
    try {
      const probe = Bun.spawnSync([registry, "query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"]);
      output = probe.stdout.toString();
    } catch { return undefined; }
    const found = /REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1]?.trim();
    if (found && Bun.file(found).size > 0) return found;
  }
  return undefined;
}

/**
 * The same question on macOS, where a browser is an application BUNDLE and the thing Orbit runs is
 * the Mach-O inside it.
 *
 * Two rules decide this whole function, and both are the difference between a private session and a
 * window appearing on the person's screen:
 *
 *   1. Orbit launches `<bundle>/Contents/MacOS/<executable>` DIRECTLY, never `open -a`. LaunchServices
 *      treats a bundle as a single instance application: `open` on a bundle the person is already
 *      running activates THEIR window and hands it the command line, which is the exact thing this
 *      project exists not to do.
 *   2. The executable name inside the bundle is not derivable from the bundle name and contains
 *      spaces. It is written out literally per browser, because guessing it wrong is a browser that
 *      does not start, and deriving it from `Info.plist` would mean reading a file per candidate on
 *      a path that runs during `doctor` on a machine with no browser at all.
 *
 * `/Applications` first, then `~/Applications`, because a per user install of the same branding is
 * the less common case and the order has to be stable for the profile a session is handed.
 *
 * Chrome before Edge before the rest, for the same reason the Windows list uses that order: a
 * profile is tied to the branding that wrote it, and Chrome is what Orbit's measurements were taken
 * against.
 */
export type DarwinBrowser = { id: string; executable: string; profileDirectory: string; bundle: string };

export function darwinBrowserInstalls(home = homedir(), present = (path: string) => Bun.file(path).size > 0): DarwinBrowser[] {
  // A macOS path is POSIX whatever host computes it: `join` is bound to the host platform, so on
  // Windows it would answer with backslashes about a Mac. See the note in `src/service.ts`.
  const support = posix.join(home, "Library", "Application Support");
  const known = [
    { id: "google-chrome", bundle: "Google Chrome.app", binary: "Google Chrome", data: posix.join(support, "Google", "Chrome") },
    { id: "chromium", bundle: "Chromium.app", binary: "Chromium", data: posix.join(support, "Chromium") },
    { id: "microsoft-edge", bundle: "Microsoft Edge.app", binary: "Microsoft Edge", data: posix.join(support, "Microsoft Edge") },
    { id: "brave", bundle: "Brave Browser.app", binary: "Brave Browser", data: posix.join(support, "BraveSoftware", "Brave-Browser") },
  ];
  const found: DarwinBrowser[] = [];
  for (const candidate of known) {
    for (const root of ["/Applications", posix.join(home, "Applications")]) {
      const bundle = posix.join(root, candidate.bundle);
      const executable = posix.join(bundle, "Contents", "MacOS", candidate.binary);
      // `Bun.file(...).size > 0` rather than an access check: the Mach-O inside a bundle is a real
      // file with real bytes, and a bundle whose executable is missing is a broken install that
      // should be reported as absent rather than as a browser that will fail to start later.
      if (!present(executable)) continue;
      found.push({ id: candidate.id, executable, profileDirectory: candidate.data, bundle });
      break;
    }
  }
  return found;
}

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
