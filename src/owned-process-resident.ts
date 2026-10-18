import { OrbitError } from "./errors";

export type OwnedResidentSample = {
  pids: number[];
  rssKiB: number;
  source: "owned Windows job working set" | "owned macOS process group resident memory";
};

export type RecordedGroupIdentity = { pgid: number; startedAtMs: number; executable: string };

/** Historical kernel-empty observation retained by the actual confirmed stop, not a live closed-job query. */
export function sampleConfirmedClosedJob(evidence: import("./owned-cleanup").StopEvidence): OwnedResidentSample {
  if (!evidence.confirmed || !evidence.handleClosed || evidence.rootExitCode === null || evidence.members?.length !== 0)
    throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", "Closed browser job has no confirmed absence evidence");
  return { pids: [], rssKiB: 0, source: "owned Windows job working set" };
}

/** Only query the group established by this browser's supervisor. */
export async function sampleRecordedGroup(identity: RecordedGroupIdentity, exited: boolean): Promise<OwnedResidentSample> {
  const { processGroupMembers, groupIsStillOurs, processUsage, processStartedAtMs, processGroupOf, processMemberStateDiagnostic } = await import("./macos");
  const fail = (message: string): never => { throw new OrbitError("RESOURCE_STATUS_UNAVAILABLE", message); };
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 1 ||
      !Number.isFinite(identity.startedAtMs) || identity.startedAtMs <= 0 ||
      typeof identity.executable !== "string" || !identity.executable)
    fail("Owned browser process group identity is invalid");
  const leaderIsOurs = () => groupIsStillOurs(identity.pgid, identity) &&
    processStartedAtMs(identity.pgid) === identity.startedAtMs;
  const members = () => {
    const value = processGroupMembers(identity.pgid);
    if (value.failed || !value.complete) fail("Owned browser process group membership is unavailable or truncated");
    if (value.pids.length > 512) fail("Owned browser process group exceeds the sampling bound");
    return value.pids;
  };
  const listed = members();
  // After the supervisor exits, absence comes from the kernel, not from close() resolving.
  if (!listed.length) {
    if (!exited) fail("Running browser's owned process group is unexpectedly empty");
    return { pids: [], rssKiB: 0, source: "owned macOS process group resident memory" };
  }
  if (!leaderIsOurs()) fail("Browser process group identity is no longer verifiable");
  const pids: number[] = [];
  let residentBytes = 0;
  for (const pid of listed) {
    const startDiagnostic: import("./macos").ProcessStartDiagnostic = { returnBytes: null, reason: "not-measured" };
    const before = processStartedAtMs(pid, startDiagnostic);
    // Keep the original short circuit: no group read when the start identity is unknown.
    const beforeGroup = before === null ? undefined : processGroupOf(pid);
    if (before === null || beforeGroup !== identity.pgid) {
      const relisted = members();
      if (!relisted.includes(pid)) continue;
      // Original unknown stays rejected. State is a later, diagnostic-only snapshot.
      let stateDiagnostic: import("./macos").ProcessMemberStateDiagnostic | undefined;
      let stateObservation: "not-requested" | "sampled" | "unavailable" = "not-requested";
      if (before === null) {
        try { stateDiagnostic = processMemberStateDiagnostic(pid); stateObservation = "sampled"; }
        catch { stateObservation = "unavailable"; }
      }
      const numeric = (value: number | null | undefined) => value === null || value === undefined ? "not-measured" : value;
      fail(`Owned browser group member identity is unreadable (memberPid=${pid}, ownedPgid=${identity.pgid}, ` +
        `start=${before === null ? "unknown" : "valid"}, startReason=${startDiagnostic.reason}, ` +
        `startReturnBytes=${startDiagnostic.returnBytes === null ? "not-measured" : startDiagnostic.returnBytes}, ` +
        `group=${beforeGroup === undefined ? "not-read" : beforeGroup === null ? "unknown" : beforeGroup}, ` +
        `relist=complete-present, relistCount=${relisted.length}, startErrno=${numeric(startDiagnostic.errno)}, ` +
        `errnoObservation=thread-local-best-effort, stateObservation=${stateObservation}, stateReturnBytes=${numeric(stateDiagnostic?.returnBytes)}, stateErrno=${numeric(stateDiagnostic?.errno)}, ` +
        `statePid=${numeric(stateDiagnostic?.pid)}, statePgid=${numeric(stateDiagnostic?.pgid)}, ` +
        `stateStatus=${numeric(stateDiagnostic?.status)}, stateStartedAtMs=${numeric(stateDiagnostic?.startedAtMs)})`);
    }
    const usage = processUsage(pid);
    const after = processStartedAtMs(pid);
    const stillMember = processGroupOf(pid) === identity.pgid;
    // A process may exit while sampled. Never read a reused pid as the owned member.
    if (!usage || before !== after || !stillMember) {
      if (!members().includes(pid)) continue;
      return fail("Owned browser group member resident memory or identity is unavailable");
    }
    if (!Number.isSafeInteger(usage.residentBytes) || usage.residentBytes < 0)
      fail("Owned browser group resident memory is invalid");
    pids.push(pid);
    residentBytes += usage.residentBytes;
    if (!Number.isSafeInteger(residentBytes)) fail("Owned browser process group aggregate resident memory is invalid");
  }
  if (!leaderIsOurs()) fail("Browser process group identity changed during sampling");
  return { pids, rssKiB: residentBytes / 1024, source: "owned macOS process group resident memory" };
}
