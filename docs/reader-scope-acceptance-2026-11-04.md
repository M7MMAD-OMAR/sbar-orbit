# Owned reader leaf: kernel proof, not multi-view activation

4 November 2026, Asia/Dubai. Final explicit probe: **2:33:51 PM to 2:33:52 PM**
(10:33:51.889095 AM to 10:33:52.354231 AM UTC). Source baseline
`5ba8ad76c82234cc115c6f6675ec022a8520d247` plus the pinned working-tree sources
below. This is an owned-process/kernel test, not an original-application
capture, GPU-memory measurement, general process sandbox or phase-gate pass.

## Measured host and boundary

- Linux `7.2.15-200.fc44.x86_64`, x86_64, Python 3.14.8, actual cgroup2 fstatfs.
- Existing delegated Orbit resource root was writable by the current owner, with
  cpu, memory and pids controllers already enabled. No shared controls were enabled
  or changed. A new exclusive empty probe parent was created beneath it.
- Only this fresh parent received its own 64 MiB memory, zero swap, 16 tasks and
  50000/100000 CPU quota ceiling and child-controller configuration.
- Each [owned reader leaf](../src/native/reader_scope.py) was capped before
  admission at 32 MiB memory, zero swap, 8 tasks and 50000/100000 CPU quota.
  Limits were read back. This is separate from the logical 32 MiB observation
  accounting domain and the class default 256 MiB helper ceiling.
- No compositor interaction, desktop input/capture, application launch, personal
  profile, clipboard access, shared broker restart or foreign lease release.

## Final real-kernel scenarios

The [explicit manual probe](../experiments/reader-scope-probe.ts) runs an
[isolated stdlib fixture](../experiments/reader-scope-probe.py), never a native
application. The controller is a subreaper for its own fixture descendants.
Bootstraps arm parent-death SIGKILL, check the expected parent and stop before
any fork/work. Resume happens only after checked scope admission.

| Scenario | Actual result |
| --- | --- |
| Coordinator dies before admission | Stopped bootstrap died through parent-death SIGKILL and was reaped. No orphan helper outside the killable leaf was left |
| Fresh leaf, no admitted process | scopeEmpty=true, rootReaped=false, neverAdmitted=true. Same instance could not start another generation |
| Root exits and pipes reach EOF while a TERM-ignoring descendant survives | Retirement refused UNKNOWN. Only the pinned leaf cgroup.kill was used; after recursive populated0 and separate root reap, retirement succeeded |
| Scope becomes empty before the parent reaps its root | Retirement refused UNKNOWN until the retained original root was actually reaped and its birth identity no longer existed |
| Coordinator exits after admission without closing/finalization | Durable journal debt refused new admission with DEBT. Exact root/leaf identities were recovered, only that leaf was stopped, scope-empty was proved, and the receipt honestly retained rootReaped=false,recovered=true |

All 5 final scenarios passed, controller exit 0. The new parent was removed,
cleanupErrors was empty and shared resource control values matched before/after.
The result is narrowly **scope-empty and root-outcome separation**, not proof
that original external providers stopped or allocator/GPU pages were reclaimed.

Private result metadata and append-only journals were retained in the owner
cache. No raw owner-window/application content or PID/birth records are published.
Pinned source SHA-256 from the final run:

| Source | SHA-256 |
| --- | --- |
| [Reader scope](../src/native/reader_scope.py) | 0071b240f6f3af237d2fd1230dc47f936a6dfb5ce528b141ede3f38c504dd110 |
| [Probe fixture](../experiments/reader-scope-probe.py) | d059aafe753f22deea0ae67ba128ed71bcf475976b3bc821e23740711ec7dd54 |
| [Manual entry](../experiments/reader-scope-probe.ts) | f67b859d8d1cc7730c0ce0d47f9b74bdd9920939cb4f6d9692c6c6ea0e4334ca |

## Review and deterministic evidence

36 deterministic fake-kernel Python cases cover journaling/fsync ordering,
flock, unsafe paths/files, replaced inode/FD/root/journal identities, strict
limits, admission, root/descendant distinction, missing/corrupt debt, recovery
and stale callbacks. The Linux wrapper requires the exact count and no skips.
These are logic fixtures, not an actual kernel qualification by themselves.
Final full verifier: 619 pass, 5 platform skips, 0 fail, 12583 assertions across
67 files in 68.57 seconds. Final strict root typing exited 0.
Manual CLI guard tests preload a spawn-denial fixture, so help/invalid-argument
regressions fail instead of accidentally launching a real helper.

Independent static review found a real manual-probe failure path: timeout could
kill the coordinator after spawning a stopped bootstrap but before admission,
leaving it outside the fresh owned parent. A SIGALRM does not terminate a stopped
process. The initial 4-scenario successful run did not exercise that fault. The
probe was repaired with parent-death SIGKILL plus startup-race checking, only
cleared after successful admission/resume; the new pre-admission death scenario
was then run on the actual kernel. Follow-up review found no additional critical
cleanup issue in this scoped fixture. Initial parent creation was also moved
inside its cleanup boundary, with private artifacts prepared first.

## What is not implemented or granted

[ReaderScope](../src/native/reader_scope.py) is a dormant internal primitive. It
does not spawn/resume helpers or read their pipes. The trusted producer must
restrict admitted Popen objects to a fixed reader bootstrap; an own stopped
subprocess is not by itself application/read authority. Root and journal paths
must come from protected owner runtime, with one fixed journal per accounting
domain. Choosing alternate journals is not a supported debt bypass. First-file
initialization is supported by this low-level constructor, so runtime recovery
must independently retain the expected journal identity and must not reinitialize
a missing journal for an existing domain. This registry integration is unfinished.

The 64 KiB journal currently fails closed at capacity, including after healthy
retired operations; a proven-empty checkpoint/rotation policy is still needed
before a sustained runtime cohort. Journal debt is never evicted on timeout,
EOF, missing/replaced
paths, incomplete intent or restart. Single-use instances plus flock prevent
stale methods from retargeting a later generation. Recovery after a disappeared
leaf or pre-inode intent remains unknown rather than inferring completion.
The persistent journal cannot be treated as arbitrary model-provided metadata
or as a new grant. Same-UID hostile filesystem/cgroup tampering is not sandboxed.

Bounded helper streaming, a fixed capture producer, deadline propagation,
pre-allocation scratch/payload admission, cache/reference ownership and the
broker/TS/native integration remain unfinished. Existing cold/warm accessibility
and legacy capture are not silently upgraded by this primitive. OS helper
ceilings do not measure all representation copies, external original-app or
provider/compositor workload, GPU allocations or global peak memory. No
multi-view gate, two-view workflow or performance improvement was claimed.
