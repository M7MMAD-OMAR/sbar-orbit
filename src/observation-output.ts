import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { OrbitError } from "./errors";

const frameSchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg"]), image: z.string().min(1) }).passthrough();
export function splitFrame(value: unknown) {
  const { image, ...metadata } = frameSchema.parse(value);
  return { image, metadata };
}
export function observationOptions(args: string[]) {
  if (args.length === 0) return { mode: "image" as const };
  if (args.length === 1 && args[0] === "--metadata") return { mode: "metadata" as const };
  if (args.length === 2 && args[0] === "--output" && args[1] && !args[1].startsWith("--"))
    return { mode: "file" as const, path: assertWritableTarget(resolve(args[1])) };
  throw new OrbitError("INVALID_REQUEST", "Use session observe ID [--metadata | --output PATH]");
}

/** Windows device names, which are reserved in EVERY directory rather than only at the drive root. */
const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * The shapes `open(path, "wx")` accepts on Windows but must not.
 *
 * `wx` refuses an existing file and refuses to follow a symlink, which is the whole of the protection
 * that used to be here. Measured on a Windows 11 guest, it accepts all of these:
 *
 * - `notes.txt:hidden` writes an ALTERNATE DATA STREAM onto the person's existing file. `wx` succeeds
 *   because the stream is new even though the host file is not, and the result is invisible to `dir`
 *   and to Explorer. Measured: `Get-Item -Stream *` then reports `:$DATA` plus `hidden`.
 * - `NUL` and `CON` open devices. The capture is discarded, or written to the console, and Orbit reports
 *   a byte count for a file that does not exist.
 * - a trailing dot or space is silently STRIPPED by Windows, so the file created is not the path that
 *   was validated, and not the path reported back to the caller.
 *
 * None of this is remote code execution. It is stealth storage under the person's identity and a false
 * success report, on a path the caller names, which is enough to be worth refusing.
 */
export function assertWritableTarget(path: string): string {
  const refuse = () => {
    throw new OrbitError("OUTPUT_UNAVAILABLE", "Image output must be a new writable file in an existing directory");
  };
  // Only on Windows: a colon is legal in a POSIX filename and refusing it there would break real paths.
  if (process.platform === "win32") {
    // Past the drive prefix, so `C:\shots\a.png` is fine and `C:\shots\a.png:hidden` is not.
    const withoutDrive = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path;
    if (withoutDrive.includes(":")) refuse();
    for (const segment of withoutDrive.split(/[\\/]/)) {
      if (!segment) continue;
      if (segment.endsWith(".") || segment.endsWith(" ")) refuse();
      // Reserved with or without an extension: `NUL` and `NUL.png` both reach the device.
      const stem = segment.split(".")[0] ?? segment;
      if (reservedNames.test(stem)) refuse();
    }
  }
  return path;
}

export async function saveObservation(value: unknown, path: string) {
  const { image, metadata } = splitFrame(value);
  const bytes = Buffer.from(image, "base64");
  // Checked here too, not only in `observationOptions`: this is exported and called directly, so the
  // validation has to sit at the write rather than only at the one argument parser that reaches it.
  assertWritableTarget(resolve(path));
  // Never overwrite an existing artifact or follow its symlink. Keep the captured bytes unchanged.
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch { throw new OrbitError("OUTPUT_UNAVAILABLE", "Image output must be a new writable file in an existing directory"); }
  try { await file.writeFile(bytes); } finally { await file.close(); }
  return { ...metadata, path: resolve(path), bytes: bytes.length };
}
