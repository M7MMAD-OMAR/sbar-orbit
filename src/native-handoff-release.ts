import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrbitError } from "./errors";

const evidence = join(import.meta.dir, "../experiments/ghost-cursor/owner-handoff-release.json");
const refusal = "Owner display handoff is disabled after a compositor crash; isolated validation is required";

/**
 * Owner handoff release, bound to the committed isolated evidence. No runtime override. The
 * Python owner paths also bind the exact plugin source and Hyprland build before any claim.
 */
export function requireOwnerHandoff(path = evidence): void {
  let record: { schema?: unknown; state?: unknown; plugin?: { source_sha256?: unknown }; hyprland?: { abi_hash?: unknown } };
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new OrbitError("UNSUPPORTED", refusal); }
  if (record?.schema !== 1 || record.state !== "passed" || typeof record.plugin?.source_sha256 !== "string"
    || record.plugin.source_sha256.length !== 64 || typeof record.hyprland?.abi_hash !== "string" || !record.hyprland.abi_hash)
    throw new OrbitError("UNSUPPORTED", refusal);
}
