import { distributionName } from "./platform";
import { nativeControlStatus } from "./native-availability";
import { diagnoseNative, type NativeReadiness } from "./native-readiness";

/** Desktop metadata only. Never discovers browsers, opens profiles or queries their credentials. */
export async function describeDesktopMachine(diagnose: () => Promise<NativeReadiness> = diagnoseNative): Promise<Record<string, unknown>> {
  const linux = process.platform === "linux";
  const ownerHandoff = nativeControlStatus();
  // The service environment can predate the compositor, so the live runtime directory is asked as well.
  let native: NativeReadiness | undefined, nativeError: string | undefined;
  if (linux) {
    try { native = await diagnose(); }
    catch (error) { nativeError = error instanceof Error ? error.message : "Native readiness check failed"; }
  }
  const resolved = native?.environment.resolved ? native.environment.values : {};
  const wayland = process.env.WAYLAND_DISPLAY || resolved.WAYLAND_DISPLAY;
  return {
    report: "orbit-desktop-capabilities", sessionMode: "native-only",
    platform: process.platform, architecture: process.arch,
    sessionType: linux ? wayland ? "wayland" : process.env.DISPLAY ? "x11" : "none" : "none",
    desktop: process.env.XDG_CURRENT_DESKTOP || resolved.XDG_CURRENT_DESKTOP || "",
    distribution: linux ? await distributionName() : { id: "", versionId: "" },
    browserBackendSupported: false, browsers: [],
    // True only when the live compositor, the prepared plan, the plugin build and the loaded plugin agree.
    nativeDisplaySupported: native?.ready === true, originalApplicationOpeningImplemented: linux,
    nativeDisplayEvidence: native ? "Measured now: the live compositor, the prepared plan, the recorded plugin build and the loaded plugin were compared; operation acceptance is not measured by this report"
      : "Implementation availability only; runtime acceptance is not measured by this report",
    ...(linux ? { native: native ? { ready: native.ready, environmentSource: native.environment.source, environmentMissingFromService: native.environment.missing_from_process,
      compositor: native.compositor, installed: native.installed, plan: native.plan, build: native.build, plugin: native.plugin, lastRefresh: native.lastRefresh,
      problems: native.problems.map(({ code, blocking, message, fix }) => ({ code, blocking, message, fix })) } : { ready: false, error: nativeError } } : {}),
    existingApplicationControl: `${ownerHandoff.state}: ${ownerHandoff.reason}`,
    ownerHandoff,
    notes: linux
      ? ["Original application opening needs configured owner compositor metadata; input control needs a compatible prepared plugin and explicit application handoff", ownerHandoff.reason,
        ...(native ? native.problems.filter(problem => problem.blocking).map(problem => `${problem.code}: ${problem.message} Fix: ${problem.fix}`) : [])]
      : ["A native desktop adapter is not implemented for this platform; no browser fallback is available"],
    redacted: ["no browser profile discovery", "no cookie database access", "no account names", "no viewer tokens"],
  };
}

export async function desktopHostClassTier() {
  return process.platform === "linux"
    ? { assigned: "Reasoned", why: "Original Linux application opening is implemented. This report does not execute application acceptance tests." }
    : { assigned: "Unsupported", why: "A native desktop adapter for this platform is not implemented. Historical browser measurements do not prove desktop support." };
}
