import { OrbitError } from "./errors";

/** Release hold after the owner compositor crash. No runtime override. */
export function requireOwnerHandoff(): void {
  throw new OrbitError("UNSUPPORTED", "Owner display handoff is disabled after a compositor crash; isolated validation is required");
}
