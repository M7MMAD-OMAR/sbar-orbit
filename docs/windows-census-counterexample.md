# Prepared Windows census counterexample

This opt-in fixture is unexecuted. It is not a collector repair, Windows exit
capability pass or independent review. The existing browser-crash collector and
Windows job implementation remain unchanged.

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
justified. No CI workflow or dispatch has been added.
