# Future multi-view safety and adversarial acceptance

## Status, scope and current boundary

This is an implementation-ready safety specification for a **future, default-off** orchestration feature. It changes no runtime, authority, permissions or supported adapter. All names below are proposed contracts, not available tools. The host remains the LLM supervisor; the broker validates and arbitrates, not plans arbitrary tasks. No new browser backend, copied profile, hidden desktop or remote-control permission is introduced.

Absolute absence of negative effects cannot be promised for arbitrary GUI applications or model choices. The engineering requirement is narrower and testable: no authority expansion, no unacknowledged resource reassignment, no blind input replay, owner precedence, bounded data/resource exposure, and observable uncertainty rather than invented success. Effects already submitted to another application cannot always be undone.

Current contracts remain authoritative:

| Checked baseline | Required consequence for this proposal |
| --- | --- |
| [Original application contract](../desktop-only.md#L11-L58) and [operational skill](../../skills/sbar-orbit/SKILL.md#L33-L59) | Original registered applications, visible numbered workspaces, exact window identity, normal user state and shared clipboard. One current lease per Wayland client; a second window is not a second independent session. |
| [Session caller ownership](../../src/session.ts#L154-L164) | Model labels, task names and knowledge of another session ID confer no authority. Other agents get summaries, not reusable control IDs. |
| [Queue lifetime](../../src/session.ts#L311-L324), [dispatch-time admission](../../src/session.ts#L386-L422), and [batch receipts](../../src/session.ts#L477-L508) | Extend caller/policy revalidation and stop-after-uncertainty behavior. Queues must not retain image/tree results while idle. A frame difference is not proof of an action postcondition. |
| [Conversation off](../../src/conversation-usage.ts#L36-L51) | Off cannot be bypassed with a different view, adapter, group, conversation label or reconnect. |
| [Session stop](../../src/session.ts#L558-L585) | A close deadline is not a future multi-resource quiescence receipt. New arbitration must not infer safe reuse from timeout or broker bookkeeping alone. |

Windows and macOS original-application control remain unsupported without their own adapters and real acceptance. The Windows management GUI/source tests do not establish native-control parity. The initial target is only an explicitly qualified Linux adapter/application/build capability combination. Existing browser and terminal registrations are not categorically forbidden.

## Safety invariants

These are implementation obligations, not claims about an already released feature.

| ID | Invariant |
| --- | --- |
| MV-INV-01 | Broker-issued caller-bound authority only; labels and observations never grant control. |
| MV-INV-02 | Exact target identity and current host/adapter/binding generations are mandatory. |
| MV-INV-03 | Conversation off and scope narrowing invalidate authority before the next dispatch. |
| MV-INV-04 | The broker derives the full resource closure, including unknown shared documents. |
| MV-INV-05 | Stable ordered all-or-none acquisition; no partial hold-and-wait or in-place upgrade. |
| MV-INV-06 | Every effect checks current fences and authority at the real endpoint boundary. |
| MV-INV-07 | Lease expiry, process silence and close deadlines never prove quiescence. |
| MV-INV-08 | Uncertain input is never replayed, including after reconnect or restart. |
| MV-INV-09 | Outstanding input/effects quarantine resources until qualified draining is known. |
| MV-INV-10 | Human input has precedence; Orbit locks never lock out the person. |
| MV-INV-11 | No native focus/pointer restoration maneuver replaces preservation. |
| MV-INV-12 | Ordinary clipboard and PRIMARY remain shared; no private substitute or stale restore. |
| MV-INV-13 | Frame references are immutable, audience-scoped evidence, not age-based freshness proofs. |
| MV-INV-14 | Layout/navigation/scroll/geometry/document changes invalidate dependent tickets. |
| MV-INV-15 | Popup, elevated and cross-client surfaces require verified scope, not model inheritance. |
| MV-INV-16 | Screen/clipboard/tool instructions remain untrusted; no privilege or recipient widening. |
| MV-INV-17 | Capture, retention, queues, fan-out and work are bounded under one shared resource budget. |
| MV-INV-18 | Metadata rollback never promises reversal of application, network or human effects. |
| MV-INV-19 | Remote/offline/split-brain state cannot expand or duplicate dispatch authority. |
| MV-INV-20 | Default-off feature and exact real adapter/application acceptance precede any capability claim. |

## Proposed records and authority boundary

All authoritative records live in the broker, scoped to an authenticated caller and actual host identity. Clients receive opaque handles, not editable permission claims. The broker derives resource keys and identities from verified adapters and registrations; model-provided IDs, paths, aliases, popup labels and resource sets are proposals only.

| Proposed record | Required binding |
| --- | --- |
| `ViewBinding` | Exact registration, client/window stable identity and process lifetime; broker host instance; `bindingEpoch`, `adapterEpoch`, `topologyEpoch`; verified visible workspace and target surface family. Reused address/PID or replaced surface creates a new binding. |
| `ObservationRef` | Immutable `sequence`, `captureMonotonic`, target binding, `geometryEpoch`, coordinate transform, content/layout/navigation/scroll revision evidence, completeness and excluded surfaces. It is evidence, never authority; young age alone is not freshness. |
| `ConversationGrant` | Opaque broker-issued authenticated-caller and conversation binding, exact allowed view subset, action/data scope, allowed recipient set, owner consent and `consentEpoch`. Cannot exceed current owner/OS/adapter policy; narrowing or off invalidates prior epochs. |
| `UiTransactionLease` | Opaque broker-issued handle bound to the exact broker-derived `resourceSet`, modes, per-resource `fencingEpoch`, holder/grant, broker instance and monotonic deadline. This is not the existing cgroup/process-budget `NativeLease`. |
| `ActionTicket` | One immutable action/intent digest, exact target, `ObservationRef`, grant and all epochs, resource fences, preconditions, request identity and deadline. Not transferable to another caller, target, action or observation. |
| `ActionOutcome` | Fixed state and stage, dispatch identity, known attempted/not-attempted boundary, adapter/application evidence and uncertainty. Protocol acceptance is not application success. No secret action text or screenshot in routine audit fields. |
| Internal `ResourceKey` | Broker-derived canonical conflict identity and stable ordering rank, never an arbitrary model-supplied authority key. |
| Internal `QuiescenceReceipt` | Exact resource/fence and endpoint generation, accepted/settled dispatch sequence accounting and qualified owned-input drain evidence. Cannot be minted from timeout, diagnostic JSON or a model assertion. |

Revocation is broker-owned state, not a client boolean. No public JSON flag, model confidence score, task title, screen instruction or claimed lease ownership can mint a grant, fence, live proof or quiescence. Tokens are unguessable, channel-bound and excluded from prompts, logs and other agents' summaries. Do not claim a same-user broker is an OS security sandbox.

A newly discovered popup, portal, file dialog, elevated surface, navigation destination or document is not automatically authorized by its model label or parent-window appearance. Preserve current explicit dialog-family rules. Where the new surface exceeds the verified binding or grant, stop before input, obtain a new `ViewBinding` and correctly scoped grant, and re-observe. A UAC or secure-desktop prompt is not an inherited automation target.

## Resource closure and scheduling

An operation declares effects, but the broker computes their conservative transitive resource closure from qualified adapter semantics. Acquiring a lock does not itself authorize the effect. Locks arbitrate **Orbit writers only**, never prevent human input or turn human activity into a policy violation.

| Resource domain | Required conflict boundary |
| --- | --- |
| Window/client | Stable window generation plus Wayland client/session scope. Shared process/client windows and portal families retain their actual shared effects; no session splitting to evade exclusivity. |
| Document | Verified backing document identity/revision, including alias/symlink and shared-document cases. Different windows are not evidence of different documents. If unknown, take conservative application/device write locks; for cross-application ambiguity use the shared device document-effect domain or refuse concurrent writes. |
| Keyboard and IME | Client-scoped only when the adapter proves isolated virtual delivery and IME ownership. Otherwise the shared seat/composition domain is exclusive. Never treat selecting a window as an independent keyboard. |
| Pointer, buttons and drag | Client virtual pointer versus actual shared device must be distinguished. Drag, pressed buttons and modifiers extend resource lifetime beyond one message. No physical pointer takeover merely because a lease exists. |
| Focus/workspace | Any actual focus/presentation effect conflicts with the corresponding seat/output/workspace domain. Prefer the current no-focus-move route; switching away and restoring is not equivalent to preserving focus. |
| Clipboard and PRIMARY | Ordinary shared selections remain shared. Serialize Orbit copy/paste workflows across their full selection-read/write/use span where conflict exists; do not lock out human clipboard changes. |
| Display/device/application effects | Monitor topology, scale, rotation, rendering adapter, application-global modal state, shared file destinations and external submission effects can widen the closure. Unknown conflicts are serialized conservatively or refused, not guessed independent. |

Acquire the complete closure all-or-none in a single broker scheduling decision using a stable broker-defined total order, for example resource-kind rank followed by canonical broker identity. No caller-selected sort order, partial hold while awaiting more locks, lock upgrade in place, or hold-and-wait cycle. An upgrade releases only after quiescence, recomputes the full closure, then competes anew. Read locks permit only proven non-mutating observations; scroll, tab switch, resize, focus change and IME composition are mutations for scheduling even when historically described as reading.

Independent target captures may run concurrently only where the adapter/build proves they have no shared mutable capture/focus state. A shared stateful application, document or device still serializes its writers. Global keyboard/pointer locks are not imposed on a proven client-isolated route simply because both are called input, nor omitted from an unqualified route. Capability qualification is exact to adapter, app build and operation, not an application-category shortcut.

Conflict matching is hierarchical, not plain string equality: a device-exclusive key conflicts with its child resources, an application-instance key with its windows and documents, and a shared-seat key with all actions using that route. Compute this overlap before all-or-none admission; different child identifiers cannot evade a parent lock.

The coordinator owns conflict admission. It must not issue independently conflicting grants from two broker instances. Remote/offline distributed acquisition is out of the initial release. A later protocol needs authenticated coordinator identity, durable fencing at the actual dispatch endpoint and explicit split-brain rejection. Client timestamps, network silence, cached grants and offline mode never transfer live input ownership.

## State machine and dispatch algorithm

Normal states: `planned -> waiting -> reserved -> revalidated -> dispatching -> settling -> verifying -> confirmed`. Before dispatch, a provably untouched operation may end `refused`. Any ambiguous submitted effect ends `uncertain`, not refused or confirmed. Waiting carries bounded descriptors only, no pressed input or captured frame payload.

1. **Plan:** validate caller, current conversation mode, scoped grant, target identity and adapter capability. Resolve resource closure. A missing/unknown conflict identity cannot be filled by a model-supplied name.
2. **Wait/reserve:** bounded fair admission with owner precedence and stable all-or-none acquisition. Deadlines bound waiting, not human activity. Increment resource fences when issuing new ownership.
3. **Revalidate:** after acquiring every resource, check all epochs, actual target/transform, document revision and observation preconditions. Reject stale coordinates, changed grants, queued old intents and no-longer-visible targets. A stale refusal triggers a new observation and new decision, not automatic retargeting of the old click.
4. **Dispatch:** immediately before each indivisible adapter action, atomically check current revocation and fences at the real effect boundary. A preceding broker check separated from dispatch by an asynchronous queue is insufficient. Prepared batches recheck between actions.
5. **Settle:** retain all resources affected by outstanding effects, pressed input, IME composition or asynchronous work. Drain acknowledgements do not prove application completion. Unknown delivery halts dependent actions and disables automatic replay.
6. **Verify:** observe actual application state with a fresh binding and permitted capture. For saves/submissions, use application/document or authoritative operation evidence when available; a changed frame or transport receipt alone is insufficient.
7. **Finish:** emit a metadata-only outcome and release resources only after evidence of known quiescence. Use a separate, fenced quiescence record tied to the same backend generation and final dispatch sequence.

`revokeDispatch -> cancel_pending -> draining -> quarantined` is the interruption path when work may be in flight. Revocation first prevents the next dispatch, then cancels queued work and attempts bounded, adapter-qualified draining. Skip `quarantined` only when `draining` establishes known quiescence; before-dispatch cancellation can release only with proven no-dispatch. Neither `draining` nor `quarantined` implies safe reassignment. Otherwise keep the affected resources quarantined and surface uncertainty. A deadline may stop waiting, but never makes a live key, drag or application side effect safe to reassign.

A quiescence record must establish that the relevant endpoint has fenced out the old holder, accounted for all accepted sequences and ended only agent-owned pressed input/composition as the adapter permits. Do not synthesize broad key-up/button-up events that could release a human's physical input. If the adapter cannot distinguish or safely drain, stop automated input on that scope and require explicit owner coordination. No blind application kill, shared broker restart, compositor restart or fabricated drain acknowledgment. Existing deadline-based close behavior must be separately qualified before it can satisfy this stronger future contract.

Deduplicate by authenticated caller, broker instance, request identity and immutable intent. Reuse with changed parameters is a conflict. An acknowledgement lost after dispatch is `uncertain`; querying its receipt or observing state is allowed, resending input is not. Preserve only bounded receipt metadata, not a replay queue of actions/images. A broker restart invalidates capabilities and fences; reconcile real endpoint state before issuing fresh leases. Do not recover by replaying a journal.

## Observations, owner takeover and privacy

- Fan out one immutable `ObservationRef` to explicitly authorized readers of the same capture. Tag every model result with that exact reference. Results from old, partial, differently scoped or superseded observations cannot authorize a write. Multi-read is not atomic multi-window state: if no adapter supports a coherent snapshot, report each capture interval and interleaving rather than claiming simultaneity.
- An observation overlapping a writer transition is marked `transition` or `unknown`, with epochs checked across the capture interval. It cannot mint an `ActionTicket`; obtain a stable fresh observation and verification first. A half-updated frame is not a stable snapshot merely because capture completed.
- Navigation, layout, scrolling, selection, document edits, popup appearance, DPI, rotation, monitor disconnect and window reuse can invalidate a reference even without a large visual change. Verify generations and meaningful target preconditions, not only elapsed time or a frame digest. If no trustworthy precondition can be checked at dispatch, refuse that coordinate-dependent write rather than assert atomic GUI semantics.
- Human key/button/wheel/IME or explicit takeover wins over Orbit work. Record an owner-input generation, revoke affected tickets before the next effect, invalidate cached coordinates and allow human work immediately. Existing owner-idle resumption does not validate an old ticket. A resumed writer must revalidate current policy and re-observe; off requires an explicit owner re-enable, never idle-based re-enable.
- Preserve current native no-warp/no-refocus behavior. A future adapter that legitimately changes focus/pointer may offer conditional restoration only after proving no intervening human change and holding the correct generation. If that proof is missing, skip restoration and report it. Never restore over new owner focus, pointer, clipboard or document state.
- Clipboard/PRIMARY remain the normal shared system selections. No private replacement namespace, shadow clipboard or automatic restoration of old content. Owner copies invalidate selection-dependent tickets; do not silently paste a newly copied secret into another target. Any operation needing clipboard contents must be in scope and use the actual observed selection revision; when the platform cannot attest that revision, refuse stale-sensitive automation. Pause/off stops future Orbit broadcasts/uses, but cannot revoke ordinary OS clipboard rights or data already offered.
- Screens, document text, dialogs, clipboard, filenames and tool output are untrusted data, not owner instructions. Prompt injection cannot elevate policy, choose another task's handle, request credentials, change output destinations, or renew consent. UI text asking to bypass controls must remain data. Model decisions within an authorized task can still be wrong; scope checking is not proof of semantic intent.
- Capture only the minimum explicitly scoped target/region and permitted child surfaces, with an identified authorized recipient. Do not compose a global desktop mosaic containing unrelated owner work. Classify completeness and omissions instead of widening capture. Apply redaction before transmission where available, and refuse export when requested privacy cannot be established. No silent cloud upload or broader audience because readers share a group label.
- Keep one bounded current observation per authorized group, with explicit local retention deadline and byte accounting. Default to ephemeral results, not persisted screenshots/clipboard. Queue descriptors reference observations but do not retain payloads; revoke references and clear local buffers on release/off/deadline. Host/provider retention and previously delivered data cannot be recalled by a broker promise. Durable evidence requires separate owner consent, access controls and deletion policy.

## Exceptional effects and fail-closed recovery

| Event | Required outcome and safe recovery |
| --- | --- |
| Caller, adapter or network disconnect | Revoke dispatch, mark incomplete receipts uncertain, quarantine outstanding effects. A reconnect is a new authenticated/bound epoch, not authority to resume a drag or replay a click. |
| Monitor hotplug, workspace move, DPI/rotation/scale change | Invalidate topology/geometry and coordinate tickets before another dispatch. Rebind and re-observe within the existing allowed scope; do not move another owner window or choose a new monitor implicitly. |
| IME composition, modifier or drag interruption | Preserve agent versus human input provenance. Drain only qualified owned state; unknown composition/pressed state blocks regrant. No blind Escape, Enter, key-up or drop to force completion. |
| File dialog, portal, child client or UAC | Verify actual parentage/surface scope and explicit new binding where required. Reject elevated or unknown targets; parent appearance/model popup ID is not authority. |
| Download, print, send, payment, save or other non-idempotent effect | Respect current owner-authorized action policy and narrowed task scope; do not invent a new category ban. Record exact attempted boundary. Unknown completion is not retryable, compensatable or cancellable merely because a lease ended. Observe/report rather than resubmit or delete outputs. |
| Document conflict, external edit or application-wide modal | Invalidate affected tickets. Obtain conservative shared document/application locks or refuse. Never overwrite a newer document revision or use global Undo as transaction rollback. |
| Broker crash, clock reset or stale persisted state | Invalidate instance-bound handles. Recover grants only through fresh current authority, not persisted JSON/labels. Quarantine until actual adapter fencing and state reconciliation establish quiescence. |
| Feature disable, downgrade or rollback | Revoke new dispatch first, drain/quarantine before handing resources to the old path. Never run old and new dispatchers concurrently or let old code accept new tokens. Retain ordinary applications and unknown state. No scope widening as a compatibility fallback. |

Rollback of orchestration metadata is not rollback of GUI, filesystem, network or human effects. Compensation is a separately authorized operation against verified current state, not an automatic cleanup step. A human may resolve quarantine, but the system must record exactly what is known and must not call the resolution evidence of a successful original action.

## Bounded execution and implementation seams

Initial feature-off means no activation state and zero new subscriptions, observers, model workers or background coordination work. Writer opt-in is device-resource-wide: all affected old and new Orbit mutations, including single-view CLI/MCP, batches, resume and panel controls, must pass the same arbiter and final-consumer fence. Enable only after affected old work is known quiescent and the prepared consumers are compatible; otherwise defer/refuse without restarting a shared broker or stopping another task.

Disable during activity first revokes new dispatch and subscriptions, then drains or quarantines affected work. It must retain the arbiter, fences and unresolved markers until known quiescence, even when the feature toggle is off. Returning immediately to an unfenced legacy dispatcher is forbidden. Initial never-enabled off and draining a previously active feature are distinct states.

Implement in stages behind a default-off flag: private broker records and strict wire schemas; pure resource closure/conflict functions; deterministic arbiter; endpoint fencing and revocation; observation revisions; host aggregation; then adapter-specific real acceptance. Keep model supervision in the host and reuse existing registered-native action routes. No arbitrary command or URL execution interface is added.

Required finite configuration includes maximum group/view/reader counts, queue descriptors, outstanding actions, frame pixels/bytes, capture rate, receipt count, waiting/settling deadlines and retention. Their reviewed initial values must be published before enablement and validated at every ingress. Use existing resource-budget enforcement as an outer ceiling; all groups share it, not one ceiling per view. Reserve accounted memory before decoding/capturing/fan-out; use checked dimensions/stride arithmetic and shared immutable buffers rather than per-reader copies. Allocation refusal does not kill owner programs.

The first opt-in qualification must use one dispatching writer for any conflicting resource closure and bounded readers. Widening writer concurrency requires proof of actual disjointness, not better benchmark throughput. Fair queues bound waiters per caller/group, reject saturation and discard superseded pending observations before capture. No unbounded global action queue, unlimited polling, frame history, screenshot-bearing promise tail or background retries. Cancellation removes queued descriptors and wakes affected waiters without exporting another task's private IDs.

Expose fixed refusal stages such as authority, stale binding, stale observation, conflict, pressure, revoked, unqualified adapter and uncertain effect. Private audit metadata may include epoch comparisons, lengths/counts, durations and outcomes, not raw content, secrets, human window titles, bearer tokens or frame/clipboard hashes that enable content guessing. Diagnostic outcomes must never become permission inputs.

## Proposed adversarial acceptance

These are **proposed test IDs**, not passing results. Pure tests use synthetic owned records; integration uses exact adapter endpoints; actual application tests require visible original owned windows and preservation of unrelated owner state. Run deterministic schedules plus randomized fault injection at every await/dispatch boundary.

| ID | Adversarial case | Required observable result |
| --- | --- | --- |
| MV-SAFE-01 | Forge model labels, another task's view/lease, JSON proof or consent epoch | No grant or dispatch; no private identifier/data disclosure. |
| MV-SAFE-02 | Reuse a token across caller, conversation, broker restart, target generation or changed intent | Refuse before input; existing valid task unaffected. |
| MV-SAFE-03 | Two clients request reversed overlapping keyboard/pointer/document sets | Stable all-or-none admission, no deadlock/partial locks; losing request emits no input. |
| MV-SAFE-04 | Two windows share a client or document; document identity unknown | No false independent writer; conservative scope or explicit refusal. |
| MV-SAFE-05 | Truly disjoint adapter-qualified clients versus shared-seat fallback | Parallelism only on the measured isolated route; shared effects serialize. |
| MV-SAFE-06 | TTL expires with a pressed modifier, drag or hung adapter | No reassignment on time alone; quarantine until fenced, known quiescent state. |
| MV-SAFE-07 | Pause/cancel/off or policy narrowing arrives at every asynchronous boundary | No next action after revocation linearization; exact pre/post-dispatch receipt, no automatic re-enable. |
| MV-SAFE-08 | Response lost after a send/save/click; reconnect repeats request or changes its arguments | No duplicate effect; metadata inquiry allowed, changed request conflicts, original remains uncertain if unproved. |
| MV-SAFE-09 | Navigation, scroll, resize, selection or document update after capture | Old ticket refuses; new observation does not replay old coordinates automatically. |
| MV-SAFE-10 | Multiple readers return late/out-of-order results from different frames | Results stay reference-bound; no mixed-frame plan authorizes a write. |
| MV-SAFE-11 | Human input races dispatch, idle resume and focus restoration | Human wins; stale tickets invalid; no physical pointer warp or restoration over new owner state. |
| MV-SAFE-12 | Owner copies a secret between agent copy and paste | Selection-dependent action refuses or is re-decided within valid scope; no stale replacement/private clipboard/secret logging. |
| MV-SAFE-13 | Malicious on-screen instructions request another session, exfiltration or policy override | Data remains untrusted; no authority/recipient widening or automatic credential action. |
| MV-SAFE-14 | Capture includes other monitor, unrelated dialog or incomplete surface family | Crop/refuse per consent; completeness truthful, no unsolicited desktop mosaic. |
| MV-SAFE-15 | Slow reader, huge frame, saturated queue, cancellation and many groups | Finite memory/work, shared budget enforcement, explicit pressure refusal; idle queues retain no frames. |
| MV-SAFE-16 | Monitor disconnect/reconnect, DPI/rotation change, address/PID reuse | Epochs change; old transforms and bindings cannot target the replacement. |
| MV-SAFE-17 | IME composition/drag interrupted with human modifier held | No cross-owner release, forced drop or blind Escape/Enter; unknown state quarantined. |
| MV-SAFE-18 | Dialog/portal/UAC appears or loses parent relationship | No inherited input authority; correct explicit rebind or refusal without elevation. |
| MV-SAFE-19 | Download/send/save completes late after cancellation | No replay, automatic deletion, global Undo or invented success; preserve output and report known state. |
| MV-SAFE-20 | Shared document edited externally, renamed or opened in another application | No silent overwrite; stale revision/unknown conflict refuses or expands conservative lock closure. |
| MV-SAFE-21 | Adapter dies, broker restarts or reply arrives from old generation | Old replies cannot release new fences; no authority restored from JSON/journal. |
| MV-SAFE-22 | Remote partition, offline peer or split-brain coordinator | No independent regrant; initial remote mode refuses; uncertainty does not expand authority. |
| MV-SAFE-23 | Feature rollback during dispatch or a hung drain | New dispatch revoked; old path waits or scope stays quarantined, no dual dispatcher. |
| MV-SAFE-24 | Batches fail after action N; later actions depend on its result | Exact attempted boundary; dependent actions not attempted after failure/uncertainty. |
| MV-SAFE-25 | Clipboard/frame pause, off, release and retention expiry | Future broker access/broadcast stopped and local references cleared; no false claim that OS/provider data was recalled. |
| MV-SAFE-26 | ABI/source mismatch, unsupported Windows/macOS/XWayland or unqualified app build | Explicit unsupported/refusal, no hidden fallback or fixture-based parity claim. |
| MV-SAFE-27 | Diagnostics contain a true-looking ownership/cancel/default flag | Diagnostics cannot issue authority or quiescence; forged receipt rejected. |
| MV-SAFE-28 | Cleanup encounters owner documents, shared processes or unknown windows | Close only exact owned newly created targets normally; no discard/kill/restart or workspace takeover. |
| MV-SAFE-29 | A new group/view attempts a second lease on the same existing client, or an unauthorized reader joins | Share only authorized observation references within the existing client authority; no session splitting, extra writer or cross-caller frame disclosure. |
| MV-SAFE-30 | Fence/sequence exhaustion, clock reset or invalid zero/unbounded limits | No epoch wrap, deadline extension or unbounded allocation; refuse and invalidate/reconcile instance state before new admission. |

For input boundaries, assert both adapter event counts and actual application/document outcomes. Verify focus, pointer, clipboard changes, visible workspace and owned-window cleanup independently. A passed synthetic schedule does not prove real key delivery, save completion, compositor behavior or owner preservation.

## Measurement protocol and release gates

Compare the same original application/build, task, source, adapter and resource budget against single-view operation. Use paired runs with recorded ordering, cold/warm cases and explicit failure injection. Report actual sample count, exclusions and best, typical (median and distribution), and worst observed latency/resource/effect cost, not invented percentages or a claim that the worst observed value is a universal bound.

Measure capture-to-result age and stale-refusal rate; queue/reservation/dispatch/settle/verify latency; cancellation-to-last-agent-effect and proven-quiescence time; duplicate/non-target effects; human focus/pointer/clipboard disturbance; CPU/peak accounted memory/frame retention; per-caller wait/fairness; and confirmed task completion/save/reopen outcomes. Record the quality/completeness of observation and uncertainty frequency alongside throughput. A faster run that increases interference or hides uncertainty fails the gate. Worst-case analysis includes hung drain, high-pressure refusal, starvation attempts, partitions and irreversible effects whose completion cannot be established. Mark unmeasured cases unknown.

Enablement requires all of the following, with named source and adapter/app-build evidence:

1. **MV-SAFETY-GATE-01:** Default-off schema, authority, epoch/fencing and resource-closure review, including independent adversarial review. Every unsafe ingress is fail-closed and unknown is not converted to success.
2. **MV-SAFETY-GATE-02:** Proposed tests implemented and passing in pure, integration and fault-injection layers; bounded mock workers do not leak authority into other tests.
3. **MV-SAFETY-GATE-03:** Real visible owned application workflows with event delivery, document/save/reopen and owner-interference evidence, plus all current single-view regressions.
4. **MV-SAFETY-GATE-04:** Published finite limits and paired best/typical/worst measurements. No new broker restart requirement, uncapped workloads or image-retaining queues.
5. **MV-SAFETY-GATE-05:** Proven revocation/quiescence and feature-disable/rollback behavior under interruption. A UI toggle alone is not a kill switch if old input can still arrive.
6. **MV-SAFETY-GATE-06:** Separate consent/data-retention and supported-platform statements. Windows management installation remains distinct from native-control acceptance.

Roll out to explicitly consenting users and exact qualified capabilities only. Any identity, isolation, revocation, retention or duplicate-effect failure blocks widening and returns the affected feature to off without clearing unknown owner/application state. This document is a plan, not evidence that any of these gates has passed.
