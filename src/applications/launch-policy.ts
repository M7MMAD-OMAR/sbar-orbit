import { OrbitError } from "../errors";
import type { DesktopEntry } from "./desktop-entry";

/** Registration state, not application category, determines whether an entry can launch. */
export function assertEnabledRegistration(fields: DesktopEntry): void {
  if (fields.Type !== "Application" || fields.Hidden === "true" || !fields.Exec)
    throw new OrbitError("UNSUPPORTED", "Application registration is disabled or has no Exec recipe");
}
