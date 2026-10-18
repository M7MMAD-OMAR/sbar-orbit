import { Sessions } from "./session";
import { OrbitError, record } from "./errors";

/** Public session admission. Historical browser internals are not a supported backend. */
export class DesktopSessions extends Sessions {
  override async create(input: Record<string, unknown>): Promise<unknown> {
    const backend = input.backend ?? "system";
    if (!["system", "fedora", "native"].includes(String(backend)))
      throw new OrbitError("UNSUPPORTED", "Orbit is desktop-only. Use system for a private desktop or native for configured application control. Standalone browser sessions are retired.");
    if (["cloneOf", "cloneExtensions", "accountName"].some(key => input[key] !== undefined))
      throw new OrbitError("UNSUPPORTED", "Browser profile copying and saved browser accounts are retired. Use a supported native application session.");
    return super.create({ ...input, backend });
  }

  override async act(input: Record<string, unknown>): Promise<unknown> {
    const action = input.action;
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const selected = action as Record<string, unknown>;
      if (selected.type === "launch-app" && selected.app === "zen")
        throw new OrbitError("UNSUPPORTED", "Active browser profile copying is retired. Use supported native application control without a profile clone.");
    }
    return super.act(input);
  }

  override async dispatch(value: unknown): Promise<unknown> {
    const request = record(value);
    if (["profiles.list", "session.account.save"].includes(String(request.method)))
      throw new OrbitError("UNSUPPORTED", "Standalone browser profile and account APIs are retired. Orbit is desktop-only.");
    const result = await super.dispatch(value);
    if (request.method !== "doctor") return result;
    const report = record(result);
    const backends = process.platform === "linux" && Array.isArray(report.backends)
      ? report.backends.filter(backend => backend !== "browser") : [];
    const machine = record(report.machine);
    return { ...report, backend: "system", backends, sessionMode: "desktop-only",
      capabilities: backends.length ? ["launch", "launch-installed", "pointer", "scroll", "text", "paste", "key", "resize", "window", "desktops", "desktop", "list-windows", "move-window", "observe", "pause", "resume", "stop"] : [],
      machine: { ...machine, browsers: [], browserBackendSupported: false },
      retiredBackends: ["browser"],
      desktopEvidence: { existingApplications: "nested lab measured; live owner claim not measured", otherPlatforms: "not measured" } };
  }
}
