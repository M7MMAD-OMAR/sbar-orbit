# Explicit reader journal and bounded output acquisition

4 November 2026, Asia/Dubai. Actual journal kernel probe: **3:05:36 PM to
3:05:37 PM**, or 11:05:36.256768 AM to 11:05:37.034058 AM UTC. Source baseline
`2fdadbb4a94b9511c38d29a873af9598a3dc0c36` plus the working-tree hashes below.
This is an internal prerequisite, not enabled multi-view or a new grant.

## Journal lifecycle changes

[ReaderScope](../src/native/reader_scope.py) now defaults to opening an existing
private journal only. Missing state refuses DEBT, without recreating it. Explicit
initialize=True is reserved to protected fresh-domain owner setup, uses EXCL,
never overwrites an existing journal and requires a recursively empty resource
root with no child directories/aliases. Client-provided booleans are not owner
authority; the runtime/registry integration remains unfinished.

The 64 KiB journal has a checkpoint only from validated idle/retired state, with
no retained helper/leaf and no work/children under the original root. It keeps
the original locked inode/descriptor and does not reset the single-use object
flag. It cannot checkpoint active, intent, admitted or recovery debt. A successful
rewrite stores a new valid no-work record and fsyncs it. Partial/empty/torn
rewrite refuses reopen; an error poisons the current instance and attempts to
invalidate the same inode. If storage also refuses invalidation, no durable
failure-marker guarantee is invented. A crash leaving the former valid retired
record or a complete valid new idle record can describe the same already-proven
no-work state; record bytes alone do not prove a particular fsync succeeded.

## Real kernel proof

The hardened [manual probe](../experiments/reader-scope-probe.ts) reran the
[previous 5 cases](reader-scope-acceptance-2026-11-04.md) and added sustained
healthy checkpointing, with Linux 7.2.15-200.fc44.x86_64, x86_64, Python 3.14.8.

| Measured item | Actual result |
| --- | --- |
| Scenarios | All 6 passed, exit 0 |
| Healthy create/retire/checkpoint cycles | 64 |
| Cumulative pre-checkpoint history bytes | 106368, beyond 65536-byte capacity |
| Maximum post-checkpoint journal size | 291 bytes; not a peak-RSS claim |
| Journal inode | Preserved across all cycles |
| Consumed object after checkpoint | prepare still refused DEBT |
| Parent/scope cleanup | Fresh owned parent removed, no cleanup errors |
| Shared resource controls | Values matched before/after |
| Native desktop operations | 0 |

Helper leaf ceilings were 32 MiB, 8 tasks, zero swap and 50000/100000 CPU quota,
inside a fresh 64 MiB/16-task owned parent. No shared controls were changed, and
no original application, profile, clipboard or foreign session was involved.
These ceilings concern cgroup charges, not a total device/RSS/GPU measurement.
Do not assume migrating a stopped bootstrap retroactively recharges all its
pre-admission allocations; the future producer must account its baseline and
post-exec work in the appropriate domains.

The owner-private result/journals retain exact process identities; those are not
published. Final source SHA-256 measured during the successful kernel run:

| Source | SHA-256 |
| --- | --- |
| [ReaderScope](../src/native/reader_scope.py) | 830c8c4712196947ec6375b8956cb6adff0605d0ac6bdd83347c179a639caf2b |
| [Probe](../experiments/reader-scope-probe.py) | 7b05f24b01b62d98aea6a0f580ea16e03bd03aa05884a038b148ea5e6359a9f8 |
| [Entry](../experiments/reader-scope-probe.ts) | f67b859d8d1cc7730c0ce0d47f9b74bdd9920939cb4f6d9692c6c6ea0e4334ca |

## Bounded output utility and source fixtures

[read_reader_pipes](../src/native/reader_pipe.py) is a separate dormant internal
utility for a trusted already-owned root and dedicated unconsumed binary pipes.
It spawns/signals nothing. Distinct FIFO identities are required, including
rejecting duplicated descriptors of the same FIFO. Streaming limits default to
1 MiB stdout and 16 KiB stderr, may only narrow, and detect a single overflow byte
before extending the reserved buffers. There is no text decoding or raw data in
fixed error messages. The absolute monotonic deadline is at most 3 seconds ahead;
checks and cancellation include selection, reading, root wait, result conversion
and final descriptor cleanup. Failure does not imply scope stop.

51 output tests comprise 49 controlled FIFO/Popen cases and 2 finite isolated
stdlib child processes for real binary roundtrip and overflow interoperability.
58 journal fake-kernel cases cover initialization/checkpoint failure/recovery
logic, including history beyond capacity and preserved lock/descriptor flags.
Wrappers require exact counts/no skips. Independent static review found no
actionable defect within the trusted-owner, dedicated-pipe contract. None of
these fixtures by themselves prove original-application or GPU behavior.

EOF and root exit are explicitly not recursive scope-empty evidence. Returned
bytes/returncode do not mint permission, imply external provider cancellation,
release a data reservation, or prove allocator reclamation. There is no public
MCP/CLI multi-view tool, producer wiring, new runtime worker or subscription.
Fixed capture bootstrap, provider/compositor completion, budget/cache/queue
integration, owner enrollment and two-view qualification remain unfinished.
Final verifier: 620 pass, 5 platform skips, 0 fail, 12587 assertions across
68 files in 68.64 seconds; strict root typing passed. An initial full run found
an existing parent-death fixture proc-read ESRCH race. That fixture was changed
to a pinned original pidfd exit witness and cleanup, including an alive-before-
parent-death assertion, then the full suite was rerun successfully. No production
a11y behavior or assertion was skipped. No phase gate or performance gain is claimed.
