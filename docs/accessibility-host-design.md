# Accessibility host: staged safety design

Current status, 6 November 2026: the owner froze this campaign and released 0.4.4.
Bounded public refs, skeleton/root traversal and guarded semantic dispatch now
exist with the scoped GTK, Qt and Thunderbird evidence in [the release record](release-0.4.4.md).
The remaining acceptance, platform adapters and comparative throughput program
are deferred. No 1.8x gain is established. The dated design and source milestones
below are historical stages, including statements that refs or semantic verbs
were disabled then; use [current status](completion-status.md) for shipped behavior.

Status: source implementation plus future safety design, 4 November 2026. The supervised **read-only warm helper** is implemented as an explicit `ORBIT_A11Y_WARM_HOST=1` opt-in. The default cold-process observation path is unchanged. No refs or semantic actions are exposed. Source implementation, installed activation and live acceptance are separate gates. The [execution plan](efficiency-plan.md), [pinned upstream review](research/agent-desktop.md) and [original application contract](desktop-only.md) remain applicable.

Initial review found `COMPOSITOR_NOT_RESTARTED`: installed Hyprland 0.57.1, running 0.57.0. Later the owner session was running 0.57.1; after confirming no active leases, an ABI-matched signed-header build and normal refresh restored `native-check` agreement. See the [readiness repair ledger](efficiency-plan.md#native-readiness-repair-not-application-acceptance). No shared broker/compositor restart or forced logout was used. Readiness alone does not establish application, identity or semantic safety acceptance.

## Stage A: warm read-only observation

One private helper per worker/session can amortize GI startup. Every request still independently validates the exact target and traverses the current accessibility tree. It does not retain actionable refs between requests, accept a ref argument, call mutation interfaces or expose arbitrary D-Bus addresses/commands. Warmth alone is neither a speed result nor stronger identity.

### Implemented source transport

- Lazy owned subprocess in [the trusted worker](../src/native/a11y_host_worker.py), supervised by [the transport](../src/native/a11y_host.py). Its fixed environment has only `PATH`, `LANG` and `XDG_RUNTIME_DIR`; private inherited socketpair, protocol version 1. No public listener, caller-selected executable, child spawning or desktop action API.
- Four-byte unsigned big-endian length followed by UTF-8 JSON. HELLO is `{ protocol: 1, generation, kind: "ready" }`; observe requests carry `protocol`, `generation`, `requestId`, `method` and `target`. Target contains `pid`, `title`, `maxNodes`, `budgetMs`, `deadlineNs`. Replies echo protocol/generation/request ID and carry `ok` with `result` or the fixed permitted error. Only observe is admitted. Target ownership is checked by the enclosing session, not an echoed lease proof in the helper reply. Raw provider exceptions are never forwarded.
- Serialize requests. Bound request frames to 64 KiB and response frames to 256 KiB. Enforce bounds incrementally before buffering, including split UTF-8 input. The response framing cap does not replace the existing 300-node/16000-byte exported-tree limits.
- One absolute monotonic deadline of at most 5 seconds spans startup, handshake, send and response. No automatic retry, deadline reset per chunk or unlimited blocked write. Cleanup has an additional reserve of at most 0.4 seconds: 0.1 seconds for TERM/wait and 0.3 seconds for KILL/wait. This is outside the 5-second observation deadline and within the outer worker budget.
- Timeout, EOF, malformed/oversized reply or wrong identity invalidates the helper generation, closes channel ends and terminates/kills/waits for the owned process. Signal delivery alone is not proof of reaping. A new helper never inherits an old generation.
- Child sets Linux `PDEATHSIG=SIGKILL`, checking the expected parent before and after setup to close the parent-death race. Parentage/thread assumptions must be explicit. The worker creates no descendants. Test worker death and supervisor death, including SIGKILL, not just ordinary close.
- Session constructor creates only the transport object when opted in; subprocess startup is lazy. Pause and close explicitly release the helper; resume recreates the transport and starts its process only on the next observation. The helper exits after 60 seconds idle. Its resource limits disable core dumps, cap soft address space at 512 MiB and open descriptors at 64, respecting stricter inherited limits. EOF and fatal worker errors must not leave an orphan. Transport cleanup signals its owned new process group; never include or kill the original application process.

### Cache freshness and bounded GLib work

The implemented lazy `ReadOnlyProvider` disables each visited proxy cache with `Cache.NONE`, calls `clear_cache_single`, and pumps at most 16 GLib iterations per slice under the request deadline. Child/property/text/defunct events mark an observation changed; observed change or process-start-generation mismatch discards it. These are best-effort freshness checks, not provider lifetime proof. The helper does not initialize AT-SPI for a handshake.

The following remain correctness requirements and limits, not claims of complete current enforcement. In particular, explicit provider unique-bus-owner generation binding and lossless provider event/lifetime proof are not implemented by the read-only wire:

1. Reacquire application and uniquely exact full-title frame each request, corroborating compositor lease/window identity, process generation and provider unique bus owner. Do not reuse yesterday's selected frame because a local proxy still exists. Missing/duplicate/unreadable candidates fail closed; capture is the existing observation fallback.
2. Disable accessibility caching with the supported cache-none setting and explicitly clear already-populated caches before traversal. Changing a cache mask does not prove prior entries disappeared. Root discovery itself may populate caches. Verify installed libatspi recursive-clear and mask inheritance behavior; when not established, clear each proxy immediately before reads and bound the work.
3. Pump the owning GLib main context before selection/publication, between requests and at bounded walk steps. Limit event count/time per slice; an endless `while pending()` loop can starve the deadline under an event flood. Serialize provider access on its owning context.
4. Watch provider/root loss and observed mutation generations. If the target changes during traversal, discard/reobserve only within the original deadline or return explicit unstable/partial status. Unknown properties are not absent properties. Do not call mixed-generation output a transactional snapshot.
5. A synchronous hung D-Bus call prevents that thread from pumping events. The parent deadline and process kill/reap path remain mandatory; periodic deadline checks alone cannot interrupt it.

Cache clearing does not prove freshness inside the remote toolkit, event delivery, accurate bounds or native-object survival. `complete` means completion of the bounded filtered traversal, not complete application content or an identity guarantee. Provider events may be delayed or lost. Keep screenshots and trees private; password-role redaction does not sanitize a screenshot or all surrounding text.

## Stage B: retained refs, still no mutation

A bounded registry primitive can retain actual Python/native objects, but registry unit tests cannot establish remote AT-SPI identity. Before refs become actionable:

- Keep a strong reference to the actual accessible object and frame root in one long-lived host. Never resolve a saved ref by index, position, role/name/bounds, repeated accessible ID or a fresh predicate search.
- Bind refs to broker session, random helper generation, compositor instance, lease, exact window stable identity, process boot/start generation and accessibility provider unique bus owner/generation. An opaque owner capability may encode these fields, but its meaning must be defined and validated, not assumed from its name.
- Invalidate on defunct/removal/reparent, ancestor/root loss, window/process/provider change, lease handback, event-stream failure and host restart. Invalidate descendants, not only the removed root. A failed or throwing validator invalidates the snapshot.
- Define snapshot/ref/total-object/memory/TTL limits with monotonic expiry and idle/event/request sweeping. JSON size does not bound provider/GObject memory; enforce process resource limits too. Publish a snapshot atomically only after complete retention and final target validation.
- Root drill-down replaces descendants atomically and preserves unrelated refs. An incomplete replacement must not destroy valid retained descendants. Foreign, expired, evicted and invalidated refs fail with typed errors; never silently rebuild them.

### Unresolved ABA limitation

Retaining a GObject proxy locally is **not** proof that the remote object survived. A provider can destroy an object and later reuse the same D-Bus object path under the same bus owner. If removal/defunct events are missed, a retained proxy may address the replacement. Re-reading role/name/bounds or checking uniqueness does not solve this ABA problem.

The [pinned upstream identity guidance](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/docs/solutions/best-practices/identity-fingerprint-against-os-reorder-2026-04-16.md) explicitly permits unique replacement aliasing on non-macOS. Orbit must not import that limitation while claiming original-object identity. Require provider-specific lifetime proof or reject mutation for unsupported lifetimes. Tests must remove and identically replace an object at the same bounds, reuse its remote path, drop events and change process/bus/window generations. GTK4/Qt6 live stale-ref evidence is additionally required for issue 24.

## Stage C: semantic mutation remains disabled

`ActionControl.execute` checks exact protected/full approval and journals intent/outcome. It is not a compositor pause or owner-input gate. Likewise `ghost-target-check` proves a point-in-time condition; a later D-Bus write can race pause, owner input, policy narrowing or target destruction.

Before enabling Action/EditableText/Value dispatch, design an external-operation admission protocol: single-use token bound to lease/window/helper generation, current authority epoch, action digest and deadline; explicit revocation, outstanding-operation accounting and drain acknowledgement. A permit alone cannot make an application's D-Bus execution atomic with compositor state. If required parity cannot be established, keep semantic writes disabled.

Required dispatch sequence:

1. Validate ref lifetime, retained frame/object and provider/process/window generations.
2. Re-evaluate current action class, narrow policy, protected/full approval and conversation-off state at dispatch, not only when queued. Semantic invoke/edit/value are mutations, never read-class shortcuts.
3. Verify prepared source/ABI, exact live plugin lease and owner-input admission; obtain the bounded authority token.
4. Show the agent ghost cursor using freshly read reliable bounds, without moving the physical pointer or owner focus. Missing trustworthy geometry needs a defined approved visible indicator or refusal, not an invented cursor position.
5. Recheck object and authority epoch immediately before exactly one semantic write. Then obtain identity-qualified state/capture evidence and close the permit. Do not synthesize pointer fallback after uncertain delivery.

Existing session request deduplication must cover the semantic action/ref/target/arguments. No helper retry or alternate mechanism may multiply the effect. Narrow/off/pause must reject queued work and drain outstanding work according to explicit acknowledged semantics. Existing adapter conversation-off checks are not helper cancellation.

### In-flight uncertainty cannot be revoked away

After a D-Bus request may have reached the application, timeout, helper termination or permit revocation cannot retract remote work. The application can execute it after the caller disappears. Report unknown/unsafe unless delivery evidence proves otherwise; observe rather than replay. Never acknowledge that all possible remote effects stopped merely because the helper was killed. The pause/off contract must state what was already dispatched and how uncertainty is reported. This issue and remote object ABA remain release gates, not implementation details presumed solved by a warm host.

## Actual integration map

These spans describe the reviewed baseline; later edits may shift line numbers. Follow runtime callers rather than treating experiments as unused: the Hyprland plugin is a production build input.

| Layer | Current integration point | Required extension |
| --- | --- | --- |
| MCP | [Session MCP entry](../src/session-mcp.ts#L18-L65), [conversation usage](../src/conversation-usage.ts#L48-L51) | Keep entry usage checks; future authority protocol must address queued/in-flight off. |
| Broker | [Deduplication](../src/session.ts#L323-L347), [admission](../src/session.ts#L352-L407), [queue](../src/session.ts#L310-L322), [guarded dispatch](../src/session.ts#L509-L514) | Preserve dedup; recheck current policy at semantic dispatch. |
| Policy lifecycle | [Pause](../src/session.ts#L576-L587), [narrow](../src/session.ts#L791-L811), [stop/forced close](../src/session.ts#L526-L574) | Define authority epochs/drain and helper cleanup; native origins remain unsupported. |
| Backend | [Parse/action](../src/hyprland.ts#L326-L381), [lease pause/resume](../src/hyprland.ts#L385-L386), [observe](../src/hyprland.ts#L406-L425) | Read-only integration first; no public semantic verbs yet. |
| Warm helper | [Host transport](../src/native/a11y_host.py), [trusted worker](../src/native/a11y_host_worker.py), [opt-in constructor](../src/native/existing.py#L48-L57) | Implemented read-only source opt-in; no exposed refs or mutations. Provider lifetime and authority gates remain future. |
| Process boundary | [Native worker create](../src/native-worker.ts#L95-L120), [request/close](../src/native-worker.ts#L215-L266), [worker dispatch](../src/native/session_worker.py#L79-L157) | Supervise warm helper, preserve framed identities and reap on fatal paths. |
| Lease lifecycle | [Claim/source verification](../src/native/existing.py#L163-L229), [owned windows](../src/native/existing.py#L231-L269), [execute/pause](../src/native/existing.py#L271-L295), [close](../src/native/existing.py#L307-L327) | Helper creation/validation/invalidation/close hooks belong to exact leased session. |
| Observation | [Tree acquisition](../src/native/session.py#L171-L182), [cold dumper](../src/native/a11y.py#L37-L58), [frame selection/traversal](../src/native/a11y_dump.py) | Replace cold read with optional bounded warm observe; retain honest image fallback. |
| Local authority | [ActionControl](../src/native/control.py#L108-L141), [transport](../src/native/transport.py#L64-L130), [host verification](../src/native/host.py#L122-L131) | Do not mistake approval journal for atomic external-write admission. |
| Compositor | [Target resolution](../experiments/ghost-cursor/plugin/ghostinput.cpp#L1644-L1723), [target check](../experiments/ghost-cursor/plugin/ghostinput.cpp#L2757-L2764) | Future external-operation permits must preserve exact lease, pause and owner-input behavior. |

Local approval journaling retains request/results. Future host action audit callbacks must return content-free receipts, not provider text/tree/value content; observation payloads remain private responses. Include every new helper module in packaging and source identity manifests before installed activation.

## Incremental exit gates

| Stage | Evidence required before proceeding |
| --- | --- |
| A1 transport fixtures | Trusted owned fixture: split frames/UTF-8, bad handshake/ID/generation, oversized/empty/invalid replies, blocked reads/writes, absolute deadline, no retries and fixed public errors. |
| A2 supervision/cache | Parent/worker SIGKILL leaves no helper; normal/idempotent close reaps. Fake-provider cache updates, owner loss, event floods and hung calls remain bounded; unknown/partial data is honest. |
| A3 read-only integration | Exact-title and target-change refusals, existing output caps/password filtering/metrics preserved, source/package/install identities verified separately. Measure cold/warm cost without asserting improvement in advance. |
| B retention | Registry bounds and atomicity plus provider lifetime/ABA evidence. No refs exposed as safely actionable on the strength of local-object tests alone. |
| C authority | Pause/off/narrow/revoke/owner-input races and delivered-but-unacknowledged outcomes covered, explicit remote in-flight limitation accepted, no bypass or duplicate effect. |
| D semantic acceptance | Original GTK4/Qt6 controls and intended Nautilus cell operated with visible effects/cursor, owner state preserved and exact cleanup. Only after native readiness is restored normally. |
| E drill-down | Complete atomic skeleton/root behavior and a live Thunderbird target row reached within caps. |

A documentation or fixture gate is not installed desktop acceptance. Keep Stage A independently reversible to the cold observation path; do not silently retry a mutation or restart shared infrastructure during rollback. The lead reports 12 worker/integration fixtures passing, including existing-session coverage; this documentation review ran no tests. The [worker fixtures](../tests/native_a11y_host_worker_test.py) use owned sockets/fake providers and no application reads. The real-source parent-death fixture uses an owned subreaper and pidfd, kills the supervisor, verifies helper SIGKILL and reaps it with `waitpid`, without initializing AT-SPI. These tests do not establish live cache behavior, desktop acceptance or a speed improvement. No live operations were run for this document.
