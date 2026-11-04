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
