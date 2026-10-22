import { distributionName } from "./platform";
import { nativeControlStatus } from "./native-availability";

/** Desktop metadata only. Never discovers browsers, opens profiles or queries their credentials. */
export async function describeDesktopMachine(): Promise<Record<string, unknown>> {
  const linux = process.platform === "linux";
  const ownerHandoff = nativeControlStatus();
  return {
    report: "orbit-desktop-capabilities", sessionMode: "native-only",
    platform: process.platform, architecture: process.arch,
    sessionType: linux ? process.env.WAYLAND_DISPLAY ? "wayland" : process.env.DISPLAY ? "x11" : "none" : "none",
    desktop: process.env.XDG_CURRENT_DESKTOP ?? "",
    distribution: linux ? await distributionName() : { id: "", versionId: "" },
    browserBackendSupported: false, browsers: [],
    nativeDisplaySupported: false, originalApplicationOpeningImplemented: linux,
    nativeDisplayEvidence: "Implementation availability only; runtime acceptance is not measured by this report",
    existingApplicationControl: `${ownerHandoff.state}: ${ownerHandoff.reason}`,
    ownerHandoff,
    notes: linux
      ? ["Original application opening needs configured owner compositor metadata; input control needs a compatible prepared plugin and explicit application handoff", ownerHandoff.reason]
      : ["A native desktop adapter is not implemented for this platform; no browser fallback is available"],
    redacted: ["no browser profile discovery", "no cookie database access", "no account names", "no viewer tokens"],
  };
}

export async function desktopHostClassTier() {
  return process.platform === "linux"
    ? { assigned: "Reasoned", why: "Original Linux application opening is implemented. This report does not execute application acceptance tests." }
    : { assigned: "Unsupported", why: "A native desktop adapter for this platform is not implemented. Historical browser measurements do not prove desktop support." };
}
