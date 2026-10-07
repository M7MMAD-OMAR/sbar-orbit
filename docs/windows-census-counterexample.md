# Windows census acquisition-order experiment

This current-main successor is prepared on main
`834f3f6dbbda77aa8b002432e9b462b2702a2282`, tree
`7e873b8a09a78464c1387be4f35793085124dccd`. Its fresh local checks,
actual Windows execution and two independent reviews are `not measured`.
It is an acquisition-order experiment, with process capability `unknown`.
The existing browser-crash collector, process witness helper and Windows job
implementation remain unchanged. Native owner hold remains unconditional.

The old PR8 head `6814b4dcc82feeb9d5649b9815365e4d4f025625` was executed.
Current [completion status](completion-status.md) retains historical
[diagnostic run 37523498184](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37523498184)
and [normal run 37523503415](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37523503415).
The diagnostic used 972 actual tracked paths: the old `System.Object[]` sort
had 39 adjacent violations; the typed `System.String[]` sort had strict ordinal
order with the same multiset and identical before/after manifests. That evidence
belongs to the old candidate. It supplies no fresh proof for this successor.
The normal run supplies no explanation of the original acquisition error.

The actual main 61ea92c Windows run failed its first OpenProcess acquisition for
owned PID 7784. The subsequent docs-only main 449e4de run passed. A transient
disappearance is a hypothesis; error 87 remains an unknown acquisition result.

The probe creates two separate controlled children through actual CreateProcessW.
Each child is assigned suspended to its own unnamed kill-on-close job, then resumed
with an allowlisted environment and owned file gates. While the child is alive,
the creator records GetProcessTimes creation ticks, actual image identity and
the queried root-parent relationship. It closes both creator process and thread
handles before the exit gate can be released. This avoids Bun subprocess or .NET
Process objects retaining a hidden child handle and invalidating the experiment.

In the deferred trial, the ownership row is recorded while alive, the child is
released, private job accounting must report zero active processes, and a bounded
trailing interval represents census completion. The unchanged
captureProcessWitnesses then attempts its first acquisition. A raw failed
OpenProcess is retained as unknown. If it succeeds, the counterexample was not
reproduced, even if that handle correctly proves exit.

In the separate retained trial, the child has a different actual creation identity.
The probe acquires and verifies that trial's handle before exit, keeps it until
census completion, and supplies it to the unchanged capture helper. The result
must preserve that exact trial's PID, creation ticks and image, and report exited
with a nonzero exit time. The two trials never substitute one child's identity
for another. This compares acquisition order only; it does not implement a
streamed production census collector.

The report uses `counterexample reproduced` only when deferred acquisition really
fails and retained acquisition proves its original identity's exit. Its process
capability remains `unknown`. A Windows prerequisite failure, incomplete fixture,
source change, cleanup failure or non-reproduction is explicitly `not measured`
with nonzero exit. Portable mock controls establish ordering, unknown propagation
and retryable capture cleanup only. They do not establish actual Windows behavior
and do not claim a new discriminating failure against unchanged production code.

The fixture uses an overall 14 second acquisition deadline inside the planned
20 second probe bound, with separate bounded owned cleanup. The existing crash
test's 20 second deadline and 150 polls at 30 ms remain unchanged. Preparation
failures with unsuccessful cleanup retain an async retryable close callback.
No missing row, process identity or failure is converted into a successful exit.
The kernel parent query is bounded and filtered to the already created owned PID.

After explicit Windows execution authorization and the sole budget grant, the
probe command is `bun run scripts/limited.ts bun run experiments/windows-census-counterexample.ts ABSOLUTE_REPORT_PATH`
with `ORBIT_WINDOWS_CENSUS_PROBE=1`. The report path must be an unused owned
destination. The engine's POSIX-only prerequisite prevents claiming a local
Fedora run as a native Windows execution. Retain authentic Windows report and
runner artifacts for independent review before deciding whether any repair is
justified. The opt-in `windows-census-counterexample.yml` workflow exists;
this successor has not been dispatched. Dispatch must name the full published
candidate SHA and independent canonical tracked manifest SHA256. Keep the
actual producer report, stdout counts, native sort control, invocation, failure
receipts and before/after manifests. Require fresh current-candidate normal CI
and two fresh source-bound independent review axes before integration.

The later inconsistent PING creation identity and Chrome-parent attribution
remain unresolved. Actual Windows `DEBUG_PROCESS` execution is `not measured`.
Neither the controlled Bun children nor portable mocks establish production
Chrome descendant coverage, streamed census acquisition or survivor attribution.

The canonical full-source manifest hashes exact bytes except the two known ASCII
Windows launchers, `bin/sbar-orbit.cmd` and `install.cmd`. Under the declared
`*.cmd text eol=crlf` attributes, only their CRLF pairs normalize to LF. Bare CR
or non-ASCII launcher bytes are refused. Every other file hashes exact raw bytes.
Separate full checkout manifests hash unmodified bytes before and after so even
a checkout-only line-ending change invalidates the source-unchanged gate.
The producer records both canonical and checkout hashes, per-trial job-empty
receipts, handle/directory cleanup confirmations and monotonic elapsed times.
The independent provider verifier must inspect actual artifact bodies and the
exact published Git blobs; a run status or producer assertion alone cannot pass.
