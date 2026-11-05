import { open, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError } from "../errors";
import { boundedApplicationEntries } from "./entries";
import type { DiscoveryOptions } from "./types";

const flag = "--force-renderer-accessibility";
const refuse = (): never => { throw new OrbitError("UNSUPPORTED", "Renderer accessibility requires a direct native executable and a complete idle-process preflight"); };

/** Explicit registration opt-in only; never edit an application's profile or settings. */
export async function rendererAccessibilityArguments(fields: Record<string, string>, argv: string[], options: DiscoveryOptions): Promise<string[]> {
  const setting = fields["X-Orbit-Accessibility"];
  if (setting === undefined || setting === "false") return argv;
  if (setting !== "chromium-renderer") throw new OrbitError("INVALID_REQUEST", "Unknown registered accessibility option");
  const executable = argv[0];
  if (!executable || (options.platform ?? process.platform) !== "linux" || fields.Terminal === "true") return refuse();
  if (argv.some(arg => arg === "--disable-renderer-accessibility" || arg.startsWith(flag + "=")))
    throw new OrbitError("INVALID_REQUEST", "Registered accessibility options conflict");
  // A shell, Flatpak or setup wrapper does not identify the eventual singleton.
  // Require the registered executable itself to be a native binary.
  const handle = await open(executable, "r").catch(() => undefined);
  if (!handle) return refuse();
  try {
    const magic = Buffer.alloc(4);
    if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4 || !magic.equals(Buffer.from([127, 69, 76, 70]))) return refuse();
  } finally { await handle.close(); }
  const proc = options.procRoot ?? "/proc", deadline = Date.now() + 2000;
  const uid = process.getuid?.();
  if (uid === undefined) return refuse();
  const binary = await stat(executable).catch(() => undefined);
  const canonical = await realpath(executable).catch(() => undefined);
  if (!binary || !canonical || !(await stat(proc).catch(() => undefined))?.isDirectory()) return refuse();
  const scan = await boundedApplicationEntries(proc, 4096, false, deadline);
  if (scan.truncated) return refuse();
  let incomplete = false;
  for (const pid of scan.entries) {
    if (!/^[1-9][0-9]*$/.test(pid)) continue;
    if (Date.now() >= deadline) return refuse();
    try {
      if ((await stat(join(proc, pid))).uid !== uid) continue;
      const path = join(proc, pid, "exe");
      const current = await stat(path);
      const name = await readlink(path);
      if ((current.dev === binary.dev && current.ino === binary.ino) || name === canonical || name === canonical + " (deleted)")
        throw new OrbitError("APPLICATION_BUSY", "Renderer accessibility cannot be enabled while this registered executable is running");
    } catch (error) {
      if (error instanceof OrbitError) throw error;
      // An exited process is absent; an unreadable live process is unknown.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") incomplete = true;
    }
  }
  if (incomplete) return refuse();
  // This preflight is not a global singleton lock. Opening still has to prove
  // its new window, and text observation must report actual tree availability.
  return argv.includes(flag) ? argv : [executable, flag, ...argv.slice(1)];
}
