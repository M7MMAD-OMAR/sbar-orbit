import { OrbitError } from "./errors";

/** Availability follows the installed adapter, not a permanent historical incident flag. */
export function requireNativeAdapter(): void {
  if (process.platform !== "linux")
    throw new OrbitError("UNSUPPORTED", "A native desktop adapter is not implemented for this platform");
}

export function nativeControlStatus() {
  if (process.platform !== "linux") return { state: "unsupported", reason: "A native desktop adapter is not implemented for this platform" };
  return { state: "available", reason: "Requires a prepared plugin matching the compositor; actual target acknowledgements determine operation results" };
}
