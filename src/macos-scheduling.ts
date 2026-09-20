/**
 * Cap active agent work at utility QoS instead of maintenance-style background
 * throttling. An inherited stricter policy is never raised. Explicit 0/1 modes
 * remain available to the disposable scheduling experiment.
 */
export function darwinTaskPolicy(inheritedBackground: boolean, mode?: string): string[] {
  if (inheritedBackground || mode === "0") return [];
  return mode === "1" ? ["-b"] : ["-c", "utility"];
}
