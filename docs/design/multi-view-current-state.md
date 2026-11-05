# Multi-view current-state audit

Status: documentation only, 4 November 2026. Audited checkout: `28f2609ad493`, containing the source `0c53` cohort. No runtime implementation, desktop operation, build, benchmark or new acceptance run was performed for this audit. Proposed names below are future design, not current interfaces.

This is the preserved pre-implementation audit. Subsequent caller-cache and
clipboard repairs, tests and compatibility limits are tracked in the
[implementation ledger](multi-view-implementation.md). Source line links below
refer to the audited baseline and may shift after implementation. The subsequent
[endpoint inventory](multi-view-ingress.md) also identifies a transitive input
flush from cursor refresh; the render-only classification below is not a
qualified current zero-input-effect guarantee.

## 1. Authority and production entry path

- The production broker constructs `DesktopSessions` in [ipc.ts:18-52](<../../src/ipc.ts#L18-L52>). [desktop-session.ts:1-2](<../../src/desktop-session.ts#L1-L2>) reexports `Sessions` from [session.ts](<../../src/session.ts>). This alias matters: the session implementation is live, not merely a fixture or experiment.
- [caller.ts:87-107](<../../src/caller.ts#L87-L107>) validates a claimed process's liveness, start token and same-user ownership when available, then derives a conversation or process caller ID. It is cooperative same-user attribution, not a hostile same-UID sandbox or proof that an arbitrary conversation string was issued by a host.
- The owner role requires the separate socket-adjacent credential, not an agent label or request-body role: [ipc.ts:47-52](<../../src/ipc.ts#L47-L52>). Session ownership is `ownerId`, and other callers receive redacted summaries: [session.ts:148-164](<../../src/session.ts#L148-L164>). Agent names, task labels, application titles and visible badges are not authority.
- [CallerRegistry:28-59](<../../src/caller-registry.ts#L28-L59>) tracks adapter PID/start pairs, detach, disappearance and return. CLI exit is deliberately not treated as an adapter disappearance: [caller-registry.ts:1-9](<../../src/caller-registry.ts#L1-L9>).
- Host orchestration, LLM routing and teammate creation remain host responsibilities. DSH SDK or Teams membership does not itself grant native application permission. Ordinary web work uses host browser/web tools; Orbit is not a DOM session backend. Original browser/profile access requires the owner's explicit request: [product contract:3-15](<../desktop-only.md#L3-L15>).

## 2. Existing coordination, and exactly what it does not cover

| Existing mechanism | Source-proven scope | Missing future guarantee |
| --- | --- | --- |
| Caller/session ownership | Session `ownerId` checks and owner override; redacted foreign summaries | No owner-issued, broker-enforced `ConversationGrant` with a revocation epoch carried to delivery |
| Session action queue | A separate `session.tail` for each session, [session.ts:311-324](<../../src/session.ts#L311-L324>) | Not a global desktop writer scheduler |
| Creation queue | `creationTail` serializes handoff construction, original opening, monitor/presentation requests, [session.ts:235-267](<../../src/session.ts#L235-L267>), [689-727](<../../src/session.ts#L689-L727>), [759-772](<../../src/session.ts#L759-L772>) | Does not encompass existing sessions' actions or their observe/act interval |
| Worker queue | Per-worker queue, maximum 128 queued requests, with framed IDs and deadlines, [native-worker.ts:220-238](<../../src/native-worker.ts#L220-L238>) | No cross-worker fairness, clipboard arbitration or global transaction ownership |
| Python dispatch | Sequential requests within one worker, [session_worker.py:106-156](<../../src/native/session_worker.py#L106-L156>) | Different session workers can progress independently |
| Native control flock | Private control-directory settings, approval consumption and begin/finish journals | Not an operation-duration lock: [control.py:108-141](<../../src/native/control.py#L108-L141>) releases the flock before calling `operation()` and reacquires it afterward |
| Claim wait queue | Caller ordering for a handoff key, bounded wait and stale queue entries, [session.ts:212-233](<../../src/session.ts#L212-L233>), [arbitration.ts:33-67](<../../src/arbitration.ts#L33-L67>) | Not a UI action scheduler or complete alias/conflict-resource graph |
| Compositor application lease | Exact selected window binds a Wayland client; one lease per client, maximum 16 leases and 64 retained windows per lease, [ghostinput.cpp:1058-1117](<../../experiments/ghost-cursor/plugin/ghostinput.cpp#L1058-L1117>) | Not one independent writer per visible window. Two windows in one client still share that client lease |
| `NativeLease` | Exact systemd invocation, cgroup directory and PID generation membership, [lease.py:149-218](<../../src/native/lease.py#L149-L218>) | Resource/process provenance, not a UI-writer lease. Its constructor's indexed callers are experiments/tests; production imports some lease utility functions |

Standalone observation is authorized but does not enter `Sessions.enqueue`: [session.ts:863-879](<../../src/session.ts#L863-L879>). It still enters the adapter's per-worker queue. A claim that every read is globally serialized with writes would therefore be false.

### Workspace allocation

**Superseded allocation behavior:** the owner subsequently required empty,
undisplayed workspaces within 1 to 10. Current opening now checks all compositor
window occupancy and broker reservations, with a worker pre-dispatch recheck.
See [workspace opening safety](../workspace-opening-safety.md). The paragraph
below records the older baseline, not the current default or permission to reuse
an occupied workspace.

[session.ts:277-296](<../../src/session.ts#L277-L296>) samples displayed workspaces, other callers' sessions and recent opened-workspace records. [arbitration.ts:69-86](<../../src/arbitration.ts#L69-L86>) defaults to the visible numbered pool 20-99 and prefers a caller's existing unshown workspace. This is not an OS-enforced reservation against independent processes or owner actions. Recent opened records are aged and liveness-filtered; reservations and request maps are broker-memory state.

The `nativeOpens`, `nativePresentations` and allocation lookups are keyed by supplied request ID, not explicitly by caller: [session.ts:89-98](<../../src/session.ts#L89-L98>), [277-295](<../../src/session.ts#L277-L295>), [695-721](<../../src/session.ts#L695-L721>), [750-774](<../../src/session.ts#L750-L774>). Future multi-agent work must namespace operation identities by authenticated caller/grant and broker epoch; UUID conventions alone are not an authority boundary.

## 3. Observation, freshness and replay

- Image, text and both are current observation formats; metadata mode is cached acknowledged presence rather than fresh pixels: [mcp.ts:85-91](<../../src/mcp.ts#L85-L91>), [hyprland.ts:407-434](<../../src/hyprland.ts#L407-L434>).
- Text can fall back to image when accessibility is unavailable. The worker checks window process/title identity around accessibility reads: [session.py:216-237](<../../src/native/session.py#L216-L237>). It checks target size, crop geometry and host binding around pixel capture, with bounded read-only retries: [session.py:415-487](<../../src/native/session.py#L415-L487>).
- Both is not an atomic application-state snapshot. The tree precedes image capture; an application or owner may change content without changing window identity or dimensions. Timestamp, image digest and geometry checks do not prove semantic consistency or causation.
- The adapter commits acknowledged windows, image/surface scale and selected target after validation: [hyprland.ts:425-479](<../../src/hyprland.ts#L425-L479>). There is no mandatory observation revision on a later input action: current fields are app/window IDs plus action coordinates/content, [hyprland.ts:326-344](<../../src/hyprland.ts#L326-L344>), [session.py:258-280](<../../src/native/session.py#L258-L280>).
- Render-only cursor presence can be refreshed during observation; it is not physical pointer or keyboard input: [session.py:360-369](<../../src/native/session.py#L360-L369>). Future read concurrency must declare such visualization effects rather than assume zero compositor state changes.
- Session action request IDs cache the original promise and reject conflicting fingerprints, with a 10000-action limit: [session.ts:325-348](<../../src/session.ts#L325-L348>). This is in-memory deduplication, not durable exactly-once delivery across broker/worker restart.
- Batches have at most 16 same-window input actions, per-item receipts, and stop after uncertain/failing delivery: [session.ts:431-506](<../../src/session.ts#L431-L506>). A pixel baseline is explicitly not an application postcondition. Replay preserves receipts and expires image/tree payloads rather than rerunning actions: [session.ts:469-475](<../../src/session.ts#L469-L475>).
- Worker reply caching retains at most one image and marks older image replays expired: [session_worker.py:18-48](<../../src/native/session_worker.py#L18-L48>). Frame eviction is not permission to evict unresolved mutation outcomes and then blindly retry.

### Retained references are a foundation, not a current public action path

[RetainedRegistry:99-123](<../../src/native/a11y_refs.py#L99-L123>) implements bounded, namespaced, generation-tagged retained handles with expiry. [commit/resolve:162-239](<../../src/native/a11y_refs.py#L162-L239>) atomically retains a snapshot, validates target binding, rejects foreign/stale references and never re-resolves a selector to a replacement object. Its binding explicitly requires caller-proven authority epochs: [TargetBinding:40-61](<../../src/native/a11y_refs.py#L40-L61>).

Graph callers and source search found registry construction in tests, not a production commit/resolve bridge. Current action schemas do not accept these references. Do not describe production observe-to-act stale-reference protection, cross-provider generations or a public `ObservationRef` as implemented merely because this tested registry exists.

## 4. Cancellation, off and lifetime

- `orbit_usage off` blocks subsequent calls through that conversation/connection adapter. It explicitly does not close sessions or cancel accepted work: [mcp.ts:53-83](<../../src/mcp.ts#L53-L83>). This must remain explicit in a future grant design, not silently redefined as rollback.
- Session policy is rechecked at queue dispatch and after advisor awaits: [session.ts:354-420](<../../src/session.ts#L354-L420>). This is useful narrowing protection, not a revocable multi-view transaction capability.
- Pause changes state, waits for the session tail, then pauses the native lease. Adapter loss initiates pause and a grace-period stop; return leaves it paused: [session.ts:608-642](<../../src/session.ts#L608-L642>). Stop is distinct from pause, off and request cancellation.
- HTTP abort destroys the client's request; the broker dispatch path does not forward that request signal into session operations: [ipc.ts:37-52](<../../src/ipc.ts#L37-L52>), [84-116](<../../src/ipc.ts#L84-L116>). Client cancellation is not proof that accepted input was not delivered.
- Worker deadline failure aborts and reaps that owned worker, not a shared application process: [native-worker.ts:137-145](<../../src/native-worker.ts#L137-L145>), [241-270](<../../src/native-worker.ts#L241-L270>). Capture has an absolute cooperative deadline and bounded child cleanup, but OS/native syscalls cannot all be preempted: [session.py:135-208](<../../src/native/session.py#L135-L208>).
- Normal borrowed-session closure hands back control and leaves the application open: [existing.py:322-356](<../../src/native/existing.py#L322-L356>). Forced broker closure records lease-release failure rather than proving successful handback: [session.ts:558-605](<../../src/session.ts#L558-L605>).
- Broker shutdown drains owned creations/sessions; update admission refuses an open or starting session: [session.ts:662-669](<../../src/session.ts#L662-L669>), [892-900](<../../src/session.ts#L892-L900>). Never restart a shared broker to recover one view while unrelated work is active.

## 5. Geometry, identity and owner state

Monitor listing reports connector names, focus and displayed workspace metadata, not a hotplug generation: [existing.py:99-121](<../../src/native/existing.py#L99-L121>). Placement accounts for logical scale, rotation, reserved work area and bounded size: [window_geometry.py:14-64](<../../src/native/window_geometry.py#L14-L64>). Presentation acknowledges a selected workspace/output and owner-focus preservation only at that event: [existing.py:123-150](<../../src/native/existing.py#L123-L150>). Continuous visibility, stable output identity after disconnect/reconnect and safe scale reuse are not established.

Window ownership uses lease, address and compositor stable ID, not title matching: [existing.py:233-264](<../../src/native/existing.py#L233-L264>). Client-level enrollment can include sibling windows, or a selected dialog family; related portal windows have placement handling without automatically receiving the client's input grant: [ghostinput.cpp:546-590](<../../experiments/ghost-cursor/plugin/ghostinput.cpp#L546-L590>). Views must not confuse an app/window identifier with an independent client, document or clipboard namespace.

Physical owner input temporarily inhibits client agent input and releases synthetic input state: [ghostinput.cpp:1189-1240](<../../experiments/ghost-cursor/plugin/ghostinput.cpp#L1189-L1240>). This source behavior is not proof that every application preserves focus, pointer and unsaved work under concurrent owner activity. Current dated acceptance explicitly retains pointer and visibility limits: [acceptance:3-22](<../acceptance.md#L3-L22>).

Clipboard and PRIMARY are ordinary shared selections, including broadcasts to active leased clients: [ghostinput.cpp:1354-1362](<../../experiments/ghost-cursor/plugin/ghostinput.cpp#L1354-L1362>), [contract:47-58](<../desktop-only.md#L47-L58>). The text-paste fallback saves and unconditionally restores text around paste: [paste.py:26-55](<../../src/native/paste.py#L26-L55>). There is no transaction-wide clipboard epoch; a concurrent owner copy or another writer can be overwritten by restoration. Pause is not clipboard privacy isolation.

Adapter availability is reported separately from runtime operation acceptance: [desktop-machine.ts:6-44](<../../src/desktop-machine.ts#L6-L44>). Linux Hyprland needs matching source, plugin and compositor ABI; Windows/macOS and other compositors do not gain native control from installation or discovery: [contract:28-45](<../desktop-only.md#L28-L45>). Host Teams, monitor count and registered-app count cannot override those capabilities.

## 6. Proposed neutral integration map, not existing modules

| Future concept | Neutral responsibility | Existing integration seam |
| --- | --- | --- |
| `ViewBinding` | Bind caller/session/grant, adapter instance, client/window lifetime, topology and geometry epochs | Native admission/target acknowledgement in [session.ts](<../../src/session.ts>) and [hyprland.ts](<../../src/hyprland.ts>); window proof in [existing.py](<../../src/native/existing.py>) |
| `ObservationRef` | Bounded provenance, capture interval, completeness and invalidation; no title-based rebinding | Observation path plus the currently unwired [retained registry](<../../src/native/a11y_refs.py>) |
| `ConversationGrant` | Owner-authorized scope and revocation generation, checked at admission and delivery | [caller.ts](<../../src/caller.ts>), [caller-registry.ts](<../../src/caller-registry.ts>), [conversation-usage.ts](<../../src/conversation-usage.ts>), broker dispatch |
| `UiTransactionLease` | Fair, bounded UI conflict-resource ownership and cleanup fencing | Per-session queue, native worker and plugin lease boundary; not `NativeLease` and not the journal flock |
| `ActionTicket` | Immutable target/preconditions, namespaced request identity and no retry after uncertain delivery | Session admission, batch receipts, worker framing and actual native dispatch |
| `ActionOutcome` | Separate non-attempt, refusal, acknowledgement, uncertainty and verified application postcondition | Existing error dispositions, receipts and journals; never equate protocol OK with successful save |

These are proposed interfaces. New neutral modules and `src/multi-view-protocol.ts` would be future files, not current source. There is no current `src/protocol.ts` interface assumed by this map. Platform adapters supply proven capabilities; the host supplies reasoning and task decomposition outside UI leases. Orbit Core owns validation, scheduling, bounds and audited native dispatch, not an embedded general LLM team runtime.

## 7. Negative-effects audit and future acceptance obligations

| Edge case or negative effect | Current boundary or gap | Required future rule/evidence |
| --- | --- | --- |
| Two agents target sibling windows in one Wayland client | Client lease conflicts, not independent per-window writers | Derive conflict resources from actual client/dialog family, not a view label |
| One agent reasons while holding a UI writer slot | No general writer-slot mechanism today | Reason outside leases; short bounded execution, starvation and owner-priority tests |
| Long capture blocks an input worker | Per-worker serialization, no global fairness | Bounded read admission, cancellation outcome and separate queue-wait/work deadlines |
| Hotplug, rotation, scale or workspace movement after observe | Geometry samples and target lifetime checks, no topology-bound input ticket | Invalidate affected bindings and old coordinate transforms; reobserve instead of clamping stale input |
| Child dialog/portal changes process or focus | Explicit enrollment and related-window distinctions | Fresh relationship proof; never promote related placement into input authority |
| Owner copy during agent paste | Shared selection and unconditional restoration can race | Cooperative clipboard transaction/version checks; do not restore over a newer owner copy |
| Off, pause or disconnect races queued work | Different existing semantics | Revocation epoch at delivery; classify already-dispatched effects, do not promise rollback |
| Capture/reply lost after input | Request caching and uncertain receipts, no durable exactly-once guarantee | Persist bounded unresolved outcomes; never evict them into an automatic replay path |
| Multiple conversations bypass per-session limits | Local maps/queue caps only | Global and per-device resource budgets as well as caller/session bounds |
| Slow or missing accessibility provider | Text fallback and bounded capture | Preserve format/completeness evidence; no unsupported semantic locator or guessed identity |
| Shared screenshot or task title contains hostile instructions | Application data is not authority | Immutable grants, untrusted observation labels and host-side reasoning boundaries |
| Broker/compositor/provider restart reuses identifiers | Some current source/ABI and lifetime checks; no unified view epoch | New broker/provider epochs invalidate grants, references and pending tickets |
| Cleanup reports closed while lease recovery failed | Failure is journaled; application remains normal | Distinguish resource quiescence, handback verification and application postconditions |
| Multi-view throughput consumes CPU/RAM/image bandwidth | Current bounded queues are not a performance result | Measure aggregate memory, task count, payload retention, latency, fairness and owner responsiveness |

Implementation should begin only after the owner approves the future contracts. Test pure state transitions and hostile/stale evidence first, then isolated adapter fixtures, then owner-authorized original visible applications. Preserve unrelated work, normal profiles, focus and pointer; never restart the shared broker for a test. Validate real saved/reopened application state and concurrent-owner behavior independently of transport receipts. No new cross-platform support, efficiency percentage, workflow success or runtime concurrency claim follows from this document or source test counts.
