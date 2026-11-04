# Agent interface

## Native operation identity and text limitations

Opening, presentation and automatic workspace selection cache outcomes by the
broker-resolved caller identity plus requestId, not a device-global requestId.
Keep both unchanged to inquire about a possibly delivered operation. A different
conversation is a different operation scope even if it uses the same requestId.
Changed parameters within one scope conflict. These in-memory caches do not
survive broker restart and do not provide durable exactly-once delivery.

Agent opening and presentation over CLI, MCP or direct IPC require a verified
caller with `ORBIT_CONVERSATION_ID` set to the actual host conversation. Process-only
or unidentified callers are refused with `CONVERSATION_REQUIRED` before native
work, because a later CLI process or restarted adapter cannot retain that identity. Read-only discovery is unchanged. The human owner credential
continues to identify the same owner across CLI processes; agents must not use it.
For both `native-open` and `native-present`, an explicit JSON requestId is
preserved, otherwise `ORBIT_REQUEST_ID` or a generated ID is used. A generated new
ID is not a safe way to retry uncertain delivery. Caller attribution remains
cooperative same-user attribution, not a protected host-issued multi-view grant.

Native direct text uses the active keymap and implemented stroke levels, not all
physical keyboard/IME capabilities. Unrepresentable characters now return
`TEXT_UNSUPPORTED` without attempting the unsafe clipboard replacement/restoration
fallback or sending Ctrl+V. This intentionally removes that fallback capability;
it does not restrict typeable text or explicit application Copy/Paste. No atomic
clipboard-owner revision or coordinated clipboard transaction is claimed.

## Same-call post-action text readback

Batch `orbit_act` supports `capture.format` of `image` (default), `text` or
`both`. Omitted format and explicit `image` preserve the same existing request
fingerprint and behavior. Changing format with the same requestId conflicts
rather than replaying inputs.

```json
{"sessionId":"CURRENT_SESSION","requestId":"UNIQUE_REQUEST","actions":[{"type":"key","appId":"OWNED_APP","windowId":"OWNED_WINDOW","key":"Return"}],"capture":{"format":"text","timeoutMs":1500}}
```

Explicit text skips the image baseline and pixel settling. `quietMs` is rejected
for text before any input; `graceMs` remains unsupported in the public batch
schema. The timeout is one nonsettling observation budget, including any existing
image fallback when no usable tree is available. A text request is therefore not
a text-support or no-image guarantee. `both` retains image baseline/settling and
adds the tree. Existing image defaults do not change.

Text is returned once, in the same tool response, as an explicitly untrusted
application-data block and structured tree. Read permission is re-evaluated after
inputs. Input receipts survive a read failure; no input is replayed automatically.
A tree or image is a point-in-time readback, not an automatic application-success,
save or stability verdict. Inspect the intended postcondition.

Cached batch duplicates retain receipts/metrics but expire image and tree payloads
without another read. Broker and worker queue tails resolve void after success or
failure instead of retaining the full completed response. This is not a claim
that every native buffer is empty: the existing Python reply cache remains bounded
and can retain text-tree replies under its current metadata limit.

## Provisional internal identity comparison

The internal identity primitive compares exact helper/bus/unique-owner/process
epochs, compositor binding, node path and separate accessibility-window-root path.
It requires a typed immutable caller attestation through a mandatory verifier
callback. No toolkit/version string, proxy hash/equality, path syntax, label or
coordinate automatically enables a provider. Its numeric unique-name syntax is
a conservative subset, not full D-Bus name grammar.

This is not integrated provider discovery or a public ref/action capability.
Fresh routing/owner credentials, actual loaded exporter/source, root membership,
event invalidation, authority and registry TTL remain external mandatory gates.
GTK UUID noncollision is an explicit provider assumption, not an absolute remote
reservation. Widget identity does not establish virtualized business-row identity.

## Error delivery and retry metadata

Broker error envelopes and MCP error results retain their existing `code`, `message`
and optional `diagnosticId`, with additive `disposition` and `suggestion` fields.
MCP returns the same error payload as text and structured content. For example:

```json
{"code":"TIMEOUT","message":"Request failed","disposition":{"delivery":"unknown","retry":"unsafe"},"suggestion":"observe-before-retry"}
```

`delivery` is `not-delivered`, `delivered` or `unknown`. `retry` is `safe` or
`unsafe`. Suggestions are fixed values: `correct-request`, `observe-before-retry`
or `do-not-retry`. Missing, legacy or incoherent metadata defaults to unknown
delivery and unsafe replay. Never derive safety from an error code, HTTP status,
missing acknowledgement or timeout. Audited pure validation may prove non-delivery;
a policy refusal can prove non-delivery while still forbidding replay.

These fields describe this attempt, not earlier requests or application acceptance.
They do not trigger retries, grant permissions or prove a save. Batch receipt
errors carry per-action metadata, not permission to repeat earlier successful
actions. Reuse the existing requestId with unchanged arguments to retrieve the
in-session cached outcome; inspect actual state after uncertainty or a broker
restart. See the [execution plan](efficiency-plan.md#retry-and-idempotency).

### Broker diagnostic code catalogue

The current tested catalogue is below. Additional fixed Python-native outcomes are
listed after the capture table. Names are compatibility/diagnostic identifiers,
not authorization, application-category restrictions or retry permissions.

```text
APPLICATION_BUSY BACKEND_ERROR BACKEND_FAILED BROKER_ERROR BROKER_UNAVAILABLE
CAPTURE_DEADLINE_EXCEEDED CAPTURE_GEOMETRY_CHANGED CAPTURE_UNAVAILABLE
CONFIG_REQUIRED CONVERSATION_REQUIRED DEADLINE_EXCEEDED INVALID_REQUEST LIMIT_REACHED
NATIVE_INCOMPATIBLE NATIVE_STALE NOT_PAUSED ORBIT_DISABLED OUTPUT_UNAVAILABLE PAUSED
POLICY_CONFIRMATION_REQUIRED POLICY_DENIED PRESENTATION_NOT_READY PRESENTATION_UNCONFIRMED
PROFILE_BUSY REQUEST_CONFLICT RESOURCE_BOUNDARY_LOST RESOURCE_EXHAUSTED
RESOURCE_LIMIT_REQUIRED RESOURCE_STATUS_UNAVAILABLE SESSION_CLOSED SESSION_NOT_FOUND
SESSION_NOT_OWNED SESSION_OPEN SETTINGS_REFUSED SOCKET_UNPROTECTED TIMEOUT
UNSUPPORTED USAGE_STATE_INVALID
```

The source completeness tests compare the diagnostic registry with actual runtime
producers, including explicit Python-worker exceptions. Unknown external codes
are recorded conservatively as `BACKEND_ERROR`; they never imply safe replay.

### Native capture codes

| Code | What it establishes | Safe next step |
| --- | --- | --- |
| `CAPTURE_UNAVAILABLE` | The bounded capture could not return a usable image. Empty stderr or a nonzero child exit does not identify visibility, geometry or an application cause. | Inspect the same current target with an authorized read; do not replay preceding input. |
| `CAPTURE_DEADLINE_EXCEEDED` | The shared observation/capture deadline expired or no usable frame could finish within it. | Inspect state and remaining work; do not extend a mutation by repeating its request with a new identity. |
| `CAPTURE_GEOMETRY_CHANGED` | The exact target size or qualified crop geometry changed across a read boundary. Text-query size changes refuse immediately; image resampling remains bounded. | Obtain current geometry/observation; never claim the old screenshot is fresh. |

These capture errors default to unknown delivery and unsafe replay. Batch input
receipts are independent and remain intact. Existing same-target read resampling
is limited to 3 positively observed size/crop mismatches under one absolute deadline;
nonzero exit, unavailable data and timeout are not automatically retried. Without
an explicit settled timeout, the native observation budget is 10 seconds. Child
kill/reap cleanup has a separate reserve of at most 3 seconds. Cold/warm tree
queries consume the remaining observation budget rather than restarting it.
Cooperative checks cannot forcibly preempt every native or filesystem syscall.

Production observation returns a deadline error rather than accepting an older
last settle frame after the shared budget expires. This tightens the earlier
implementation that could return an unsettled frame after its settle timer.
Successful frames retain their actual `capturedAt` and explicit settle metadata;
`changed:false` is not proof that input had an application effect. A failed capture
is never replaced by an older image labeled final or fresh. Mixed capture/cleanup
failures retain aggregate uncertainty rather than pretending a clean typed completion.

Other fixed native-worker outcomes include `TARGET_CLOSED`, `TEXT_UNSUPPORTED`,
`OPENING_UNCERTAIN`, `PRESENTATION_NOT_READY`, `OWNER_BUSY`, `APPLICATION_BUSY`,
`NATIVE_INCOMPATIBLE`, `NATIVE_STALE`, `SESSION_CLOSED`, `APPROVAL_REQUIRED` and
`NATIVE_FAILED`. A code alone never authorizes replay or proves non-delivery.

### Opening outcome qualification

Opening responses add `openingOutcome` without changing original identity, focus,
placement or launch success rules. `process.launchProcessPid` names the recorded
registration-launch-scope helper, not proof of the application executable PID.
`windowPid` is separate. `relation` is `same`, `descendant` or `unknown`, and only
an ancestry-proven attribution branch can report the first two. Activation token,
launch scope and registered D-Bus evidence do not imply forwarding; `forwarded`
remains `unknown` without stronger evidence.

`geometry` reports requested size, the fitted placement request, sampled actual
size, comparison/difference with a 2-pixel tolerance and `sampledAtMs`. The clock
is local wall time at receipt of an existing compositor response, not a native
compositor event timestamp. `stability`, minimum-size enforcement, difference
cause and future geometry are unproven; an early matched size may change later.
Malformed or missing samples remain unknown. A candidate with matching dimensions
is still only a candidate, not a verified opening or permission to move it.

## Current authority at queued dispatch

Admission still refuses denied/confirmation-required actions synchronously. Accepted
queued work re-evaluates the current policy immediately before broker dispatch,
and a pending advisor answer is refused if its policy changed while awaiting it.
No stale approval restores narrowed authority or triggers another consultation.
Batch steps and final capture use current authority after their asynchronous waits.
Only actual dispatch emits an allow journal record; request deduplication is unchanged.
Already accepted single actions still drain during pause, while remaining batch
steps stop. These are broker-dispatch checks, not cancellation or atomic revocation
of input/read requests already sent to the native worker or application.

## Visibility qualification

The legacy session/backend `visible:true` field marks the native desktop backend,
not a fresh sample that the selected workspace is displayed or the window is
unoccluded. In particular, a paused native session can still return that marker
after the owner changes the displayed workspace. Use `orbit_monitors` and the
exact current target workspace for qualified monitor metadata; even this is not
pixel visibility or a continuous owner-state guarantee. Never force an owner
workspace/focus/pointer change to make an acceptance test appear successful.

## Observation measurements

Native observation adds content-free `observation` metadata: `requestedFormat`,
`returnedFormat`, `workerMs`, `imageBytes`, `treeBytes`, `treeNodes`, `treeComplete`.
`workerMs` is local worker elapsed time including its control journal, not model
or end-to-end workflow latency. Image bytes exclude base64 overhead; tree bytes
count the compact UTF-8 node array. Tree payload also exposes `readMs` for helper
startup/read cost and its existing `queryMs` for the in-helper query elapsed time.

`treeComplete` is null without a usable tree, false for partial filtered traversal
and true only when that traversal reports no truncation. Depth, child, node, byte,
deadline and unreadable-node limits are explicit. Completeness does not establish
retained element identity or that image and text were captured atomically.
Only a unique full native window title match is accepted; substring, suffix,
ambiguous and missing matches fall back to capture rather than guessing.
Window PID/title changes during a tree query discard that tree. Password-role
values, names and descendants are omitted from text, but mislabeled fields and
screenshots are not guaranteed redacted. Never put raw observations in public
benchmarks. See [measurement and acceptance gates](efficiency-plan.md).

### Scoped window acknowledgement

Current native workers attach fresh scoped window metadata inside the admitted
observation after capture, avoiding a separate worker windows request. The backend
validates target identity, dimensions, pointer/scales and the complete window list
before updating acknowledged presence. Missing inline metadata uses the legacy
second scoped read; malformed-present data never triggers that fallback. Both
paths require the captured selected target to remain acknowledged. Internal windows
are stripped from the public frame because presence already carries that metadata.
This is one worker RPC instead of two on the modern path, not an end-to-end speed
result, atomic image/title snapshot or provider identity proof.

### Experimental warm read-only helper

The broker may explicitly opt in with `ORBIT_A11Y_WARM_HOST=1`; other values are
not forwarded. The default remains one cold process per text query. No shared
broker restart or installed activation is performed by this source change.
Successful tree responses expose `readMode: "warm-helper"` or `"cold-process"`
with the existing read-cost metadata. The warm helper accepts observe only, not
refs or semantic input. A transport failure yields unavailable-tree/image fallback,
not an automatic second query. Idle expiry can therefore cause one unavailable
observation before a later explicit request creates a fresh helper generation.

Private inherited framing is bounded; each call has a 5-second maximum absolute
deadline plus up to 0.4 seconds for cleanup. Pause and close release the helper;
failed helper cleanup must not prevent attempting native pause or lease handback,
and its tracked handle is retained for retry. Source fixtures verify actual helper
parent-death termination/reaping without initializing application accessibility.
Native cache freshness and end-to-end efficiency remain unmeasured. See the
[host safety design](accessibility-host-design.md) before opt-in or future ref work.

For ordinary web tasks, prefer the AI host's built-in browser or its normal web
tools. Orbit provides native desktop application control, not a browser-specific
session backend. Use Orbit for original installed desktop application tasks. Use
the owner's normal browser or personal profile through Orbit only when the owner
explicitly requests that browser or profile. Original browser and terminal
registrations remain supported; this routing preference is not a category ban.
Never copy profiles or create a hidden substitute desktop.

Use [the native contract](desktop-only.md) and [connectors](connectors.md).
`orbit_applications` discovers registrations. `orbit_open` opens the exact native
application on an explicitly selected numbered workspace. Opening uses normal
owner state and leaves the application open. Original browser and terminal
registrations are accepted. Private desktops, copied profiles and browser viewers
are absent. Arbitrary-command launch is outside the registered opening API.

`orbit_monitors` reads connected output names, displayed workspaces and focus,
without owner window titles or capture. It needs configured owner transport,
but no loaded input plugin. Opening does not automatically present a workspace.
After the workspace exists, select an unfocused output from that result and call
`orbit_present`, for example:

```json
{"requestId":"show-calculator-workspace-2","workspace":2,"monitor":"HDMI-A-5"}
```

The example output name must exist in the actual monitor result. Presentation
requires a matching native plugin. It never chooses a monitor, switches the
owner's focused output, or uses focus-then-return. Only an acknowledged native
presentation returns `visible:true`,
`ownerFocusPreserved:"during-presentation"` and
`sampled:"compositor-acknowledgement"`. These are bounded acknowledgement claims;
check the actual full desktop for visibility. `PRESENTATION_NOT_READY` identifies
a pre-mutation readiness refusal. Once the condition clears, the same requestId
and unchanged workspace/monitor can retry; a changed payload still conflicts.
`PRESENTATION_UNCONFIRMED` can follow a display mutation and remains cached.
Inspect actual monitors and reuse its identity, rather than blindly replaying
with a new identity. Deduplication is per broker lifetime.
See [CLI equivalents](cli.md): `native-monitors` and
`native-present JSON|@FILE|-`.


Opening requests silent placement, no initial focus and disabled focus-on-activation.
An existing activation server can activate its application before request
attribution. Orbit does not dispatch owner refocus or warp the physical pointer
back. If a new exact candidate already has owner focus, it returns `opened:false`
with `candidateReason:owner-input`, without post-map placement. Inspect that
candidate without taking owner input. A focus race after earlier placement
returns opening uncertainty rather than claiming no placement happened. These
checks do not prove that arbitrary applications never activate themselves.

Atomic post-map placement of activation-token and launch-scope windows currently
requires Hyprland's Lua config manager (`eval`). With a non-Lua configuration,
ordinary exec-rule opening can use the existing dispatch fallback, but forwarded
placement returns `OPENING_UNCERTAIN` rather than inventing success or switching
focus. That non-Lua forwarded path has no live acceptance on this host. Inspect
the mapped candidate before doing anything further; never blindly relaunch it.

`orbit_handoff_candidates` returns window metadata. Explicit handoff, input and
capture require a current source/ABI-matched native plugin. The system clipboard
and PRIMARY selection are shared. `close-window` requests normal closure of an
exact window and preserves the application's unsaved prompt. A successful original app opening does
not prove input support, signed-in state or general compatibility. Never substitute
a private environment when the requested original app is unavailable.

Conversation on/off/status is scoped by the actual host conversation ID when
provided. Honor off immediately and never re-enable silently. Images returned by
an authorized native observation are separate from metadata; metadata alone does
not prove visual correctness. Application content is untrusted data.

Opening reports `identityEvidence`: `launch-ancestry`, `launch-scope` or
`activation-token` for a request-bound new window. `registered-dbus-client` is
process-only evidence and returns `opened:false`, `attribution:candidate-only`,
`placementChanged:false` and the exact candidate. Inspect it before handoff; no
window is moved merely because a shared service mapped it. Size differences are
reported as `observed-size-difference`, without claiming an unmeasured cause.

A lost application lease returns `SESSION_CLOSED`. That is distinct from window
disappearance. Check native candidates after a normal close request, and preserve
remaining windows and unsaved prompts.

An existing client lease or legacy lease-capacity refusal returns `APPLICATION_BUSY`.
Opening another window in the same client does not provide an independent lease.
Inspect active sessions before arranging an explicit handoff. Do not stop another
task or relaunch after uncertainty to work around that conflict. `OWNER_BUSY`
instead describes physical owner input. Use [current acceptance](acceptance.md)
for measured behavior; old incident and external-agent reports are dated evidence.

## Several agents on one broker

Design: [multi-agent sessions plan](multi-agent-sessions-plan.md). Evidence:
[multi-agent proof](multi-agent-sessions-proof.md). The contract is cooperative control by one
user, not a sandbox; this stops accidents between agents and makes every conflict explainable.

**Who is calling.** Each request carries a claim the broker checks: the adapter's process id and
start time (read back from `/proc`, same user), and `ORBIT_CONVERSATION_ID` when the host sets it.
The caller id is the conversation id, or else the adapter process. The label is the host plus four
hex digits, for example `Claude (a3f9)`; `ORBIT_CALLER_LABEL` sets the host part. A request with no
valid claim is the shared unidentified agent, never the owner. This is a verified claim, not kernel
peer credentials, because Bun's Unix server does not expose them. Give the adapter and any CLI the
same `ORBIT_CONVERSATION_ID` so they are one caller; a session adapter
(`src/session-mcp.ts`) must run with its creator's conversation id.

**Whose session.** `session.create` records the owner from the connection. `orbit_act`,
`orbit_pause`, `orbit_resume`, `orbit_stop`, `orbit_observe`, `orbit_journal`, `orbit_narrow`,
close-window, close-application and the mouse actions on a session you do not own are refused with
`SESSION_NOT_OWNED`, naming the owner label, its task, state and idle time. The person (panel, or
the CLI with `--owner`) can act on any session.

**What each caller sees.** `orbit_status` returns your sessions in full and every other agent's as a
summary (`redacted: true`: label, task, application, workspace, state, idle seconds) with no id.

**Stopping your own.** `orbit_stop` with `scope: "mine"` stops every session you own and returns
exactly the list it stopped, `{ scope, owner, stopped: [...], failed: [...] }`.

**No orphans.** When an adapter process disappears its sessions pause within a poll (500 ms), and stop
after a grace period (60 s; `ORBIT_SESSION_GRACE_SECONDS`, or `orbit.session.graceSeconds` in
`settings.json` in the connector config directory). Applications stay open, and stopping hands the
plugin lease back. If the same caller returns inside the grace period its sessions stay, paused, until
it resumes them. A session stuck in `closing` for 60 s (`ORBIT_SESSION_CLOSE_DEADLINE_MS`) is forced
closed in the broker and its plugin lease is released through the `native-leases release` repair
path, which refuses leases other sessions still hold. Sessions made from the CLI have no adapter to
watch and stay until stopped.

**Busy applications.** `APPLICATION_BUSY` names the holder: label, task, state, idle time, and whether
its adapter is alive or gone. `orbit_handoff` takes `wait` (`true` is 30 s, or 1 to 40 seconds): the
caller keeps a place in a first-come queue for that application, and the answer says the position.
A caller that did not ask to wait still respects those already waiting.

**Workspaces.** `orbit_open` without `workspace` picks a free numbered workspace from the agent pool
(20 to 99, `ORBIT_WORKSPACE_POOL=A-B`): never one another agent's session or window uses, never one a
monitor shows, and the same one again for the same agent. The result carries `workspace` and
`allocated: true`. A dead agent's workspaces free up.

Not covered yet: windows an agent opened but has not handed off are tracked for workspace choice
only, so another agent may still hand off to them; a CLI without `ORBIT_CONVERSATION_ID` is a new
caller each call.
