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
    return { mode: "file" as const, path: resolve(args[1]) };
  throw new OrbitError("INVALID_REQUEST", "Use session observe ID [--metadata | --output PATH]");
}
export async function saveObservation(value: unknown, path: string) {
  const { image, metadata } = splitFrame(value);
  const bytes = Buffer.from(image, "base64");
  // Never overwrite an existing artifact or follow its symlink. Keep the captured bytes unchanged.
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch { throw new OrbitError("OUTPUT_UNAVAILABLE", "Image output must be a new writable file in an existing directory"); }
  try { await file.writeFile(bytes); } finally { await file.close(); }
  return { ...metadata, path: resolve(path), bytes: bytes.length };
}
