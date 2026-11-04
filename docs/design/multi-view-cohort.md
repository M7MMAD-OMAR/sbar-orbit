# Initial P0 read-only cohort decisions

Status: **design freeze proposal for the first read-only cohort, not runtime support or a gate pass**. Recorded 4 November 2026. This document contributes decisions to MV-00; it does not mark MV-00, MV-GATE-00 or MV-GATE-01 complete. The initial drafting task performed no native readiness check, OS interaction, test or build. The Lead subsequently reviewed the scope and added links to separately recorded owned native acceptance; those links do not turn design decisions into runtime grants.

Read together with the [plan](<multi-view-plan.md>), [exact ingress inventory](<multi-view-ingress.md>) and [implementation ledger](<multi-view-implementation.md>). Those distinguish repaired source, owned-fixture evidence and unknown native behavior. Where an implementation is still missing below, admission remains unavailable, not implicitly authorized by this design.

## 1. Scope decisions

| Decision | Frozen initial boundary |
| --- | --- |
| Cohort design identifier | mv-readonly-v1. This is a design identifier, not an existing advertised capability, RPC method or accepted request field |
| Useful operation | One owner-enrolled conversation observes exactly two explicitly selected original native views on one local Linux device. One existing host agent reasons about independent observations |
| Input authority | Zero new writer grants, input actions, clipboard reads/writes, navigation, scrolling, window mutation, opening or presentation under this grant |
| Platform | Original Wayland XDG application surfaces through the prepared Hyprland adapter with exact current source/build/ABI agreement. No XWayland, X11-only session, other compositor, Windows/macOS control, remote device or extra seat |
| Initial application candidates | Calculator is the first single-view candidate. A second view must be independently and explicitly selected from an original installed registration and separately qualified, whether a retained Calculator sibling or another approved app. No implicit substitution or second lease for the same client. The initial cohort stays unavailable until both exact bindings and lifetimes qualify |
| Registration and setup | Owner selects exact installed registration, existing window identity and visible numbered workspace. Existing lifecycle/handoff operations have their own authorization and effects; read-only enrollment cannot open, move, present, claim or resume an application as a hidden convenience |
| Capture semantics | Explicit target and explicit permitted formats. Text permission does not permit pixels. Both means separately obtained tree and image, not an atomic application snapshot. Cached presence is metadata, not new content evidence |
| Host role | Host supplies planning and optional future delegation. No generic LLM/provider engine, automatic extra model or implicit DSH teammate authorization in the broker |
| Rollout | Default off. No timer, capture queue, subscription, helper or model is created solely by installing/upgrading. Enabling requires all read-cohort prerequisites below and explicit owner enrollment |

This narrows the broader [future phase plan](<multi-view-plan.md#L202-L227>), not the existing original-application permission policy. Browser and terminal registrations remain supported by ordinary Orbit routes; they are simply not qualified by this initial explicitly qualified candidate matrix. Owner browser/profile access still needs the owner's explicit request. Existing independent single-view actions are not newly granted by a read card.

## 2. Authority source, not a conversation-label capability

**Existing source:** [caller attribution:70-107](<../../src/caller.ts#L70-L107>) accepts a process claim with liveness/start/same-user checks and derives conv: or proc: identity. A host/conversation string and verified:true do not prove owner enrollment. [Owner credential:109-135](<../../src/caller.ts#L109-L135>) and [IPC owner resolution:47-52](<../../src/ipc.ts#L47-L52>) are the current owner control seam. [CallerRegistry:28-59](<../../src/caller-registry.ts#L28-L59>) tracks adapter process instances; it is not a read grant registry.

**Frozen future authority design:**

1. An owner-authenticated local control surface enrolls an exact connector installation and running instance. The broker stores a private enrollment record binding its own instance epoch, connector instance identity/process birth evidence, host-provided conversation identity, owner consent generation, permitted recipient and exactly selected native bindings. An agent cannot enroll itself by adding JSON role, host, conversation or task labels.
2. The owner operation uses the existing owner-authenticated channel or a separately reviewed equivalent. The owner credential is never handed to an agent/connector as its everyday read token. The protected connector enrollment mapping, rather than a self-chosen ORBIT_CONVERSATION_ID, is the authority source. Same-user cooperative scope remains explicit; this is not a sandbox against malicious same-UID processes.
3. A read grant is a broker-issued unpredictable opaque 32-byte handle bound to that enrolled channel/instance, exact view subset, permitted formats, consent epoch and broker epoch. It is not a reusable bearer credential for another connector or conversation. Model-visible view/status references do not expose the authority secret. Logs contain only non-authorizing correlations, no handles or captured content.
4. Initial enrollment lasts at most 10 minutes. Renewal requires the owner-approved enrollment policy still in force and the same live instance; it never widens scope. Connector restart, changed process birth identity, broker/adapter restart, lost enrollment, conversation off, consent narrowing or replaced native binding invalidates the relevant grant. Reconnection does not reconstruct authority from an old conversation label. Expiry stops new reads/delivery, not proof of capture-helper termination.
5. Check owner enrollment, format scope, consent/binding epochs and recipient at queue admission, before native capture, and before delivery. Off/narrowing drops pending observations and suppresses delivery of accepted-but-not-yet-delivered data. Previously delivered data cannot be made unread. The existing adapter-local usage switch is not substituted for this future broker-owned revocation state.
6. Exactly one client lease remains authoritative for a Wayland client. Two views never split/take over another caller's lease. Existing qualified ownership may be reused only with explicit read authorization. A new sibling, portal, popup, replacement address/PID or discovered title does not inherit the view grant. No retained accessibility reference becomes action authority.

**Missing implementation:** enrolled connector/channel identity, owner enrollment UI/storage, opaque grant validation, broker-side consent epochs and revocation/delivery enforcement. Until implemented and negatively tested, the internal passive method is a prerequisite seam only, not this grant protocol.

## 3. Concrete consumer compatibility and downgrade refusal

The currently implemented operation spelling is **observationMode: passive-v1**, observe-only. [NativeBackend.observePassive:429-455](<../../src/hyprland.ts#L429-L455>) requires an explicit owned target, integer worker budget 100 to 3000 ms, default 1500 ms, and a successful response with observation.mode equal to passive-v1, observation.cursorRefresh equal to omitted and inline windows metadata. [Worker observation metrics:568-598](<../../src/native/session.py#L568-L598>) retain the existing format/cost/completeness fields and add only those two passive acknowledgements.

Read-cohort compatibility is **per operation**, not inferred from a package version, an earlier successful frame, source hash alone or the fact that the plugin is loaded:

- Broker/adapter must select this exact internal passive route, never ordinary observe, legacy cursor refresh, cached selected target or a windows fallback request. [Backend refusal and no-commit response:448-504](<../../src/hyprland.ts#L448-L504>) rejects old/missing acknowledgement without retrying in legacy mode, rejects passive text-to-image substitution, and exports only the observed target's presence.
- Python must validate the literal before admission, omit cursor refresh for image/text/both/digest/settle/resampling, use detached current geometry, avoid sibling enrollment/writer metadata commits and refuse geometry changes during a passive tree query even when accessibility is unavailable. [Detached target:248-264](<../../src/native/session.py#L248-L264>), [tree/capture:435-508](<../../src/native/session.py#L435-L508>) and [noncommitting enumeration:233-275](<../../src/native/existing.py#L233-L275>) are the current source seams.
- Mixed consumers fail closed: an old worker can refuse the unknown field; a worker returning a legacy/malformed acknowledgement is unsupported for this read. No automatic restart, plugin reload, fallback pixels, additional capture or implicit repair action is permitted by a read grant. A later explicit read requires a fresh authorized request, not replay of a possibly effectful old route.
- Pin broker, TS adapter/worker, Python source and capture/accessibility helper versions in qualification evidence. Verify the plugin source stamp and running compositor ABI through existing readiness outside capture admission. The plugin has no mv-readonly-v1 grant/fence protocol today. The narrow passive omission does not pretend otherwise.
- Per-operation omission acknowledgement is **not** a claim that unrelated native callbacks stopped, overlays disappeared, owner input was blocked, content remained semantically unchanged, or image/tree captures were atomic. Existing client lease acquisition/resume/selection broadcasts can have effects; observation authority does not grant those setup actions.

The [ingress inventory's delayed callback map](<multi-view-ingress.md#L25-L42>) remains relevant for any future writer. A later writer cohort requires a different negotiation and endpoint fencing, including keyboard preparation, pumpSend, silent click callbacks, flushPump and owned releases. It cannot reuse a read grant or declare the current omission acknowledgement a quiescence receipt.

## 4. Existing hard bounds and stricter feature limits

These are different resource domains. Existing hard limits do not establish a global capture scheduler, memory reservation or host model budget. The future cohort uses the stricter applicable bound and refuses rather than raising limits for a demonstration.

| Existing source bound | Actual value and seam | Consequence for the proposed cohort |
| --- | --- | --- |
| Broker request body | 65536 bytes, [IPC:35-36](<../../src/ipc.ts#L35-L36>) | Feature descriptors must fit this; no embedded frames in requests |
| Worker request and queue | 65536-byte framed request, at most 128 queued per worker; deadline starts after queue wait, [worker:220-235](<../../src/native-worker.ts#L220-L235>) | Existing 128 is not the feature queue allowance or end-to-end deadline |
| Worker reply frame | At most 24 MiB serialized reply, [worker:157-174](<../../src/native-worker.ts#L157-L174>) | Base64/JSON overhead counts. A raw 16 MiB capture cannot be treated as 16 MiB total live memory |
| Pixel helper output | At most 16 MiB PNG or 64 MiB PPM raster, stderr 65536 bytes; each dimension 1 to 16384, [capture:135-179](<../../src/native/session.py#L135-L179>) | Existing raster scratch ceiling exceeds the entire proposed device observation budget; do not assume this path is feature-budget-safe |
| Capture work/cleanup | Legacy helper default 10 seconds; bounded passive worker budget 100 to 3000 ms; child kill/reap cleanup up to 3 seconds, [capture:135-194](<../../src/native/session.py#L135-L194>), [options:318-335](<../../src/native/session.py#L318-L335>) | Queue wait, work deadline and cleanup/drain have distinct accounting. Slot not reusable solely because a client deadline expired |
| Tree content | At most 300 retained nodes and 16000 serialized node bytes; default query budget 1500 ms, [a11y:9-35](<../../src/native/a11y.py#L9-L35>) | Envelope, provider process and traversal scratch also count; node cap is not total helper-memory proof |
| Worker reply cache | At most one retained image; older image replay expires, [cache:18-48](<../../src/native/session_worker.py#L18-L48>) | Feature cache must account for this additional retained representation, not duplicate it without reservation |

**Frozen stricter cohort parameters, proposed and not implemented:**

| Parameter | Initial read-only decision |
| --- | --- |
| Views / conversations | Exactly up to 2 selected views per conversation; at most 8/device and 4 enrolled active conversations/device |
| Capture concurrency | 1 capture operation/device, including cleanup occupancy. Two-view reasoning may be parallel, capture acquisition is not |
| Read queue | At most 2 pending descriptors/conversation and 8/device, one pending descriptor/view, 5-second maximum queue wait. Coalesce superseded pending reads; no frame payload in queue |
| Worker work budget | 1500 ms default, integer 100 to 3000 ms; no resetting deadline for geometry retries or tree-to-image work |
| Automatic capture polling | Off by default. If explicitly enrolled, at most one request/view every 2 seconds, finite 10-minute enrollment; pressure coalesces/slows/refuses rather than increasing rate |
| Observation retention | One latest unconsumed observation/view; no persistent raw image/text/clipboard history. Captured content remains recipient-scoped |
| Live observation memory | 16 MiB/view, 32 MiB/device total across raw/encoded/decoded frames, trees, retained replies, referenced data and capture scratch; not separate additive allowances. Reserve before spawning; discard only unreferenced data or refuse |
| Initial physical pixel envelope | At most 1280 by 960 pixels/frame, within actual target geometry. This is a proposed admission bound, not permission to resize/crop the owner window to fit. Larger or unbounded scratch capture refuses; authorized text may be requested separately, never substituted silently |
| Writers, extra models, seats, devices | 0 feature writers, 0 extra model workers, 0 extra seats, 0 remote devices. Future action queue 8/conversation and 32/device from the wider plan is not enabled by this read cohort |
| Uncertain-effect retries | 0. No automatic legacy input/cursor/setup replay. Read resampling remains bounded to the same target/deadline and is not input replay |
| Recovery metadata | At most 1024 entries and 1 MiB/device, metadata only; preserve unresolved safety markers. No typed text, frame data, clipboard bytes or authority secrets |

**Admission blocker:** current capture helper caps and generic worker queue alone cannot enforce the proposed device memory, scratch/pixel envelope, fair queue wait or occupied-slot lifecycle. Implement reservations and helper-bound enforcement before enabling subscription or concurrent two-view observation. Never capture a 64 MiB temporary raster and then claim the 32 MiB device budget was obeyed because the final PNG was small. Refuse unqualified target scale/size rather than downsampling after unbounded allocation. Existing stricter accessibility/payload caps remain in force.

These decisions specialize the broader [plan limits](<multi-view-plan.md#L178-L198>). None is a throughput or capacity measurement. Owner applications must not be moved into killable test scopes or terminated to free resources.

## 5. Cancellation, legacy activity and lifecycle exclusions

A read grant cannot invoke key/button/motion/scroll/drag, clipboard, close, release, flush, resume, presentation or native maintenance to make its own observation look stable. The original route's cursor-refresh-to-flush path remains effectful. The passive route avoids that command; it does not cancel an already accepted compositor operation.

Unknown input drain is **excluded from the read grant's claims**, not silently solved or waived. If enrollment/setup or capture depends on handing over/reusing a client/resource with uncertain input, decline that enrollment/read until separately qualified reconciliation establishes an acceptable boundary. Do not claim pause, process death, empty pump map, broker queue completion or TTL expiry is a transaction receipt. Do not quarantine or stop an unrelated owner's task just to manufacture a read-ready state.

Read cancellation must separately prove its owned capture/accessibility helpers stopped or keep its capture/memory reservation occupied. On off/revocation, stop new read admission and delivery immediately, then drain owned readers only; already delivered content is not revoked. Existing worker timeout cleanup and HTTP abort are insufficient evidence of this future broker-wide reservation contract. Restart invalidates grants/bindings, does not convert unresolved effects into replay permission. Full writer revocation/drain and delayed endpoint fencing remain required for P2 and the full phase gate.

## 6. Initial exact qualification matrix

The cohort remains **unqualified**. The subsequent [owned Calculator run](../multi-view-native-acceptance-2026-11-04.md) records narrow passive-operation evidence and exact versions, not a full row/gate pass. In particular, setup pointer preservation and the proposed physical pixel envelope remain limited. Missing evidence below is not fabricated from package versions or acknowledgements.

| Candidate capability | Exact evidence required before marking qualified | Current conclusion |
| --- | --- | --- |
| Linux Hyprland Wayland prerequisite | OS/distribution/architecture, compositor version+commit+ABI, exact installed adapter/Python/TS source cohort, plugin source and binary hashes, loaded plugin identity, host plan and compositor instance, relevant configuration | Readiness, exact ABI/source/binary hashes and packages recorded in the dated run; no reload. This is not the missing read-grant/admission implementation |
| Calculator single owned window | Exact installed registration/launcher and app package version, native app/client PID birth identity, address+stable ID, explicit visible workspace/output, dimensions/scale, normal owner state, request/receipt lineage | Candidate only. Earlier [single-view ledger limitation](<multi-view-implementation.md#L157-L162>) records capture failure and unestablished pointer preservation; source fixtures do not turn it into a pass |
| Passive image on Calculator | Exact per-operation omission acknowledgement, target-correct complete pixels, timestamp/dimensions, known visibility, no focus/physical pointer/workspace changes attributable to the read; no setup/input hidden in read | 44 passive observations include target-correct, visually inspected images with read-bracket preservation. Post-arithmetic heights 961/962 exceed proposed960; image-cohort admission still unqualified |
| Passive text on Calculator | Exact provider/toolkit identity and original target bind; correct tree or explicit unavailable/incomplete result; no pixel fallback; stable geometry checked around query | Actual text was complete (36 then40 nodes); result3 verified. Native unavailable/provider-failure negatives remain fixture-only; no semantic action authority |
| Two explicitly selected original views | Distinct exact selected windows, real shared/separate client scope, no second lease for same client, owner-authorized bindings, per-view timestamps/skew, bounded serial capture and recipient isolation | Pending. Single-instance behavior or absent second suitable view leaves cohort unavailable |
| Other apps, dialogs, browser/profile, IME, XWayland, other OS, extra seats/remote | Separate explicit candidate decision plus exact adapter/application acceptance | Not qualified by this cohort; no inferred parity or category prohibition |

### Native single-view qualification checklist

Lead-owned acceptance must: confirm actual conversation usage without re-enabling off; inspect existing sessions and readiness without restarting shared services; bind the prepared/loaded exact plugin and compositor instance; select only an exact newly created or explicitly owner-selected original window on a visible numbered workspace; record focus, physical pointer, workspace/output and relevant unsaved state before/after; record actual app state and returned capture, not just command success; exercise passive image/text outcomes and unavailable/geometry-change negatives without broadening capture; separate legacy setup/input effects from the passive operation; preserve unrelated work and shared clipboard; close only the owned test window normally and stop only the owned session. An ended lease is not proof the window closed.

Record protocol result, observable app effect, owner preservation, capture completeness, cleanup and uncertainty as separate columns. A failed capture, changed focus/pointer, unknown output visibility or missing exact app version limits the corresponding row; do not average it into success. This checklist is not permission for this documentation task to perform native actions.

## 7. Remaining gate blockers

- Owner-issued connector/channel enrollment and broker grant/revocation enforcement do not yet exist.
- New broker view registry, immutable bounded observations, binding/topology/recipient epochs and loss/reconnect behavior remain unfinished.
- Current passive omission fixtures establish source behavior only; exact native app/build/visibility/preservation matrix remains pending Lead evidence.
- Global read reservation, memory/scratch enforcement, finite queue-wait admission, privacy-safe retention and owned-reader cancellation/drain remain unfinished.
- Legacy effectful ingress and direct native consumers remain as inventoried. No coordinated writer, delayed endpoint fence, known input drain or durable uncertainty barrier is established by this design.

This is a concrete scoped decision record. It may be reviewed as an MV-00 contribution independently of later implementation, but no full phase gate or runtime capability passes by adopting its wording.
