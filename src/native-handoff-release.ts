import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrbitError } from "./errors";

const evidence = join(import.meta.dir, "../experiments/ghost-cursor/owner-handoff-release.json");
const refusal = "Owner display handoff is disabled after a compositor crash; isolated validation is required";

/**
 * Owner handoff release requires both isolated and live acceptance. No runtime override. The
 * Python owner paths also bind the exact plugin source and Hyprland build before any claim.
 */
export function requireOwnerHandoff(path = evidence): void {
  let record: { schema?: unknown; state?: unknown; plugin?: { source_sha256?: unknown }; hyprland?: { abi_hash?: unknown };
    ownerAcceptance?: { state?: unknown; inputDelivered?: unknown; selectionIsolated?: unknown;
      ownerFocusPreserved?: unknown; ownerPointerPreserved?: unknown; handbackVerified?: unknown } };
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new OrbitError("UNSUPPORTED", refusal); }
  if (record?.schema !== 1 || record.state !== "passed" || typeof record.plugin?.source_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.plugin.source_sha256) || typeof record.hyprland?.abi_hash !== "string" || !record.hyprland.abi_hash
    || record.ownerAcceptance?.state !== "passed"
    || [record.ownerAcceptance.inputDelivered, record.ownerAcceptance.selectionIsolated,
      record.ownerAcceptance.ownerFocusPreserved, record.ownerAcceptance.ownerPointerPreserved,
      record.ownerAcceptance.handbackVerified].some(value => value !== true))
    throw new OrbitError("UNSUPPORTED", refusal);
}

/** Metadata uses the same gate as execution; lab success never advertises owner control. */
export function ownerHandoffStatus() {
  if (process.platform !== "linux") return { state: "unsupported", reason: "A native desktop adapter is not implemented for this platform" };
  try {
    requireOwnerHandoff();
    return { state: "released", reason: "Restricted to the plugin and compositor build with isolated and live acceptance evidence" };
  } catch {
    return { state: "held", reason: refusal };
  }
}
