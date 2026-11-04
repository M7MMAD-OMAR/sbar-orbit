# Multi-view and multi-agent coordination: future implementation plan

Status: DESIGN ONLY. This document does not enable a feature, grant desktop authority, or establish runtime acceptance. Implementation is future work.

Planning baseline: 4 November 2026, `main` documentation baseline `28f2609ad4939300e6746899074c8b0c03b93d36`; reviewed functional code baseline `0c53b8e182817ff990e129414d11dc51523bff42`. Source version `0.4.3` remains an unpublished candidate. The owner delegated actual Windows 11 testing to another machine. This planning task does not resume Windows implementation, CI or remote access.

## 1. Decision and document map

Build toward **one conversation supervising several explicitly selected original application views, with parallel observation and reasoning but coordinated, verified effects**. Begin with multi-view, not extra models or independent input seats. A second display is not a second keyboard, focus channel or user session.

- [Current-state audit](multi-view-current-state.md): existing code, exact integration points and evidence gaps.
- [Safety specification](multi-view-safety.md): invariants, failure/recovery rules and adversarial acceptance.
- [Primary-source comparison](../research/multi-view-platforms.md): competitor capabilities, limitations and adoption boundaries.
- [Machine-readable work items](multi-view-work-items.json): dependencies, expected write scopes, deliverables and gates. Every item is planned, not implemented.
- [Current product contract](../desktop-only.md) remains authoritative. [Acceptance evidence](../acceptance.md) and [Linux verification](../linux-verification-2026-11-04.md) do not establish this feature.

### What is and is not being proposed

| Concept | Meaning | Decision |
| --- | --- | --- |
| Conversation | Host-level request and supervision scope | One conversation may supervise multiple approved views |
| Agent | Planner, reader, reviewer or executor in the host | Roles are useful; labels never grant authority |
| View | A stable original application/window binding | Primary coordination and UI unit, not a screenshot rectangle alone |
| Shared page/document | Multiple workers examining the same mutable state | Parallel readers, one owned write transaction; navigation invalidates observations |
| Monitor | Physical output and capture geometry | Presentation metadata, not independent input authority |
| Workspace | Visible numbered arrangement of original windows | Existing owner-preserving workspace contract, not an isolation boundary |
| Browser context/profile | Browser storage and authentication boundary | Not an Orbit-native session backend; do not copy personal profiles |
| Seat | Actual OS/compositor input routing domain | Use only adapter-proven capabilities; extra seats are a later research branch |
| Device | Independent OS/input environment | Possible future orchestration boundary, not part of initial delivery |
| VM/hidden desktop | Separate application and state environment | Not a substitute for the original application contract |

Non-goals: no generic LLM/provider engine inside the broker, no hidden desktops, cloned browser profiles, universal multi-cursor promises, replacement clipboard, broad new browser/terminal bans, Windows/macOS native-control parity, autonomous remote access, or new release/deployment from this plan.

## 2. Useful workflows and counterexamples

1. Observe an owner-approved application while a build runs in an already approved terminal; report the actual app result when the build completes. The terminal remains an original registration, not a new arbitrary launcher API.
2. Read a synthetic spreadsheet and verify the result in an owned editor. A clipboard-dependent transfer is one shared-resource transaction, not two independent writers.
3. Two readers compare different approved windows; a reviewer summarizes contradictions; one executor edits only the explicitly selected target.
4. Within one page, one reader extracts facts and another checks them from the same versioned observation. A navigation or form edit invalidates both readers before a subsequent action.
5. A human takes over an application without the agents fighting focus, warping the pointer back, or restoring stale clipboard data.

Do not multiply agents for a single click or a short deterministic task. Several monitors displaying the same state do not increase useful parallelism. A dependency chain remains sequential where its inputs are not ready. Model costs, capture work and verification can exceed the saved time; enable delegation only for measured task families.

### Verified planning blockers, not repaired features

The current-state audit identifies distinctions that must not be hidden behind the existing test count: current session and worker queues are not a broker-wide UI transaction scheduler; the native control settings/journal lock is released before the application operation; a native process/cgroup lease is not a UI writer lease; conversation off currently blocks subsequent tool calls rather than proving cancellation of already accepted work; and tested retained-reference helpers must not be assumed wired into production. The audit also found request-ID maps not explicitly caller-namespaced and a paste fallback that unconditionally restores saved text clipboard content, which can race a newer owner copy. These are source-grounded readiness gaps for the proposed feature, not newly measured wrong-target incidents. Each needs exact integration and negative tests before the corresponding future gate can pass.

## 3. Layer boundaries

```text
Owner and AI host
  conversation supervisor, optional specialist models, human takeover
  host UI cards, task dependencies and provider budgets
                 | authenticated caller binding, scoped request
Orbit broker
  existing policy/caller/session admission
  proposed view registry and bounded observation broker
  proposed resource scheduler and action journal
                 | fenced, target-bound existing adapter operations
Native adapter and final input consumer
  live identity, topology and capability checks
  serialization for actual shared resources, settle and read-back
                 |
Original installed applications on explicit visible workspaces
```

The host decides how to reason and delegate. Orbit admits and verifies access to application resources; it does not trust host role names, model-generated DAGs or UI labels as permission. A DSH team member is not automatically an authorized Orbit caller. Native process/cgroup lifetime leases are not UI transaction leases.

All Orbit mutation paths must use the same applicable admission, resource and final-dispatch checks, including old single-view clients, CLI, MCP, batches, resume and panel controls. An opt-in coordinator around only new requests would leave old requests able to interfere. Ordinary host browser tools and human OS input remain outside Orbit fencing; observe their changes, invalidate preconditions and pause/refuse when safety cannot be established. Do not promise that a broker lock controls the whole operating system.

Writer opt-in is device-resource-wide even if requested by one conversation: all affected legacy Orbit writers must join the same arbiter. Do not enable it over an already active old route without known quiescence and a compatible consumer; refuse/defer the opt-in rather than restart or stop someone else. Initial feature-off has no new background work. Disabling an active feature must retain fencing and unresolved quarantine until drain is proven; it cannot immediately bypass the arbiter into a legacy writer path.

## 4. Proposed records and authority

These are design names, not existing exports or accepted wire fields. Final schema/version negotiation is a phase gate.

| Record | Required binding and meaning | Must not mean |
| --- | --- | --- |
| `ViewBinding` | Broker identity for registered application, process birth identity, native window, workspace, adapter instance and binding/topology/geometry epochs | A model-supplied title, PID, display index or window coordinate is ownership |
| `ObservationRef` | View binding, sequence, monotonic capture time, format, geometry epoch, completeness and opaque reference to bounded content | Age alone proves freshness; two views were captured atomically |
| `ConversationGrant` | Opaque broker-issued authority bound to authenticated caller, approved view/action scope, expiry and consent epoch | Conversation ID, agent name, JSON boolean or copied capability from another caller grants access |
| `UiTransactionLease` | Broker-issued ownership of the conservative resource set with fencing epochs and bounded deadline | Process lifetime lease, TTL expiry or client disconnect proves input stopped |
| `ActionTicket` | Grant, target, observation/preconditions, intent digest, resource lease and request identity | A reusable arbitrary command or permission to expand to a popup, other app or document |
| `ActionOutcome` | Correlated delivery, settle and verification states; confirmed/refused/uncertain separated | A successful transport reply proves an application effect |
| `QuiescenceReceipt` | Internal evidence that the owned input operation is stopped and relevant pressed state is reconciled | A timeout, missing heartbeat or empty queue is enough |

Model-visible objects contain opaque IDs and bounded status. They cannot mint or edit the trusted internal records. Permissions attenuate when delegated: a reviewer cannot acquire write authority from a reader token. Correlation labels do not select another conversation or caller. This remains cooperative same-user control, not a sandbox against a malicious process with the same OS privileges.

Current caller attribution proves some process/liveness/same-user facts; an arbitrary conversation string is not a host-issued identity. A future grant must bind the protected owner-authorized connector/caller mapping and instance epoch, not only that string. Owner credential checks cannot be replaced by a model request-body role.

A view is not automatically a new native session or client lease. Several permitted windows in one client must reuse the existing qualified authority and shared client resource where supported; do not create a second writer lease per card. A view request cannot split or take over another caller's existing client lease. Shared observation still requires explicit grant authorization.

An observation binds to the original target, not its screen position. Unknown document identity across two windows requires a conservative app-instance or device lock until an adapter proves narrower independence. Single-instance applications, shared accounts and shared documents can couple apparently separate windows.

## 5. Observation and monitoring branch

### Registration and scope

- Enumerate approved registrations and windows through existing discovery. Bind exact native identity and actual workspace/output metadata. Do not auto-open, move, activate or capture every discovered window.
- Let the owner select the initial views and whether each may be observed or controlled. Preserve existing full/protected action settings; adding multi-view must not silently broaden them or invent per-keystroke approval requirements.
- Display caller-friendly labels as escaped untrusted text. Window titles, OCR, accessibility text, remote pages and tool output cannot modify grants or task policy.

### Capture pipeline

- Prefer an available, qualified text observation when sufficient; use image or both when needed. Never silently substitute text for a required pixel assertion, or a screenshot for a required semantic state check. Report requested and actual returned formats; current text requests can fall back to image when accessibility is unavailable. A future text-only observation grant must refuse an unauthorized image fallback rather than widen capture scope. The current both format obtains tree and pixels separately: bind each part and label temporal consistency unknown/non-atomic unless an exact adapter proves otherwise.
- Subscribe only while explicitly active. Read-only means no application edit/input, not necessarily zero compositor visualization: the current observation path can refresh an agent cursor overlay. Qualify and disclose such rendering without moving the physical pointer or stealing focus. Use validated app/window events where available; otherwise use a bounded polling fallback with visible status and a finite lifetime. Do not treat missing event coverage as proof of no change. Captures overlapping a write/transition are labeled transition or unknown, not stable action preconditions; detect relevant epoch changes across the capture and require a stable fresh verification before minting an action ticket.
- Coalesce change notifications. Retain at most the latest pending observation per view and discard superseded unconsumed data without declaring the skipped states observed.
- Share an immutable capture internally only among callers whose grants authorize the same content. Never broadcast a shared snapshot across conversations merely because their target IDs match.
- Capture each view independently and expose timestamps/sequence. Cross-view summaries must identify skew; use a fresh verification barrier when a task depends on consistency between views. There is no assumed global screenshot transaction.
- No continuous screenshot wall, full-desktop capture default, raw-image telemetry, private clipboard cache or persistent content history. Account and bound live grants/references globally as well as per conversation; a slow or disconnected reader cannot pin unlimited captures. Evict only data no longer needed by an admitted operation, expire old read references honestly, or refuse new work rather than corrupt a referenced capture. Keep a small in-memory byte-accounted cache, including encoded and decoded representations.
- On lock screen, ownership changes, unqualified dialogs, source/ABI mismatch or revoked conversation, stop new relevant subscriptions and mark content unavailable/stale. Previously delivered content cannot be made unread by revocation.

### Visibility is a capability, not an assumption

Track visible, occluded, minimized, workspace-not-shown and unknown presentation states separately. Several numbered workspaces on one monitor are not all visible at once. Do not switch workspaces, raise/move a window, unminimize it, or substitute a hidden desktop just to keep monitoring green. If the exact adapter supports an authorized background semantic read, label that result and its limits; it is not pixel or visible-effect evidence. Otherwise report unavailable/stale. An explicit presentation request is a separate policy-checked operation, not a hidden side effect of polling. Phase 1 pins exact selected windows; following new windows or app navigation must not silently widen the original grant.

### Geometry and target changes

DPI/scale/rotation, negative output origins, monitor mirroring, unplug/replug, workspace movement, scrolling, navigation, window replacement and process/PID reuse invalidate the applicable bindings or observations. Rebind from native identity, never retarget to a window that happens to occupy the old coordinates. A new modal/dialog requires an independently verified relationship and permitted scope; a root-window image does not prove its contents or input state.

## 6. Scheduling and execution branches

### Conservative first policy

1. Reasoning and approved read observations may overlap subject to capture/resource limits.
2. A shared document/window has one write transaction owner. The critical section covers observe/revalidate, action, settle and verification, not just one click.
3. Raw keyboard/pointer/focus and shared clipboard resources are serialized at the actual shared seat/device scope. Multiple monitors/workspaces do not waive this.
4. Target-directed semantic actions may use narrower resources only after the adapter and exact application route prove no shared input/focus/clipboard dependency. Unknown routes take the conservative resource set or refuse.
5. Desktop-wide operations and topology-changing actions take exclusive device scope. Extra input seats are disabled initially and require their own qualification matrix.

### Admission and acquisition

The broker derives `ResourceKey` values from trusted bindings/capabilities. A model cannot evade a conflict by naming the same document twice. Conflict matching is hierarchical: a device-exclusive key conflicts with its child resources, an app-instance key with its windows/documents, and a shared-seat key with every action using that input route. Plain string inequality is not independence. Shared application/profile/account state may require a broader lock even across distinct windows; do not inspect or copy credentials to invent a narrower identity. Resolve all known resources before dispatch and acquire them all-or-none in a stable global order. Queue without holding a partial resource set. No hold-and-wait upgrades: newly discovered resources require release and fresh admission before an effect, or quarantine if an effect is already in flight.

Run model reasoning and human approval outside the input critical section. Plans reference observations but do not reserve input while waiting for a model/network response. At reservation, revalidate the plan against fresh target preconditions; if a new decision is required before dispatch, safely release and re-observe rather than hold the UI hostage.

Use bounded per-conversation queues and fair scheduling. Human takeover and explicit stop outrank queued automation; fairness prevents one busy conversation starving another, but never preempts an in-flight input operation as if it were safely complete. Long downloads and builds can become wait states when their actual input is quiescent; do not hold a keyboard lease for an entire asynchronous job unnecessarily.

### Transaction state machine

```text
planned -> waiting -> reserved -> revalidated -> dispatching
        -> settling -> verifying -> confirmed
Any pre-dispatch refusal -> refused, with no side effect
Possible delivery or lost acknowledgement -> uncertain -> reconcile
Revocation during input -> cancel_pending -> draining
No quiescence proof -> quarantined, not reassigned by TTL
```

Before the final consumer emits input, recheck caller/grant/consent epoch, target and geometry, resource fencing, relevant observation preconditions and adapter capability. A broker-only fencing token is insufficient if a queued stale plugin command can still execute. P0 must identify the exact last side-effecting consumer and the protocol/cohort change required to fence it.

Request IDs bind caller, target and intent digest. Same ID with a different payload refuses. A duplicate may return the previous outcome, clearly labeled historical, not a new observation or repeated effect. Never automatically replay uncertain typing, paste, click, send, save, submit, deletion or payment. Persistence records only the minimal safe dispatch/outcome metadata, not typed secrets, frame content, clipboard data or authority tokens. Do not publish content-derived hashes of short secrets; intent comparison stays private, with appropriate keyed binding when sensitive input is involved. Recovery records identify unresolved work, never reconstruct authority or replay payloads. Bound journal entries and total bytes; never evict an unresolved safety marker to admit another side effect. After broker restart, use a new epoch and refuse/reconcile unresolved prior actions rather than reclaiming them as fresh work.

## 7. Stop, takeover, failure and recovery

- Conversation off invalidates the relevant grants before the next admission, drops queued actions and stops new scoped observation delivery. It does not stop another conversation or kill an application. A separately authorized owner-wide stop is distinct.
- Pausing during a drag, pressed modifier, IME composition or native async command is not instant rollback. Release/reconcile only input proven owned by that transaction; never issue a global mouse-up/key release that may belong to the human. If reconciliation is unavailable, quarantine the conflicting resource and report uncertainty.
- Prefer existing no-focus-steal/no-pointer-warp routes. Do not implement unconditional focus/pointer restoration: a later human change wins. Any future foreground fallback needs its own qualified contract and explicit owner-preservation evidence, not this plan.
- Use the ordinary shared clipboard and PRIMARY selection. A lock coordinates Orbit writers only, not the human or OS clients. Detect intervening changes and refuse stale paste; do not silently restore old clipboard data, create a private replacement, or claim pause revokes ordinary clipboard access.
- Adapter/transport failure, compositor restart or host crash invalidates appropriate epochs. A disconnected host cannot keep renewing authority. Known-quiescent work may release; uncertain in-flight work remains quarantined. Never restart a shared broker/compositor or kill original apps to recover capacity.
- Recover by fresh bounded read-back and owner-visible reconciliation. Do not call rollback an undo of a sent message, saved file or external transaction. Feature disable stops admission/subscriptions and drains known-safe work, preserving unresolved markers and original applications.

Input quiescence, application-effect verification and observation freshness are separate facts. A qualified future optimization may release a proven-drained keyboard resource while retaining a document/effect barrier for a long save/build; it must not release an uncertain shared resource or silently weaken dependent verification. Initial implementation may conservatively wait rather than claim this optimization.

The [safety specification](multi-view-safety.md) is the detailed branch/negative-test contract. Where implementation cannot satisfy an invariant, keep that capability disabled rather than weakening the invariant.

## 8. Host UI and multi-agent branch

One conversation can show cards for approved views with target label, device/workspace, observation age/completeness, owner, read/control scope, task dependency, working/waiting/blocked/uncertain state and explicit pause/off/takeover controls. Explain why a writer is waiting rather than drawing misleading simultaneous cursors. Indicators must not intercept normal application input or imply delivery without verified effects.

Keep authority and state in the broker; the UI displays it, not an optimistic model narrative. Distinguish stop requested, admission revoked, draining and verified paused. Do not show stopped merely because the button was clicked or a host request timed out; input accepted before revocation may still need endpoint reconciliation. Cards can exist in the native Orbit panel or a separately authorized host adapter. This does not authorize editing the DSH GUI, replacing its server, or coupling Orbit to one AI provider. A host plugin should subscribe to a versioned bounded event interface and re-query on reconnect or sequence gaps.

The optional host supervisor constructs a bounded acyclic task graph: independent reads may run together; dependent edits wait for verified inputs. Reader/reviewer roles initially receive no mutation grant. A delegation is canceled when its parent grant is revoked. Partial failure must not make the host reinterpret an uncertain worker as a success or silently assign its non-idempotent action to another worker.

Do not allocate a model to every screen by default. Phase 1 works with one existing agent and two views. Later delegation is explicit and budgeted. Host provider/model routing and billing remain host responsibilities; Orbit can cap its own work and expose content-free counts but cannot enforce limits on unrelated host agents.

## 9. Resources, privacy and initial limits

All values below are conservative PROPOSED starting parameters, not measured capacity claims. P0 validates compatibility with existing limits; use the stricter existing bound. No limit may be raised automatically to obtain a successful demo.

| Parameter | Initial design |
| --- | --- |
| Feature default | Off, no new background subscriptions/models/workers |
| Approved active views per conversation/device | 2 / 8 |
| Active feature conversations per device | 4 |
| Additional model workers in initial phase | 0 |
| Dispatched writers per shared input resource | 1 |
| Capture operations in flight per device | 1 |
| Queued action metadata per conversation/device | 8 / 32, with finite deadline |
| Recovery metadata journal | At most 1024 entries and 1 MiB per device; refuse unsafe dispatch when full |
| Unconsumed observations per view | 1 latest value |
| Observation memory per view/device | At most 16 MiB / 32 MiB, and any stricter existing payload cap |
| Automatic retries of possibly delivered effects | 0 |
| Extra seats/cross-device execution | Disabled, separate future qualification |
| Raw capture/text/clipboard telemetry retention | None by default |

Apply current resource preflight and helper budgets without moving owner applications into killable test scopes. Reserve capacity before new captures/models; reduce read frequency, coalesce or refuse new work on pressure. Do not stop owner processes. Account for base64, decoded pixels, accessibility trees, model context and worker/queue overhead rather than frame counts alone. Bounded operations need confirmed termination/drain semantics; a client timeout alone does not make a slot safe to reuse.

Captured/OCR/accessibility content is untrusted data and may contain prompt injection or secrets. Render safely, minimize capture scope, segregate authorized views, redact public diagnostics and never let observed instructions request new permissions or export unrelated windows. Persistent crash/recovery metadata must not store screen text or credentials. Preserve existing shared clipboard semantics without claiming a security sandbox or revocation of prior data.

## 10. Implementation phases and dependency gates

Use `main` only when future work is explicitly requested. No branch/worktree creation or runtime work is authorized by this plan. The JSON work items are the execution checklist; each change must be small, independently reviewable and source-grounded. A work item contributes evidence to a phase gate; it does not need later dependent work to be complete before its own deliverables can finish. Declared phase-closer items collect and review the whole gate. Gate results are explicitly scoped to phase, capability and tests: read-only acceptance is not writer acceptance or full-release acceptance. No capability is enabled merely because one contributing task is marked complete.

| Phase | Deliverable and boundary | Exit gate |
| --- | --- | --- |
| P0: inventory and specification freeze | Current caller/adapter map, last input consumer, cancellation/quiescence proof, numeric caps, current original-app acceptance defects | MV-GATE-00; no implementation using assumed safety |
| P1: two-view read-only | Stable bindings, bounded observations, epochs, minimal status UI, no extra models or mutation | MV-GATE-01 and applicable safety tests |
| P2: one coordinated writer | Global compatibility coverage, atomic resource scheduling, consumer fencing, cancel/drain/recovery and effect read-back | MV-GATE-02; no stale action after revocation/fence |
| P3: delegated readers/reviewers | Host-agnostic attenuated grants, bounded task DAG, visible roles and no automatic action reassignment | MV-GATE-03; cross-caller and scope-leak negatives |
| P4: qualification and opt-in rollout | Real owned-window workflows, resource/performance comparisons, feature-off parity and rollback drill | MV-GATE-04, documented support matrix |
| R1: independent seats, optional | Exact adapter/compositor/app/build/input-method qualification, not inferred from a competitor | MV-GATE-R1; remain off if not qualified |
| R2: multiple devices, optional | Separate explicit device enrollment/authentication, per-device authority, dependency/failure model | MV-GATE-R2; no implicit remote-control or two-device atomicity claim |

Do not delay safe P1 value until R1/R2 exist. No Windows/macOS original-app control milestone may pass based on discovery, managed GUI compilation, Linux tests or foreign project support. The existing Windows health blocker and owner-operated issue workflow stay separate prerequisites.

## 11. Acceptance and measurement

### Functional and safety gates

- **MV-GATE-00:** audit every relevant broker/native input and legacy route; identify trusted caller, real resource scope, final dispatch consumer and adapter cancellation/drain behavior. Freeze schema negotiation, finite limits and the initial qualified Linux/app matrix. Unknowns are blocking questions, not accepted capabilities.
- **MV-GATE-01:** two approved views can be observed with identities, timestamps, complete/partial labels and bounded cache/queue. No focus/pointer change, extra view access, hidden workspace, unapproved capture or new worker when off. Monitor/topology/window replacement and navigation invalidate the right data.
- **MV-GATE-02:** all relevant old and new action paths are coordinated. Deterministic adversarial tests inject revocation, stale fences, process/window reuse, clipboard/human changes, lock-order races, timeouts, partial delivery, reconnect and crash. Zero wrong-target actions, authority escalation or automatic replay of uncertain effects is required. Unknown drain blocks conflicting dispatch.
- **MV-GATE-03:** forged/cross-caller/replayed grants and model-provided resource IDs refuse. A reader cannot mutate. Cancellation reaches descendants; independent failures do not trigger duplicate send/save/submit. Sequence gaps and stale UI cannot grant permission.
- **MV-GATE-04:** original-app effects, owner preservation, bounded resources and feature-off compatibility are measured on exact versions. Publish only the verified capability subset with reproducible evidence and known failures.
- **MV-GATE-R1:** each independent-seat route separately proves event delivery, effect, focus/pointer preservation, clipboard behavior, IME/modifiers/drag/dialog limits and ABI lifecycle. Unsupported classes remain refused or on the existing coordinated route, never silently switched to a focus-stealing route.
- **MV-GATE-R2:** authenticated device identity, disconnect fencing, duplicate/reordered messages, partial failure and explicit owner scope pass. Each device verifies its own effects; global task completion requires all declared dependencies, not a transport acknowledgement.

### Measurement design, not results

Compare equivalent information and completed tasks, not unequal screenshots or command counts. Use one-agent/one-view, one-agent/two-view and optional delegated-reader variants. Record cold and warm runs separately, beginning with a minimum planned 20 paired samples per selected scenario as a pilot, not proof of a stable p95 or a small percentage gain. Counterbalance the order, use the same exact app/build/data/geometry and budget, and reset only owned fixtures. Expand sample size using a predeclared precision/confidence rule before a release decision on tail latency or small regressions; report uncertainty and inconclusive results rather than passing from noisy point estimates. Include observation-only, producer/consumer and conflicting shared-document families. Report successful completed-task time, median and tail latency, failures/uncertain outcomes, capture/text bytes, model calls/tokens, memory/CPU peaks, queue waits, fairness and owner focus/pointer events. Count verification cost and failed runs.

Before measurements, declare a task-specific regression budget. Provisional design targets are no extra background work when disabled, no new safety violations, and at most 5 percent median / 10 percent p95 latency regression for unchanged single-view operation in the active compatibility path. These are proposed acceptance thresholds, not observed results or a universal promise. An unsuitable task stays single-agent; a regression fails rollout or narrows the opt-in capability. Report worst, typical and best cases without an invented 80 percent efficiency claim.

Test layers: pure schedulers/state machines and fake-clock fault injection first; protocol/legacy compatibility and resource accounting next; actual prepared adapters and exact original applications last. Owned fixtures do not establish real input effects. No live desktop acceptance is performed as part of writing this plan.

## 12. Rollout and rollback

Feature-off must preserve current behavior, payload meanings and ordinary input/clipboard policy. Version negotiation must reject unsupported fields/capabilities; do not silently downgrade a fenced operation to an unfenced old consumer. Where fencing needs a native protocol change, stage a verified compatible cohort and refuse mixed versions. Never restart a shared broker while active work exists.

Start with an explicit two-view read-only opt-in on qualified Linux routes. Add one coordinated writer only after its gates pass, then optional reader delegation. Status UI must disclose unsupported routes and uncertain outcomes. Rollback disables new admission, unsubscribes/drains bounded work, retains unresolved safety markers and original apps, and returns to the verified single-view path only after quiescence. It cannot erase real application effects or clear a safety barrier merely to make rollback green.

## 13. Required decisions before future code starts

1. The current-state audit must classify existing locking and cancellation as verified code behavior, a tested guarantee, or an unverified adapter assumption. Do not infer UI safety from process/cgroup ownership.
2. Choose the precise prepared Linux/app/build matrix and demonstrate stable single-view effect/settled capture before expanding it. Existing failing acceptance is not repaired by adding workers.
3. Freeze the last-consumer fencing/cohort protocol and migration coverage for every old and new action route. If a route cannot fence or drain, keep it outside the feature.
4. Decide which document-sharing identities are trustworthy. Until then use conservative app/device resources.
5. Freeze actual numeric observation/frame/request limits and host budget integration against measured current behavior; do not change legacy limits accidentally.
6. Select the first host UI adapter and owner consent/takeover flow without adding an LLM engine or changing DSH runtime infrastructure under an Orbit task.
7. Review licenses and exact source provenance separately before porting any implementation. Conceptual similarity is not permission to copy code.

The plan is complete as a gated work specification, not a claim that these empirical questions are already resolved. A failed gate produces a measured issue and a scoped repair or disabled capability, not a safety exception.
