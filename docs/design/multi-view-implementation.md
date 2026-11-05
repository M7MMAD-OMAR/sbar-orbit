# Multi-view implementation ledger

Started 4 November 2026, Asia/Dubai, following the owner request to implement the
[plan](multi-view-plan.md). Source baseline:
`ffa32d5e6558435190d53679e0fabd870ea8e809`, version `0.4.3` candidate.

**Status: prerequisite repairs and an internal passive observation seam are
implemented; multi-view is not available. No phase gate has passed.** No additional
model, capture subscription, writer, plugin protocol or desktop permission has
been enabled. Windows testing remains with
the owner-operated Windows 11 workflow. No release or site deployment occurred.

## 1. Completed prerequisite changes

### Caller-scoped operation identity

[Sessions](../../src/session.ts) now keys native opening, presentation and automatic
workspace allocation by an unambiguous JSON tuple of broker-resolved caller ID and
requestId. Identical IDs from different conversations do not share a result,
workspace reservation, conflict or approval-denial eviction. Same-caller duplicate
requests retain the original result, including uncertainty. Device-wide cache caps
are unchanged; no result is evicted to make an uncertain mutation retryable.

This repair exposed a compatibility hazard: a process-only CLI or adapter identity
changes when the process restarts. Such external opening/presentation requests now
refuse before native work with `CONVERSATION_REQUIRED`. Set the actual host
`ORBIT_CONVERSATION_ID` consistently across CLI and adapter processes. Unidentified
callers also refuse. Read-only discovery is unchanged. The human owner credential
continues to provide the same owner identity; agents must not use it. This is still
cooperative caller attribution, not an owner-issued multi-view capability or a
hostile same-user security boundary.

[CLI](../../src/cli.ts) opening now preserves an explicitly supplied JSON requestId,
matching presentation. Otherwise the existing environment ID or generated ID is
used. A new generated ID is not permission to repeat an uncertain operation. The
cache is broker-memory only: after a broker restart, inspect actual application
state rather than assuming exactly-once delivery.

[Operation-scope regressions](../../tests/native-operation-scope.test.ts) exercise
cross-caller duplication/conflicts, approval refusal versus another caller
uncertainty, delimiter injection, automatic workspace allocation, process-only
transport refusal and real separate CLI processes through a private broker with
mocked native effects. They verify JSON identity precedence, unchanged same-
conversation uncertain outcomes and separate-conversation dispatch. No original
application is opened by those tests.

### Shared clipboard preservation

[Paste fallback](../../src/native/paste.py) no longer reads, replaces or restores
CLIPBOARD, touches PRIMARY, sleeps, or sends a paste key. It raises the existing
`UnsupportedText` type before attempting that fallback. The old text-only snapshot
could lose MIME offers and overwrite a later owner copy. Byte equality and a
read-then-restore check are not atomic ownership proof, including same-bytes/new-
owner races. The available wl-clipboard command interface cannot provide the
required compare-and-replace transaction, so this route is unavailable rather
than deceptively repaired.

**Intentional capability reduction:** text not representable by the native direct-
stroke implementation and current keymap now refuses. This is not a general
statement about physical keymap/AltGr/IME capability or a language ban. Native
direct text and explicit application Copy/Paste keys retain their prior routes.
There is no private clipboard, owner lockout or clipboard-generation claim. A
future restoration route requires an ownership-aware atomic mechanism and its own
qualification, not another fixed delay.

[Worker serialization](../../src/native/session_worker.py) emits a fixed, content-
free `TEXT_UNSUPPORTED` explanation instead of arbitrary exception text or the
generic worker-log message. [Owned paste tests](../../tests/native_paste_test.py)
cover MIME/PRIMARY preservation, empty/binary selections, later owner copies,
same bytes with different ownership, helper read failure, no environment probe,
no default subprocess/wait/key, secret-free errors, actual `NativeSession.execute`
failure propagation and direct-text success through real control bookkeeping.
They also invoke production worker error serialization with private exception
text. These are synthetic fixtures, not live keyboard/clipboard acceptance.

Both [operation tests](../../tests/native-operation-scope.test.ts) and the
[paste wrapper](../../tests/native-paste.test.ts) are included in the
[default verifier](../../scripts/verify-desktop.ts) with its existing missing-file
guard. The wrapper checks that all 11 Python cases execute without skips.

## 2. Independent review

A separate read-only review found the process-lifetime retry hazard, missing
public clipboard refusal explanation, lack of execute/worker integration tests,
and overly broad keymap wording. The changes above address each finding. The
review did not run tests or establish native acceptance; later fixes require
the verification recorded below. It found no new content leakage in the scoped
implementation and confirmed that the plugin preflights the whole text before
sending its strokes.

## 3. Executed verification

All commands use Bun. Lead verification runs one job at a time under the existing
resource preflight and a user scope capped at 1536 MiB memory, zero swap, 150 percent
CPU and 256 tasks. Owner applications are not put in test scopes or terminated.

| Run | Actual result | Scope/limit |
| --- | --- | --- |
| Initial focused caller/open/presentation tests | 22 pass, 0 fail, 113 assertions | Before later CLI and diagnostic review fixes |
| Expanded compatibility fixtures | 65 pass, 0 fail, 378 assertions across 11 files | Before later CLI guard broadening and public diagnostic fix |
| CLI and execute integration fixtures | 8 pass, 0 fail, 47 assertions | Real separate CLI processes, mocked native effects; before adapter/client guard broadening |
| Default verifier | 570 pass, 5 skip, 0 fail, 3149 assertions across 62 files, 69.98 seconds | Before final public diagnostic and all-transport identity guard review changes; not a final-tree claim |
| Post-review worker/capture/clipboard/operation fixtures | 28 pass, 0 fail, 162 assertions | Fixed public diagnostic and 11 Python clipboard cases; before all-transport identity guard broadening |
| Strict root type check | Exit 0 | Includes CLI JSON identity repair; before final all-transport guard broadening |
| Final functional-tree default verifier | 570 pass, 5 skip, 0 fail, 3155 assertions across 62 files, 69.65 seconds | Includes all external transport guards, fixed public diagnostic and all 11 Python clipboard cases |

Final functional-tree strict root type checking also exited 0. Reproduction for
the final default-suite run (after fresh resource checks):

```sh
bun run scripts/limited.ts systemd-run --user --scope --quiet --collect \
  --slice=sbarorbit.slice --property=MemoryMax=1536M \
  --property=MemorySwapMax=0 --property=CPUQuota=150% \
  --property=TasksMax=256 bun run verify
```

Use the same bounded wrapper with `bun run typecheck` for strict typing. A
temporary full-memory PSI rise above 2 paused further verification until a fresh
sample recovered; no owner process was stopped to free capacity.

Counts are Bun tests, not a sum of their nested Python cases. The 5 default-suite
skips are two platform socket cases, native macOS plist discovery, native Windows
registration discovery and the Windows deny-delete handle. No new Windows
acceptance is inferred from Linux fixtures. Later final-tree results will be
recorded separately, not substituted retroactively into earlier evidence.

## 4. Gate status and next dependencies

The [historical audit](multi-view-current-state.md) remains baseline evidence,
not current proof of unfixed cache/restoration code. The machine-readable
[work items](multi-view-work-items.json) now record implementation in progress.
`MV-00` is not complete: ingress/cohort review and actual qualified app/build
acceptance remain required. The other work items are not complete, and none of
the 30 proposed multi-view adversarial scenarios is claimed passed by these
prerequisite tests alone.

Next dependency-ordered work:

1. Review the completed [ingress and final-consumer inventory](multi-view-ingress.md).
   It establishes source reachability, not cancellation/drain or live acceptance.
   Freeze the versioned cohort handshake, authority source, resource limits and
   initial app/build qualification without inventing live evidence. In particular,
   image observation refreshes a cursor through a handler that can flush pending
   input callbacks. The internal passive seam in section 5 now omits that command;
   live capture/owner-preservation qualification remains required before P1 read
   concurrency, and legacy cursor-refresh work remains classified as effectful.
2. Introduce private caller-bound read-only view records and bounded observations.
   No second lease for an already leased client; no unauthorized image fallback.
3. Integrate a host-neutral status/consent surface and qualify two-view reads.
   The host supplies reasoning; Orbit does not embed a provider engine.
4. Add device-resource-wide arbitration and endpoint fences, including delayed
   compositor callbacks, then revocation/drain and durable uncertainty barriers.
   A broker-only mutex or check before an async queue is insufficient.
5. Cover all old/new mutation routes, measure actual original applications and
   owner preservation, then opt in only the passing capability subset.

The latest [single-view live evidence](../efficiency-native-acceptance-2026-11-04.md)
records Hyprland 0.57.1 Calculator arithmetic with a failed settled image capture
and unestablished pointer preservation. Subsequent source fixtures do not turn
that into a passed native rerun. No new desktop operation, broker restart,
compositor reload, owner-window closure or clipboard operation was performed in
this prerequisite tranche. Unknown input quiescence remains unknown.

## 5. Internal passive observation seam

Implementation tranche after `cba9500bd2872f28b6ce61c7ed961f01965389ce`. This
adds an internal observation mode, not a public multi-view tool or a passed
`MV-00`/`MV-GATE-01`. No plugin source, ABI, loaded instance, shared broker or
original application was changed/restarted for this work.

[NativeSession](../../src/native/session.py) accepts only the literal
`observationMode: "passive-v1"` on observe actions. Image, both, digest, settled
and bounded-resample capture paths omit `_ensure_pointer`; passive text returns
text with the actual tree status, including unavailable, instead of capturing
unauthorized fallback pixels. Successful responses extend existing observation
metrics with `mode: "passive-v1"` and `cursorRefresh: "omitted"`. Legacy requests
without the new mode retain their old behavior and response semantics. The
helper comment now correctly labels legacy cursor refresh as effectful.

[NativeBackend](../../src/hyprland.ts) exposes an internal `observePassive` method
with an explicit owned target and a finite integer worker budget of 100 to 3000
ms, default 1500 ms. It requires that exact acknowledgement plus inline scoped
window metadata, rejects old/missing acknowledgements without a second read or
a legacy fallback, rejects passive text/image substitution, and does not commit
writer selection, pointer, scale or window state. Its presence result contains
only the captured target, not sibling window titles or handles. The normal
public CLI/MCP observation route has not been migrated or broadened. No new
background worker, subscription, timer, capture loop or model is created.

### Independent review repair: worker metadata

The first independent read-only review found that omitting cursor refresh and
protecting TS state was insufficient: production window enumeration still
registered siblings, changed stored sizes and cleared writer pointers on shrink.
The initial Python fixture mocked those methods and could not expose the bug.

[ExistingApplicationSession](../../src/native/existing.py) now has an internal
`commit=False` enumeration path. It validates current retained window identities
and sizes but does not enroll unknown sibling handles or mutate stored targets.
Passive `_target` uses it and returns a detached deep copy with current geometry;
an out-of-bounds pointer is cleared only in that local snapshot. A follow-up
review also found that unavailable text could return an old detached size after
a tree query resized the target; passive mode now refuses any tree-query geometry
change even when the tree is unavailable, without fallback pixels. Every passive
capture validation and final acknowledgement uses noncommitting enumeration.
Geometry resampling updates only the detached capture state, not a rollback of
shared writer state. Production-method tests now cover real detached resize
retry/exhaustion and stable/unavailable text, not only stubbed target behavior.
Default `commit=True` behavior is unchanged.

[Production Python fixtures](../../tests/native_observation_passive_test.py) now
include 14 cases using actual production execute, target and enumeration methods
with only OS/capture/control boundaries faked. They check value and object-identity
preservation for original maps, window records, size lists and pointers across
success, failure, sibling shrink/discovery, late invalid metadata and replacement.
The original 15 execute/parser/fault-injection cases cover images, unavailable
text, both, digest, settle, geometry retries/deadlines, capture failures, strict
mode validation and legacy parity. The [wrapper](../../tests/native-observation-passive.test.ts)
asserts all 29 run without skips. [Backend fixtures](../../tests/native-observation-passive-backend.test.ts)
cover downgrade refusal, malformed metadata, explicit target/budget, no sibling
export and no overwrite of writer state changed while an observation waits.
Both new wrappers are mandatory in the default verification list.

### Verification and limitations

- Focused backend/legacy observation/native/a11y/deadline suite: 73 pass, 0 fail,
  262 assertions across 5 files, 1.99 seconds.
- Focused production passive/backend/roundtrip/native/deadline/session-text suite:
  85 pass, 0 fail, 354 assertions across 6 files, 1.77 seconds. The passive wrapper
  executed all 25 Python cases; nested cases are not added to the Bun test count.
- Complete default verification before the follow-up unavailable-text geometry
  repair: 586 pass, 5 skip, 0 fail, 3239 assertions across 64 files, 75.07 seconds.
  This does not establish the later repair or newly added geometry fixtures.
- Final functional-tree default verification, including the unavailable-tree
  geometry repair and all 29 Python passive cases: 586 pass, 5 skip, 0 fail,
  3239 assertions across 64 files, 69.26 seconds.
- Final strict root type check exited 0. All commands used the same bounded
  one-job-at-a-time wrapper described in section 3. No live desktop acceptance
  or throughput/performance gain is inferred from these source fixtures.

The mode acknowledges omission of cursor refresh only. It does not establish
that unrelated queued compositor callbacks stopped, that no human/OS client
changed the target, that a prior overlay is absent from pixels, or that image
and accessibility data form an atomic semantic snapshot. Its deadline starts
in the worker after queue wait; client cancellation and global capture admission
are separate unfinished contracts. Retained-reference authority, host-issued
caller grants, binding/topology/revision epochs, resource reservations, native
app/build acceptance and owner-interference measurements remain required.
Multi-view enablement and all phase gates remain unpassed.

## 6. Owned native qualification and P0 decisions

The subsequent [dated native run](../multi-view-native-acceptance-2026-11-04.md)
and [content-free exact record](../multi-view-native-acceptance-2026-11-04.json)
measured the internal passive seam on original Calculator 50.0, Fedora 44,
Hyprland 0.57.1 with exact source/ABI/binary agreement. The newly attributed window
was on an already visible numbered workspace. Image, text and both succeeded;
one ordinary arithmetic input was confirmed as 1+2=3 by viewed pixels and tree.
There were 44 successful passive observations, including 20 image and 20 cold-text
samples, all with unchanged TS backend state. Empirical worker median costs were
67.980 ms image and 174.252 ms cold text. These are unlike output formats and not a
paired task-speedup comparison, warm benchmark or productivity claim.

Read-bracket focus, physical pointer and output/workspace samples matched.
Opening/handoff pointer samples changed with unestablished cause and do not pass
setup preservation. GTK/minimum-size and physical rounding produced 1020x962
result frames; the proposed 1280x960 feature envelope would refuse these. No
limit was raised to qualify the example. Exact normal test closure, candidate
disappearance and own session handback were verified, private controller exited 0,
and the shared broker/other sessions were not restarted or released.

The [P0 cohort decision record](multi-view-cohort.md) freezes a default-off
read-only design with explicit owner-enrolled connector authority, per-operation
passive acknowledgement, bounded capture/payload/memory/queue decisions and a
restricted measured matrix. A second original view must be explicitly selected
and independently qualified, not silently created or substituted. This is not
an implemented grant API, a passed MV-00 gate or admission proof. Owned reader
cancellation/drain and global scratch/capture reservations remain the next
prerequisite work.

Independent harness review additionally found unlatched uncertain input and
identity tracking only after artifact writes. The manual-only controller now
quarantines failed/partial/uncertain setup/input, blocks subsequent mutations and
automatic closure, permits read-only inspection plus own pause/stop, records
acknowledged identities before evidence IO and reports unresolved opening or
handoff outcomes without guessing a cleanup target. Pure barrier tests cover
this control flow; it is not the missing native consumer fence/quiescence receipt.

The TS framed worker adapter still had stale advice to paste unsupported text
through the shared clipboard, overriding the repaired Python error. That fixed
public override now states the actual direct-stroke/keymap limitation and unsafe
fallback refusal. A real framed-worker fixture verifies typed errors, request
and worker-message redaction, and an unaffected subsequent status exchange.

Source verification after this tranche: 594 pass, 5 skip, 0 fail, 3507 assertions
across 65 files in 68.64 seconds after platform-safe guard registration. Manual-only guard fixtures cannot open an app in
the default suite. Strict root typing passed before live use; the actual native
run and source fixtures are separate evidence layers. No release, site deploy,
new public multi-view tool, remote device or extra seat was enabled.

## 7. Dormant read reservation lifecycle kernel

[ReadResourceBudget](../../src/multi-view-read-budget.ts) is an internal, dormant
accounting kernel. No production module imports or constructs it, and importing
or constructing it creates no timer, worker, queue, model, native action or
authority grant. Its logical domain defaults to 32 MiB, each view to 16 MiB,
8 views across 4 conversation keys, 2 views per conversation, 2 live entries per
view and 32 references per retained entry. Overrides may only narrow caps.
These are bounded logical accounting parameters, not measured RSS guarantees
or proof that existing consumers obey them.

Opaque frozen object identities are private to one instance. Forged, cloned,
cross-instance or stale handles cannot reserve/recover its credit. Strict data-
property snapshots reject accessors, unknown fields, symbols, coercions and
nonfinite/unsafe values. Reentrant proxy inspection is completed before current
view revocation and capture admission are checked. Private limits remain binding
even if a caller shadows the public limits getter. Errors contain no raw labels,
targets, request contents or caller-provided fields.

A reservation charges the peak scratch-plus-result overlap and occupies the
instance capture slot before work starts. Before-start cancellation can release
credit because no owned work was admitted. After start, cancellation suppresses
delivery but retains occupancy; unknown stop additionally quarantines it. Only
the trusted per-operation lifecycle callback may report quiescence. A late
completion after cancellation/quarantine discards the result; it cannot revive
old delivery or free a newer reservation. No timeout/TTL/response flag forces
credit release and there is no public force-release method.

Known-quiescent successful work can transfer to one retained reference, releasing
only reserved scratch credit. Retain/release tracks shared immutable ownership,
not deep copies: all external references remain charged after view revocation
until explicitly released. The aggregate counter requires balanced internal
calls; it is not a per-consumer idempotent release ticket. Delivery integration
must deduplicate each consumer release and must never expose reservation handles
as recipient authority. Additional copies need separate prior allocation
reservations. A view cannot be disposed/reused until revoked and empty. Metadata
entry/reference caps prevent tiny declared allocations growing unbounded maps.
The kernel does not implement freshness, latest-value coalescing, fair queueing,
host identity, frame allocation, process supervision or durable crash recovery.

[Deterministic tests](../../tests/multi-view-read-budget.test.ts) cover strict
limits, aggregate byte overlap, capture admission, reference-held revocation,
unknown stop, late/stale callbacks, forged handles, descriptor reentrancy and
limit-shadow resistance. Independent static review found no definite accounting
defect, but caught weak low-bit LCG transition coverage. The fixture now uses a
mixed-bit generator, seeded real lifecycle transitions and explicit coverage
assertions for all 8 operations and all 5 phases, in addition to 1000-step byte/
reference/capture conservation checks. Focused final tests: 22 pass, 0 fail,
9065 assertions. The final complete default verifier passed 616 tests, skipped
5 platform cases, failed 0, and executed 12572 assertions across 66 files in
68.33 seconds. Final strict root typing exited 0. The default verifier includes
the new fixture with its missing-file guard.

The [owned-reader drain audit](multi-view-reader-drain.md) identifies the next
required adapter work. Current capture and cold accessibility cleanup do not
prove descendant termination; cold capture_output is collected before slicing.
The warm helper can reap a root after TERM without proving its remaining group
empty. Shared resource slice membership, EOF, a passive acknowledgement or a
resolved NativeWorker promise are not owned scope-empty receipts. Raw/raster
crop, base64/JSON/parse copies, retained replies, helper baseline memory and
external original-app/provider work are distinct domains. No guessed overhead
multiplier or compressed PNG length proves their peak.

Accordingly **the kernel is not wired to existing helper completion or public
requests**. A generation-bound owned supervisor, pre-allocation enforcement,
end-to-end queue/cancellation and retained-result ownership integration must
precede feature admission. No real memory ceiling, reader drain, two-view
qualification or new phase gate passed in this tranche. No native operation,
shared broker restart, lease release or original-app change was performed.

## 8. Owned cgroup leaf and durable reader debt

[ReaderScope](../../src/native/reader_scope.py) adds a dormant Linux cgroup2
primitive, not a grant or public process runner. It validates the actual pinned
filesystem, creates an exclusive random child leaf, pins root/leaf inode/device
identities and configures/readbacks helper memory/swap/task/CPU ceilings before
admitting a retained own stopped subprocess. Parent controls and parent cgroup
kill are never used by the primitive. The producer must be a trusted fixed reader
bootstrap; a Popen object alone does not grant original-application authority.

A private flock-protected append journal is bounded to 64 KiB. Intent is fsynced
before mkdir, leaf identity/limits before admission and killing state before the
kill write. Partial/torn, missing/replaced or unavailable scope state remains
debt. Closing a handle drops local descriptors, not debt or resource credit.
Recovery verifies the original boot/root/leaf identities and old owner birth
death. It can report scopeEmpty but does not manufacture the former parent's
rootReaped witness. Each object is single-operation, so late bound callbacks
cannot retarget a newer generation through object reuse. The owner runtime must
pin one root/journal pair per accounting domain rather than let clients create
alternate journals or reinitialize a missing journal for an existing domain.
An independent expected-journal identity belongs in that runtime registry; the
low-level constructor still supports explicit first-file initialization.

The [dated exact kernel report](../reader-scope-acceptance-2026-11-04.md) records
5 real-kernel owned-fixture scenarios, including pre-admission coordinator death,
root exit/EOF with a live descendant, separate root reap and durable orphan debt
recovery. All passed with no cleanup errors; the fresh parent was removed and
shared resource controls were unchanged. No desktop application, compositor,
clipboard, original profile or other sessions were acted upon. The 32 MiB helper
ceiling used in this probe is independent of the logical observation-buffer
ledger and is not a global RSS/GPU/representation-memory measurement.

Independent review caught a real probe-only pre-admission leak under coordinator
timeout. The bootstrap now arms parent-death SIGKILL with a startup-race check
before stopping, clearing it only after admission/resume. A new real owner-death
fixture verified the repaired boundary. Follow-up review found no additional
critical issue within the stated trusted-owner scope.

[Fake-kernel tests](../../tests/native_reader_scope_test.py) cover 36 distinct
cases without real cgroup writes/signals. The [mandatory wrapper](../../tests/native-reader-scope.test.ts)
requires their exact count/no skips; help and invalid-argument guard fixtures
preload spawn denial so regression cannot accidentally start a real helper.
Final verifier: 619 pass, 5 skip, 0 fail, 12583 assertions across 67 files in 68.57
seconds; final strict root typing exited 0. Actual kernel evidence and deterministic
fixtures are explicitly separate layers.

This primitive is not imported by production consumers. The fixed capture
producer, bounded stream reading, deadline propagation, actual allocator/scratch
admission, broker/TS/native integration and retained consumer-release tickets
remain next work. Existing capture/a11y completion is not automatically a trusted
scope receipt. No multi-view phase gate passed, no second view or new public
permission was enabled, and source 0.4.3 remains an unpublished candidate.

## 9. Explicit journal lifecycle and bounded reader output

[ReaderScope](../../src/native/reader_scope.py) now defaults to existing journals
only; missing state refuses DEBT. Fresh setup must explicitly initialize under
protected owner runtime, with EXCL/no-overwrite and recursively empty/no-child
root checks. This flag is not client authority. Checkpoint compacts only known
idle/retired state after original root/journal validation and exclusive ownership,
with no helper or leaf retained. The same inode/flock and single-operation object
flag survive. Partial/empty/torn checkpoint storage refuses; current failure
poisons the instance and attempts same-inode invalidation. Complete valid old
retired/new idle images after crash describe only already-proved no work. No
algorithm can infer successful fsync or guarantee fault marking on failed storage.

The [new dated kernel report](../reader-journal-acceptance-2026-11-04.md) reran
the prior 5 scenarios and 64 healthy create/retire/checkpoint cycles: 106368
cumulative pre-checkpoint bytes, 291-byte maximum post-checkpoint record, unchanged
inode, no object reuse, no cleanup errors, fresh parent removed, shared controls
unchanged. No original application/desktop/clipboard operation was performed.
Helper cgroup ceilings are charge limits, not global RSS, migration recharging,
GPU/provider completion or observed peak-memory evidence.

The separate [reader pipe utility](../../src/native/reader_pipe.py) consumes
dedicated unconsumed binary pipes from a trusted owned root. It creates no
process, signal, grant or runtime subscription. Distinct FIFO identity prevents
aliases splitting stdout/stderr accounting. Nonblocking selector reads have
strict lower-only 1 MiB/16 KiB byte bounds and at most one unappended overflow
sentinel; the absolute deadline/cancellation path includes root waiting, result
conversion and final cleanup. Errors carry fixed content-free messages, not
output or commands. EOF/root status is explicitly not a scope-empty receipt.

Output fixtures cover 49 controlled cases and 2 finite isolated stdlib children
for actual binary pipe/selector interoperability and overflow. Journal fixtures
now cover 58 cases. Exact counts/no skips are required by the wrappers, and all
are included in the default verifier. Independent static review found no
actionable defect within the trusted-owner/dedicated-pipe contract.

Initial full verification exposed an existing accessibility parent-death fixture
race: the worker disappeared while its proc text was being read, producing ESRCH
rather than ENOENT. The fixture now pins the original worker with a pidfd while
its parent retains it, requires it alive before parent death, waits on original
process-exit readiness and uses only that pinned handle for cleanup. This is a
stronger root-only witness, not warm-helper descendant/GPU drain qualification.
No production accessibility implementation or assertions were skipped.

These modules remain dormant and unimported by production consumers. Fixed
capture bootstrap, scope-plus-stream producer integration, external provider
completion, allocator/cache/queue ownership, owner-issued enrollment and status
UI remain unfinished. No multi-view gate passed or feature was enabled.

Final verification for tranche 9: 620 pass, 5 skip, 0 fail, 12587 assertions across
68 files in 68.64 seconds; final strict root typing passed. All 109 journal/output
Python cases and their wrappers remained mandatory. No release or site deploy.

## 10. Owned capture orchestration and broker read slice

The [owned-scope producer](../../src/native/reader_process.py) now composes
durable pre-spawn intent, a fixed stopped bootstrap, exact retained child birth,
owned scope admission, pidfd resume, bounded pipe reading, strict PNG validation
and separate scope-empty/root-reaped retirement. No generic command, raster
fallback or implicit target resize is allowed. A spawn with no bound child remains
UNKNOWN even if its cgroup is empty. All producer errors report both owned scope
and external provider completion UNKNOWN. A successful PNG and drained owned
helper still do not prove compositor/GPU/provider work finished; the conflicting
provider resource cannot be released on that evidence alone.

The [dated seven-scenario kernel report](../reader-producer-acceptance-2026-11-04.md)
records real owned-process scope behavior on exact source hashes, without native
desktop or original-application operations. The fixed capture producer itself was
verified with fake scope/process fixtures, not a live application. There are 76
scope, 28 producer, 28 PNG and 26 bootstrap Python cases, each wrapper checking
its exact count without skips. Actual external-provider drain, physical pixel
geometry, memory accounting across representations and an independently qualified
second installed application remain unresolved.

The [read-view registry](../../src/multi-view-views.ts) and [Sessions integration](../../src/session.ts)
now exercise an owner-to-two-view read-only vertical in [broker fixtures](../../tests/multi-view-broker.test.ts).
It binds a protected recipient/channel and live caller birth to already-owned
sessions, validates current read policy and binding, issues a hidden random grant,
charges the existing budget before fake work and suppresses late delivery after
revocation. One capture is admitted at a time, with no automatic polling, new
lease, application setup or fallback. Unknown provider work keeps the credit
occupied. Concurrent enrollment, duplicate physical binding, reentrant callbacks,
stale grant expiry, policy/owner changes and off during diagnostics were covered
and repaired after independent review. Status is all-or-nothing per enrollment.

This broker path is deliberately **fixture-only**. The ordinary IPC transport does
not provide its protected channel; production constructs no read registry and no
reader backend. Injected fixture usage epochs are not current CLI/MCP off. The
existing on/off file and old concurrent adapters do not provide broker-wide
revocation, durable epochs or a final transport delivery fence. A production
owner/connector enrollment channel, cross-process off protocol, accounted
serializer and qualified producer adapter are still required. Returning a test
lease is not a public API or permission to expose captured data. No multi-view
phase gate passed and no feature was enabled by this tranche.

Independent review found and fixed five concrete broker races: concurrent
enrollment overwrite, duplicate binding objects, stale grant pointers, reentrant
registry enrollment and final lease access after an injected off change. A sixth
status bug could publish one stale view before another invalidated the grant;
status now commits a complete live enrollment or none. The first full verifier
run also found new diagnostic codes missing from the allowlist. They are now
explicitly classified; no raw content is journaled. Two initial broker fixture
setup errors and eager Bun rejection matchers were corrected without weakening
assertions or hiding failures.

Final default verification: 695 pass, 5 skip, 0 fail, 13337 assertions across
72 files in 71.25 seconds. Strict root TypeScript validation passed. No release,
site deployment, Windows implementation or shared broker restart was performed.

## 11. Protected connector exchange in broker fixtures

The [connector channel registry](../../src/read-channel-registry.ts) implements
a bounded owner-authorized one-use enrollment exchange into a distinct transport
secret. It binds an exact protected connector instance, process birth, conversation
and approved view/format subset. Revocation invalidates the channel before
notifying the read registry; failed notification retains a quarantine slot, not
a stop receipt. Clock faults latch closed and do not revive earlier credentials.
No token, process metadata or selected content appears in model-facing status.

[Sessions](../../src/session.ts) now connects that registry to its existing
fixture-only protected read-view path. In owned tests an owner can issue and
activate a channel, enroll selected already-owned views, read through a bounded
lease and revoke it. The read transport permits only views.status and views.read,
not legacy actions, opening, diagnostics or owner operations. A separate actual
private IPC test verifies the real broker remains unavailable for these methods,
even with an owner credential or spoofed body/header. The test-only connector
bridge is not a production endpoint.

Independent reviews found and repaired reentrant clock/caller authorization
races, accidental disclosure of enrollment fields to the process verifier,
non-atomic activation bookkeeping, post-diagnostics delivery of revoked secrets,
a delayed idempotent issue that could revoke a successful activation, and
mutable-array format attenuation bypass. Strict data-property snapshots and
regressions cover these cases. Both connector and view registry failures retain
unknown reader credit instead of inferring completion.

A proposed change to the real CLI/MCP usage file was rejected during review:
a nonblocking lock could cause explicit off to fail while the prior state stayed
on, and old writers/path replacement still defeated the intended cross-process
revision guarantee. The uncommitted change was removed; existing usage behavior
was preserved. A real broker-owned off acknowledgement, mixed-version handling
and final serialized delivery fence remain required, not solved by a nonce or a
fixture callback. Existing same-UID caller attribution is cooperative and lacks
kernel peer credentials; a protected inherited channel or equivalent verified
transport and owner-mediated approval are not yet implemented.

The existing producer still reports external compositor/provider completion
UNKNOWN. Installed Wayland protocol text says per-frame ready permits that
buffer to be read/reused, but does not acknowledge cancellation or global GPU
quiescence. The active `grim -T` runtime path and identity mapping were not
qualified by inspecting strings alone. No feature gate passed, production IPC
remains unavailable, and no native application or shared broker was touched.

Final verification for this tranche: 777 pass, 5 skip, 0 fail, 14286 assertions
across 74 files in 70.52 seconds. Strict root TypeScript validation passed.

## 12. Accounted protected delivery in fixtures

The [read budget](../../src/multi-view-read-budget.ts) now reserves up to 64 KiB
of delivery scratch before each copy. A single retained frame can hold one
outstanding delivery loan. Releasing the last frame reference or revoking its
view does not free either the original frame or the copy reservation while a
loan remains. The opaque loan is idempotently returned only after trusted sink
drain; it does not allocate another capture slot.

The [delivery controller](../../src/read-view-delivery.ts) is integrated with the
existing protected Sessions lease in [fixture tests](../../tests/read-view-delivery.test.ts).
It copies one chunk at a time into a separate backing buffer after reservation,
so the sink cannot reach other chunks through that buffer. A trusted terminal
receipt must cover every sink alias and queued use. Once a stop is requested, a
late write acknowledgement alone cannot release the loan; an explicit stop
receipt is required. Timeout, abort, thrown code and promise completion never
stand in for that receipt. Unknown work remains quarantined.

Independent review rejected the earlier zero-copy draft because a chunk view
exposed the entire frame buffer and constructor callbacks could claim the same
lease twice. The new version uses own-data snapshots, claims the lease before
callbacks and reserves a separately backed copy. A subsequent review added
post-callback lease-release checks and required stop confirmation for outstanding
async stop aliases. Status can report later cleanup after an immutable initial
result; it does not manufacture a completed delivery or retry.

This is still a **trusted in-process fixture boundary**. Its combined synchronous
dispatch guard, timer and sink receipt are trusted components, not untrusted
client assertions. Existing raw lease bytes can have been retained by a prior
owner; the caller must transfer exclusive ownership with no earlier aliases. A
production transport must hide or move raw lease access, bind actual owner/off
authority, account its own buffers and prove sink/provider drain. Existing IPC
does not expose this controller and no feature gate passed.

Final source verification: 833 pass, 5 skip, 0 fail, 16411 assertions across
77 files in 71.21 seconds. Strict root TypeScript validation passed.

## 13. Owner status and broker-owned usage fixture

The ordinary broker provides owner-credential-only `views.owner-status`, with
fixed unavailable, disabled and zero-count metadata. It opens no reader and
exposes no identities or grants. The existing panel displays this state in English
and Arabic while expanded, using its existing poll worker. Old brokers, denied
requests, malformed metadata, disconnects and stale expansion generations all
show unavailable. Display-free tests exercise actual panel methods; this is not
a visual or native desktop acceptance test.

The internal [usage coordinator](../../src/read-usage-coordinator.ts) makes an
`off` fence synchronous before waiting for its injected store, limits queued
work and returns unconfirmed on deadlines without claiming an unresolved write
stopped. Store errors and uncertain outcomes remain sticky disabled. A real
Sessions fixture uses the coordinator fence to deny an accepted read before the
store acknowledgement; its notification callback is a no-op, so it does not
prove immediate registry notification or reader/provider drain.

The store is an injected durability contract, not an implementation of durable
disk storage. Legacy CLI, MCP and session adapters still use independent
unversioned preference files and can bypass it. The current DSH MCP plugin can
share a registration and provides neither verified conversation identity nor an
inherited protected descriptor. Never treat PID headers, a fixture epoch, a file
watcher or a promise as equivalent to protected identity, off authority or drain.
Each coordinator instance requires a fresh Sessions registry and exclusive
qualified storage writer; numeric epochs alone can collide across restarts.
Existing production read views remain unavailable until these and transport,
provider-stop and original-app acceptance gates are actually established.

Source verification after these changes: 865 pass, 5 skip, 0 fail, 16547
assertions across 80 files in 70.74 seconds; strict TypeScript validation passed.

## 14. Synchronous fixture revocation and owned peer qualification

A trusted optional usage-revocation subscription now connects the coordinator
to the existing protected Sessions registry. For the exact conversation, `off`
fences and invalidates grants synchronously before the store acknowledgement;
other conversations are unaffected. Reentrant binding is refused. Shutdown
disables the registry before invoking unsubscribe, and protected dispatch cannot
reactivate it. The integration fixture covers retained leases, in-flight capture
and unknown drain, which remains charged. Without the optional subscription,
only the existing synchronous `usageCurrent` fence applies. This does not connect
legacy CLI/MCP off or qualify any production enrollment.

The dormant [Linux peer qualifier](../../src/native/read_peer.py) accepts only an
owned, private, nonblocking Unix listener and obtains kernel `SO_PEERCRED` plus
`SO_PEERPIDFD`; no process claim from a request body is accepted. It pins and
checks the peer PID/birth, socket and listener around a one-shot trusted staging
callback. The owned child/socket fixture covers 25 Python cases without skips
on this kernel, including resource cleanup, peer death, callback errors and
concurrent close. This establishes the connection creator for that fixture, not
the current sender after descriptor transfer, a DSH conversation, or protection
from hostile processes of the same UID. Listener path checks are sampled and
cannot rule out a temporary rename-and-restore race. Unsupported kernel/namespace
configurations refuse. The helper is not wired into production IPC.

The current Grim capture result still reports provider completion `UNKNOWN`.
Frame `ready` or `failed` can describe one protocol request, but process exit or
valid PNG alone does not prove provider or GPU drain. At that point the private
durable usage store remained unimplemented. No phase gate was passed by those
fixture results.

Final source suite: 869 pass, 5 skip, 0 fail, 16566 assertions across 81 files
in 71.33 seconds. Strict TypeScript validation also passed.

## 15. Owned handshake, storage and receipt fixtures

The [private Unix handshake](../../src/native/read_channel_server.py) now uses
the kernel-pinned accepted peer and exchanges one bounded request with a fixed,
non-authoritative acknowledgement. Real owned child fixtures cover malformed and
duplicate requests, slow clients, revoke/reapprove generations, partial writes and
cleanup. Staging does not hold the owner authorization lock. Final peer checks do
hold it and can block in OS calls; no hard off-latency or atomic delivery claim is
made. This is not production ingress, a conversation grant or a defense against
a hostile same-UID process.

The dormant [Linux usage store](../../src/native/read_usage_store.py) uses pinned
directory descriptors, an exclusive lock, a separately fsynced pending marker,
atomic descriptor-relative rename and directory fsync. Its owned temporary-file
fixtures cover failures and reconciliation, and all recovered records report
`enabled: false` and unknown acknowledgement. These tests do not prove power-loss
durability, prevent legacy writers from bypassing its lock, or wire it into the
TypeScript coordinator. A new qualified owner/cohort and independent storage
serialization remain required before use.

The [receipt reader](../../src/native/reader_receipt.py) validates one bounded
operation-bound binary record and writer EOF using an owned pipe fixture. It
requires separately qualified helper identity and exclusive writer/FD provenance.
No existing Grim output can manufacture such evidence, and a syntactically valid
record alone proves neither compositor teardown nor GPU drain. The actual capture
helper and production wiring are not implemented.

Final source suite: 872 pass, 5 skip, 0 fail, 16578 assertions across 84 files
in 71.95 seconds. Strict TypeScript validation passed.

## 16. Native helper and real client progress

The dormant [fixed Wayland helper](../../src/native/reader_helper.c) uses the
foreign-toplevel image-copy protocol with one bounded SHM frame. Its owner supplies
a 120-byte setup on fd 3 and a separate receipt pipe on fd 4. It samples target
closure before issuing capture-related destructor requests and a same-connection
sync, then emits the bounded receipt. The nonce and digest are trusted setup echoes,
not independent target authentication. Total process/libpng/Wayland allocations,
actual compositor drain, continuous target liveness and GPU quiescence are not
proved. The 13 owned tests compiled the helper with local Wayland 1.26.0, protocols
1.49 and libpng 1.6.59 and exercised preflight and callbacks without a compositor.
A synthetic protocol server, installed build, owned-scope launch and real app
acceptance remain required. The focused helper test is not in the default suite
because it requires newer compiler and Wayland protocol development packages.

The [fixed handshake client](../../src/native/read_channel_client.py) and existing
server exchanged metadata through a real private socket with owned processes.
Kernel peer credentials and pidfd, protected generation checks, path validation,
cancellation and malformed replies were covered by 27 Python cases. An ACK is not
a future authorization, read grant, DSH conversation binding or data-drain proof.
Off-latency and hostile same-UID/descriptor-transfer isolation are not claimed.
The attempted TypeScript-to-Python durable usage bridge was not shipped because
root-domain quarantine, child lifetime and lost-ack handling remain unqualified.

Final default suite: 873 pass, 5 skip, 0 fail, 16582 assertions across 85
files in 75.44 seconds. The separately compiled helper fixture passed all 13
Python cases; it is not an original-app or compositor acceptance.

## 17. Synthetic compositor and reader deadline fence

The fixed helper was compiled and exercised against a private synthetic Wayland
server using real SHM and generated protocol code. Ten owned scenarios covered
READY pixels and receipt, FAILED, invalid constraints, early/late duplicate and
malformed identifiers, incomplete first-frame damage, disconnected server, missing
terminal event and withheld post-destroy sync. The server observed capture-related
destroy requests and a subsequent sync request; when the response was withheld,
the helper emitted no image or receipt. The ready fixture checked a 1x1 RGB PNG
and the exact operation-bound receipt. This is synthetic protocol evidence, not
acceptance of a real compositor, GPU quiescence or proof of continuous target
liveness after proxy destruction. The focused test requires installed Wayland
protocol development tools and is not part of the default portable suite.

The [reader orchestration](../../src/native/reader_process.py) now checks the
absolute deadline and cancellation again after its trusted guard returns. Four
fixtures cover guards that become stale before scope work and after scope retirement.
The attempted fixed-helper launch was not shipped: the existing mutable bootstrap
path is not qualified as a protected executable, and failure to acquire a pidfd
before admission can leave a stopped owned child with unknown cleanup. The helper
remains disconnected from production; no phase gate or original-app acceptance
is claimed. The TypeScript-to-Python durable store bridge was likewise deferred.

Final default suite: 873 pass, 5 skip, 0 fail, 16582 assertions across 85 files
in 75.08 seconds. The ten synthetic compositor cases and thirteen helper cases
were run separately and passed on the local toolchain.

## 18. Protected storage root pin

The dormant [usage store](../../src/native/read_usage_store.py) accepts an
owner-supplied, preopened root descriptor. It duplicates the descriptor with
close-on-exec and compares its identity with the protected directory chain before
creating the lock or writing state. The caller retains its original descriptor;
subsequent caller close or reuse cannot rebind the store-owned pin. Every later
operation rechecks the pin, directory chain and lock, and integrity failure poisons
the store. Thirty-six owned filesystem cases passed locally, including mismatch,
reuse, busy lock, cleanup and a rename immediately after the pre-mutation check.

The path and descriptor are trusted and must remain stable during duplication.
Checks are sampled, not a defense against hostile same-UID rename/restore or
mount manipulation. If a rename races after the last pre-lock check, a lock may
be created in the originally pinned directory before the operation refuses; the
replacement is not written. This is not yet connected to the coordinator or old
CLI/MCP writers, and no durable off acknowledgement or release gate is claimed.

The preceding implementation still relied on `Popen.wait`, which can synthesize
success after `ECHILD`. The following change narrows that root-wait claim.

## 19. Strict owned root wait and helper identity

The dormant [reader scope](../../src/native/reader_scope.py) now obtains the
root exit result using `waitid(P_PIDFD)` with an observed zombie birth and parent
check, followed by consumption on the same pinned pidfd. `ECHILD`, reaping races,
cancellation and uncertain cleanup do not become a successful `Popen.wait` result.
Only the exact scope-local, one-shot receipt can authorize root-reap accounting.
If pipe acquisition loses the receipt, the durable debt remains unknown rather than
retrieving a hidden cached token. Python private fields are a trusted in-process
convention, not an isolation boundary. Real owned child tests cover external reaping,
ignored SIGCHLD, interruption and receipt loss. Scope emptiness and provider
completion remain independent facts.

This does not solve child-creation and numeric cgroup migration races or prove the
initial pidfd was acquired atomically with creation. The former capture orchestrator,
its direct legacy bootstrap and its manual live probe now refuse before spawning
or signaling; their unsafe execution bodies were removed. This intentionally reduces
an internal, already unqualified capability until atomic creation/placement and an authenticated
bootstrap are available. No current owned-cgroup run or real desktop acceptance is
claimed for this revision.

The separate [helper identity pin](../../src/native/reader_helper_identity.py)
checks a fixed root-owned installed path against a digest the caller must obtain
from a trusted manifest, plus bounded ELF bytes, directory/file metadata, ACL and
capability absence. The module does not authenticate the manifest. Thirty-two owned
fixture cases passed; no fixed helper is installed or launched by this change.
It does not authenticate a dynamic loader, protect against root or hostile in-process
code, or grant a read capability.

Final source suite: 876 pass, 5 skip, 0 fail, 16594 assertions across 86 files
in 77.93 seconds. Strict TypeScript validation passed. The reduction in mocked
bootstrap and capture cases reflects removal of their unsafe execution paths, not
a passed native-capture gate.

## 20. Recovered root debt remains unresolved

A recovered leaf can be empty even if an unqualified child spawned a descendant
outside that leaf before admission. Disappearance of the recorded root does not
prove either descendant containment or the former parent's kernel wait. Legacy v1
can also leave a child unrecorded before admission. Every recovered generation now
refuses retirement and checkpoint, retaining debt even when leaf emptiness is true
or no process was recorded.

On reopen the journal checks every historical record, not only the newest one.
A legacy retired recovery now refuses as debt even if no process was recorded or a
later generation appears healthy. This does not reconstruct history already erased
by an older checkpoint. Even same-owner v1 no-process retirement cannot prove that no
child was spawned. Capture and the manual live probe remain disabled; this change does not prove
atomic creation, descendant containment, provider completion or native acceptance.
The final default verifier passed 876 tests, with 5 skipped and 0 failed, across
86 files in 84.82 seconds. The scope wrapper required all 99 Python cases.

## 21. Numeric admission disabled

[ReaderScope](../../src/native/reader_scope.py) now rejects numeric PID admission
before inspecting input or touching the cgroup. A pinned pidfd opened after spawn
does not prove that a reused PID denotes the original child, and post-write checks
cannot undo a wrong migration. The old migration implementation was removed, with
no test-only production bypass. Historical journal scenarios in the scope fixtures
are synthesized in an owned fake filesystem, not evidence of actual admission.
An atomically placed, birth-bound child and qualified immutable supervisor are still
required before capture can be implemented.

## 22. Shared-store cohort failure fence

The fixture-only [usage coordinator](../../src/read-usage-coordinator.ts) exposes
an owner-authorized synchronous cohort poison. It disables every registered
conversation before notifying any revocation callback, permanently rejects new
authority on that instance, and prevents late store acknowledgements from enabling
or acknowledging pending work. The final on acknowledgement rechecks its epoch
after timer cleanup. A broker fixture exercises two conversations, retained leases
and an in-flight read using actual Sessions with fake store, channels and backend.

The future shared-channel owner must call this fence before processing further
acknowledgements when channel health is lost. Detection and delivery over a real
channel are not wired here. Revocation callbacks are trusted synchronous functions
that return undefined; a nonstandard rejected Promise may defeat best-effort
observation. Poisoning proves neither writer termination nor provider drain and does
not release uncertain resource credit.

Final verification for sections 21 and 22: strict TypeScript checking passed; the
default suite passed 888 tests, with 5 skipped and 0 failed, across 86 files in
77.93 seconds. These are source and owned-fixture results, not desktop acceptance.

## 23. Owned usage store channel components

The dormant [Python service](../../src/native/read_usage_store_service.py) accepts a
pre-owned Unix socket and an already-open owner root descriptor. A bounded canonical
request commits to the real descriptor-backed store before sending its matching ACK.
Owned socketpair tests cover persistent on/off, malformed frames, lost ACK and a
close-versus-commit race. A local close is not cancellation or proof that a writer
stopped; a synchronous filesystem call may complete after a deadline.

The separate [TypeScript transport](../../src/read-usage-store-transport.ts) serializes
a bounded global queue and, on channel failure, calls a trusted synchronous owner
fence before rejecting pending work. It retains unresolved in-flight identity and
does not reconnect or release storage ownership. Its tests use the real coordinator
and an in-memory byte channel. The two language implementations have matching wire
formats by source review, but have not been run together. The owner must establish
and verify the protected socket, exact slot-to-identity mapping, failure callback,
serial service loop, worker lifetime and exclusive root domain. No production route,
peer identity, CLI/MCP off, process termination or native acceptance is claimed.

The first full run of this slice failed one existing peer-channel fixture without
its Python traceback being surfaced. The standalone fixture subsequently passed;
its wrapper now includes diagnostics on failure. After the service cleanup fixes,
the full verifier passed 910 tests, with 5 skipped and 0 failed, across 88 files in
103.19 seconds. The earlier failure is not attributed to a proven cause.

## 24. Owned Unix socket adapter

The fixture-only [Unix socket adapter](../../src/read-usage-unix-channel.ts) accepts
an already established, exclusive owner-supplied socket, copies bounded data and
fences transport failures before reporting them. Two tests use actual private Unix
sockets with the real TypeScript transport and coordinator; the peer implements
the protocol as a fixture, not the Python service. Other tests cover backpressure,
startup failures and uncertain fixture cleanup. Strict TypeScript checking passed;
the full verifier passed 922 tests, with 5 skipped and 0 failed, across 89 files in
80.89 seconds.

Socket adoption and identity, slot correspondence, root-domain crash quarantine,
worker lifetime and cross-language execution are still unqualified. In particular,
a service may finish a durable write and lose its ACK before closing its store lock;
a new owner must not infer safety merely from reacquiring that lock. A persistent
barrier bound to the actual store root and independently authorized owner is still
required. No production route or native application acceptance is claimed.

## 25. Persistent service session marker

The dormant [usage service](../../src/native/read_usage_store_service.py) now seals
a same-root session marker while holding the actual store flock, before returning
from construction or accepting a request. It verifies the pinned marker and root
during service checks. Closing or failing the service does not remove the marker;
a subsequent ordinary store or service refuses that root. This is a conservative
single-session restriction, not a reconciliation mechanism.

The owner must independently provision a truly fresh, exclusive root and preserve
its authoritative mapping. A crash before the marker is durable, an alternate root,
legacy writers, and hostile same-user filesystem changes remain outside this proof.
An ACK can reach the peer before a later server-side check reports failure, so the
marker does not establish an atomic client acknowledgement or writer-stop proof.
The TypeScript and Python components have still not been run together. Focused tests
passed all 42 store and 25 service Python cases; the full verifier passed 922 tests,
with 5 skipped and 0 failed, across 89 files in 85.76 seconds.

## 26. Shared protocol vectors and marker fault checks

The real Python request parser and ACK encoder and the real TypeScript transport
were each checked against the same [literal wire vectors](../../tests/fixtures/read-usage-wire-vectors.json).
The checks include canonical bytes, malformed frames and safe-integer bounds. The
maximum TypeScript request ID uses a test-only compiled copy with a seeded counter;
it is not a live production counter test. These vectors do not establish interprocess
execution, descriptor ownership or durable ACK delivery.

Additional owned-filesystem tests inject interrupted and partial marker writes,
fsync failures and post-commit marker, lock and root replacement. Each targeted
failpoint is asserted to have fired, and failures preserve uncertainty rather than
claiming a durable barrier. The full verifier passed 945 tests, with 5 skipped and
0 failed, across 91 files in 81.99 seconds; strict TypeScript checking also passed.

## 27. Identity, deadline and legacy scope safeguards

The legacy CLI and MCP usage preference and broker caller now share an exact
conversation ID validator. Leading or trailing whitespace, ASCII controls and
unpaired UTF-16 surrogates are rejected rather than normalized into another
identity. This is cooperative attribution, not authentication. Historical padded
`off` files are not migrated; an owner must reconcile the host ID explicitly as
described in the [CLI guide](../cli.md). A real owned CLI child verifies refusal
before broker access, while other tests use owned state fixtures.

The dormant [usage coordinator](../../src/read-usage-coordinator.ts) rechecks its
deadline after timer cleanup before publishing an `on` acknowledgement. Queued writes
wait for both actual store settlement and the final acknowledgement fence; failed
timer cleanup and clock uncertainty remain disabled. This assumes trusted,
nonblocking clock and timer callbacks and is not a hard real-time or cancellation
guarantee.

[ReaderScope](../../src/native/reader_scope.py) no longer retires legacy v1/v2
generations or treats historical `retired` events as reusable proof. Leaf emptiness
and root wait remain diagnostics, not proof against pre-admission descendants. An
older checkpoint may already have erased history; this change cannot reconstruct it.
No production read-view path is enabled.

The first full verifier exposed an ordering assumption in a transport test after
the coordinator change; the test now waits for the actual second write. The final
verifier passed 977 tests, with 5 skipped and 0 failed, across 92 files in 83.87
seconds. Strict TypeScript checking and the focused real CLI fixture also passed.

## 28. Owner status and watcher usage checks

The actual [CLI](../../src/cli.ts) now exposes the existing owner-only
`views.owner-status` metadata as `--owner views status`, with exact arguments and
the normal conversation usage check. The route does not issue a read grant, start
a worker, or enable multi-view. An actual Linux launcher was exercised against a
private fake peer, while the real broker authorization is separately covered by
the existing private IPC tests. No original application or Windows machine was
used for that evidence.

The direct [status watcher](../../src/status.ts) now checks legacy usage before
new list, presence and pending-version reads and before publishing output. It
stops after observing `off` or invalid state; checks are point-in-time and cannot
cancel already admitted broker work or serialize concurrent legacy writers. A
real watcher child and private fake peer exercise those boundaries. On an
unconfirmed fixture timeout, the child and fixture may remain rather than being
signalled by an unproven PID or having resources deleted underneath them.

The first full verifier identified an unregistered `OWNER_REQUIRED` diagnostic
code; it was added to the diagnostic allowlist. The final verifier passed 991
tests, with 5 skipped and 0 failed, across 94 files in 81.81 seconds. Strict
TypeScript checking and focused IPC, owner CLI and watcher tests also passed.

## 29. CLI off checks and known concurrent writer defect

The one-shot [CLI status](../../src/cli.ts) now uses the same point-in-time
usage checks as the watcher before each status subrequest and before output.
Other ordinary CLI RPC commands recheck after reading their input and before
dispatch. These checks do not cancel accepted work or establish an atomic
cross-process revocation barrier. Owned Linux CLI and fake-peer fixtures exercise
off during list, presence and an open stdin document. An unconfirmed fixture
child is retained rather than being signalled by an unproven PID.

The [known-race fixture](../../tests/conversation-usage-concurrency.test.ts)
reproduces a defect using an isolated transpiled copy of the production class
and real owned files: a delayed `on` overwrites an acknowledged later `off`.
A pass here documents the defect, not a safety guarantee or a cross-process
test. Legacy writers are not serialized, and mixed-version coordination remains
unqualified. The MCP retry and late-delivery work was deferred after fixture
cleanup review; no MCP enforcement is claimed by this section.

The final verifier passed 997 tests, with 5 skipped and 0 failed, across 96 files
in 84.88 seconds. Strict TypeScript checking and focused CLI fixtures passed.

## 30. Single-attempt adapter dispatch and status error guard

Both MCP adapters now resample the legacy usage preference immediately before
their broker dispatch. `callPatient` no longer automatically retries any request:
Bun fetch error codes do not establish whether an effectful request was delivered.
A caller must inspect uncertainty and decide whether an explicit retry is safe.
This is a deliberate availability reduction, not proof about Bun internal behavior,
global at-most-once execution, atomic off/dispatch or cancellation of accepted work.
A real `callPatient` and owned fake Unix peer exercise the guard, accepted reset
and error cases; adapter wiring is checked statically, not with a live host.

The one-shot CLI status path also rechecks usage when a broker read fails, before
printing that error. This suppresses broker metadata when off is observed, while
preserving the original error if usage remains on. It does not cover arbitrary
MCP late-result delivery, change mutation receipts, or resolve concurrent legacy
writers. Focused tests passed 33 cases across four files, and strict TypeScript
checking passed. The readiness fixture also now cancels its delayed test listener
before deleting its owned root.

The first full verifier found that `BROKER_UNAVAILABLE` was no longer thrown
literally after removing retry. It remains a real MCP and watcher fallback, so
the diagnostic contract test now records that actual dynamic producer. The final
full verifier passed 1011 tests, with 5 skipped and 0 failed, across 98 files in
81.22 seconds. The old separate MCP restart integration test still expects
automatic waiting and is outside the default verifier; its isolated replacement
remains pending. No live MCP-host or desktop acceptance is implied.

## 31. MCP read delivery sampling and restart fixture

Both actual MCP adapters now recheck the legacy usage preference before delivering
successes or broker errors for eight explicitly listed read methods. When `off`
or invalid preference state is observed, the read outcome is suppressed. This
is sampling, not an atomic off/on generation fence or cancellation. Already
accepted `session.act` results and errors remain visible, including embedded
capture, so this is not a universal suppression guarantee.

The old restart test was replaced with an actual in-process MCP SDK client and
server plus an owned fake Unix peer. The call while unavailable returns an error;
only a new explicit call reaches the restarted peer. Both adapters and all eight
read mappings are exercised against controlled fake responses. The fixture tracks
the inspected SDK tool handler and quarantines uncertain cleanup; it does not
prove general SDK drain, authenticated peers, live host behavior or desktop
acceptance. The final verifier passed 1019 tests, with 5 skipped and 0 failed,
across 100 files in 87.29 seconds. Strict TypeScript checking also passed.

## 32. Conservative socket and workspace prechecks

The managed socket precheck now refuses any observed or uninspectable existing
entry instead of probing and unlinking it. A stale socket can therefore require
owner-coordinated manual recovery. This is not an atomic namespace lock: the
absence-to-bind interval, Bun bind behavior, credential replacement and successor
cleanup remain unqualified. No shared broker was restarted.

Workspace cleanup now preserves a workspace when its recorded PID is live or
cannot be checked, even when its socket is unresponsive. Invalid present PIDs
are not signalled or coerced. An ESRCH followed by an answering socket, or a
failed socket probe, also preserves it. PID reuse can retain old workspaces;
ESRCH and the legacy missing-record/age policy do not prove that descendants
have stopped. This is not a universal cleanup or process identity guarantee.

Owned socket and filesystem fixtures passed 23 focused tests. The final verifier
passed 1027 tests, with 5 skipped and 0 failed, across 101 files in 82.56 seconds;
strict TypeScript checking also passed. No original application or Windows
machine was used for these fixtures.

## 33. Bounded CLI standard input

The actual CLI now reads action JSON from stdin with a 1 MiB raw-byte limit,
checking each chunk before copying into a fixed accumulator. Oversize and read
failures have fixed, content-free errors. EOF is still required at the exact
limit; native stream buffering, stalled input and producer termination are not
qualified. Existing `@FILE` handling was not changed, and its pre-read size check
does not establish safe behavior against path replacement or file growth.

Owned Linux CLI fixtures cover the exact byte boundary, fragmented UTF-8, an
oversize pipe without producer EOF, and error redaction. A prior fixture revision
failed on an unawaited Bun stdin write; its child and pipe state became unknown
and were not signalled by numeric PID. The feeder was corrected and the final
verifier passed 1037 tests, with 5 skipped and 0 failed, across 102 files in
81.70 seconds. Strict TypeScript checking also passed.

## 34. CLI read delivery, POSIX file bounds and policy errors

Ordinary CLI read results and broker errors are resampled against the legacy
usage preference before delivery. A file observation is checked before its
write, and diagnostics fallback is not started after observed `off`. This is not
an atomic off/on fence or cancellation: an already accepted observation may have
effects, and mutation receipts, errors and embedded capture remain visible.
Local `doctor --report` and other separately routed maintenance/status paths are
not qualified by this change.

On POSIX, action `@FILE` input uses one nonblocking-open descriptor, checks its
type, and reads at most 1 MiB plus one detection byte. The initial pathname check
is advisory: device-open effects during replacement and filesystem stalls remain
unqualified. Windows keeps its earlier path-based implementation. Policy
validation errors no longer echo invalid origin, action class or rule IDs into
diagnostics. Valid rule IDs and reasons remain intentional journal content; this
is not a general hostile JavaScript getter/proxy boundary.

Owned CLI and fake-peer fixtures, isolated helper cases and real Diagnostics
storage passed. The final verifier passed 1060 tests, with 5 skipped and 0 failed,
across 105 files in 87.25 seconds; strict TypeScript checking also passed. These
fixtures do not establish protected host identity, legacy writer serialization,
original-application acceptance or Windows file-race safety.

## 35. Bounded ordinary IPC response

The ordinary no-signal IPC path now limits accepted response-body bytes to
32 MiB, using at most 512 owned 64 KiB slabs before UTF-8 decoding. Invalid
JSON, invalid response envelopes and body-read failures return fixed errors; a
valid broker refusal still carries its public metadata. The limit is not a total
RSS, native buffering, hard deadline or producer-stop guarantee. The separate
signal path is unchanged and its BOM/envelope differences remain unqualified.

Owned Unix fake-peer and isolated reader fixtures cover the byte boundary,
fragmented UTF-8, tiny chunks and sanitized failures. The attempted in-process
legacy preference queue was withdrawn because saturation could reject `off` while
earlier `on` writes remained pending; the cross-process writer race is unresolved.
The final verifier passed 1067 tests, with 5 skipped and 0 failed, across 106
files in 83.88 seconds. Strict TypeScript checking also passed.

## 36. Signaled IPC response handling

The signal-bearing `node:http` path now also bounds response bytes and retained
slab count, rejects overflow before destroying the local request, and ignores late
terminal events after settlement. It checks the basic response envelope and
malformed error fields, and decodes UTF-8 with BOM handling. Local abort and
request destruction do not prove broker work stopped. The tests cover pre-abort,
not actual in-flight abort or timeout; total RSS and a hard deadline are not
qualified. The ordinary path is unchanged.

Owned Unix fixtures and isolated event-order simulations passed. Earlier fixture
revisions timed out while socket termination was unknown and retained their owned
roots; no numeric PID was signalled. The fixture now drains its own work and waits
for actual owned socket close events before removing its root. The final verifier
passed 1075 tests, with 5 skipped and 0 failed, across 107 files in 83.95 seconds;
strict TypeScript checking also passed. Multi-view and original-app acceptance
remain unavailable.

## 37. Internal protected usage cohort composition

A new internal factory binds the actual usage coordinator, framed transport and
Unix channel around an already owner-adopted socket and a fixed dense mapping of
up to four opaque conversations. All registrations precede subscription; channel
failure synchronously fences the cohort before transport failure settles pending
work. A revocation callback failure disables the cohort, but does not prove that
external grants were revoked or that a producer stopped. The factory does not
connect, authenticate a peer, start a worker, adopt descriptors, qualify storage,
or expose a production route. The caller retains an uncertain socket on setup
failure. A coordinator-local deadline is not automatically a shared-channel
poison.

Owned Unix sockets with a fake framed ACK peer exercise on/off, late peer EOF
and callback failure. Separate in-process fixtures exercise setup failures and
input snapshots; the ACK is not durable storage evidence. Three initial test
cases failed at socket admission until the fixture used the previously qualified
paused `createConnection` setup; no failure was presented as success. Final
strict typing passed and the verifier passed 1082 tests, with 5 skipped and 0
failed, across 108 files in 82.68 seconds. No Python service, protected host
identity, original app or Windows desktop acceptance was exercised.

## 38. Poison ordering and real service ACK window

Every coordinator-wide poison now fences all registered entries before invoking
a trusted synchronous integration hook. The cohort uses it to latch transport
failure before external revocation callbacks can reenter with an ACK and pump a
queued write. Hook failure does not restore authority or prove an external fence;
coordinator-local uncertainty is not automatically cohort-wide poison. This is
internal composition only, not a protected production ingress or cancellation.

Actual Python socketpair/store fixtures demonstrate that a complete ACK can reach
the client before the service final guard fails. A separate serial-driver fixture
shows that a second request sent after that ACK can wait in the socket until the
first call returns. These tests do not bridge TypeScript to Python, prove power-loss
durability, or resolve the ACK/final-guard ambiguity. Strict typing passed and the
final verifier passed 1086 tests, with 5 skipped and 0 failed, across 108 files
in 91.64 seconds.
