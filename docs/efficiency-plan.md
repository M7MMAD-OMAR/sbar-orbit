# Efficiency execution plan

Status: staged implementation plan, 3 November 2026. This is not an installed-runtime report or a speed claim. The [original application contract](desktop-only.md), [dated acceptance](acceptance.md) and [native roadmap](roadmap.md) remain authoritative.

## Outcome and evidence hierarchy

Reduce completed-task cost, not just tool latency. Measure successful workflows per elapsed second, end-to-end p50/p95, failure rate, retries, owner interventions and measured response bytes/tokens. A faster failed task is not an improvement. The target to evaluate is 80% higher successful-task throughput (1.8 times baseline, about 44.4% less time for a fixed successful workload), not 80% lower duration (5 times throughput). Predeclare per-task reliability/intervention bounds; any wrong-target effect or policy bypass fails acceptance. No achieved 80% efficiency claim, account safety claim, detection avoidance claim or ban guarantee follows from this plan.

Use this hierarchy for every milestone:

1. **Contract and source:** define exact target, permitted action, delivery boundary, budgets, completeness and failure behavior. Review code and fixtures.
2. **Packaged and installed:** identify source revision, artifact hash, installed broker/worker identity and capability version. A source test does not update an installed process.
3. **Prepared runtime:** verify loaded plugin source and current compositor ABI, exact application/window and visible numbered workspace. Do not restart a shared broker with active tasks.
4. **Delivered operation:** record a receipt only for what it proves. Missing replies, timeouts and cancellation do not prove non-delivery.
5. **Application effect:** observe after redraw, then verify the actual task postcondition, including save/reopen where applicable. A screenshot alone does not prove persistence.
6. **Comparative result:** compare compatible measured workflows, including failures and cleanup, before publishing a scoped performance claim.

Hyprland native control, bounded image/text/both observation and existing input transport foundations are already present. The current implementation wave adds observation correctness/diagnostics, a content-free evaluator and conservative error metadata in source. Their presence is not evidence of installation or live acceptance. Snapshot-scoped refs, semantic actions, skeleton/root traversal, Chromium opt-in, site profiles and additional native adapters below remain future work unless separately verified and recorded.

### Current native observation diagnostics

The source observation metadata is `observation: { requestedFormat, returnedFormat, workerMs, imageBytes, treeBytes, treeNodes, treeComplete }`. `workerMs` measures the worker request, not end-to-end task/model/render completion. Tree byte accounting uses UTF-8; `treeComplete` describes the bounded filtered traversal, not retained accessible-object identity or completeness of all application content. Password-role values are redacted from tree output, but screenshots are not sanitized. Keep both image and text outputs private; these counters do not make captured content safe for public logs. Source availability still requires separate installed/runtime verification.

## Execution order and dependencies

| Stage | Work and dependencies | Exit gate |
| --- | --- | --- |
| 0 | Freeze task protocol and baseline; retain failures and source/install/runtime identities. Audit title ambiguity, UTF-8 byte accounting, explicit truncation and timing first. | Fixture coverage for duplicate/missing window identity, Unicode, byte/node/deadline caps and honest unavailable/partial observations; initial compatible measured baseline. |
| 1 | [#27 structured errors](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/27), in parallel with evaluator tooling. Audit every mutation boundary before granting safe retry. | Stable additive broker/MCP fields, compatibility and no-replay tests. No inference from error code alone. |
| 2 | [#24 snapshot-scoped refs](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/24), depends on 0 and 1. Design native identity lifetime before exposing ref actions. | Changed/removed/replaced refs fail closed; live GTK4 and Qt6 stale-ref refusals. |
| 3 | [#25 semantic AT-SPI actions](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/25), depends on 2 and policy parity. [#26 GTK4 geometry](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/26) remains a separate coordinate-path obligation. | Visible captured effects for GTK4/Qt6 buttons, checkboxes and fields, plus the intended Nautilus cell opens. |
| 4 | [#28 skeleton/root](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/28), depends on 2, bounded traversal and atomic map updates. | Reach a specific Thunderbird message row via skeleton then root within caps, measured live. |
| 5 | [#29 Chromium/Electron trees](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/29), depends on exact registered launch provenance and 0. Evaluate flag, explicit in-app setting flow and screenshot-only alternatives. | Recorded decision and load/observation cost; if launch opt-in is chosen, an Orbit-opened VS Code returns a usable tree. |
| 6 | [#32 explicit launch outcomes](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/32), after identity/geometry contract. Can proceed independently of semantic actions. | Contract tests and real single-instance forwarding/minimum-size app evidence; requested and actual geometry remain distinct. |
| 7 | Optional task/site profiles, after reliable observations, scoped refs and delivery semantics. | Versioned profiles improve compatible measured task outcomes without silently broadening authority. |
| 8 | [#30 Windows/macOS](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/30), [#31 other Linux compositors](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/31), after a stable adapter contract. | Per-platform real-machine acceptance, not discovery/install/CI alone. |
| Cross-cutting | [#33 upstream comparison](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/33), [pinned research](research/agent-desktop.md). Feed caveats into 1 through 8. | Source-linked comparison and documentation index integration; no unsupported platform-parity claim. |

### Ref and action contract before implementation

- Bind each opaque ref to session, exact window/process generation, snapshot generation and native accessible identity. Set explicit TTL, retained snapshot count, node/byte/depth/deadline and memory limits. Reject bare, foreign, expired and evicted refs. Do not publish invented default limits as an implemented API.
- Node indexes, role/name/bounds, repeated accessible IDs and current uniqueness alone do not prove that an original object survived. Test a removed row replaced by an identical row at the same bounds. Ordinary edits on the same surviving object must still work.
- The current subprocess tree dumper cannot be assumed to retain native object identity across observations. Decide between a bounded long-lived accessibility host and a proven equivalent before #24 ships. Revalidate immediately before each write and qualify postcondition evidence with identity. State any remaining check/act race explicitly.
- Enumerate supported semantic actions and advertise only observed capabilities. Reuse pause, narrow, protected/full action settings and conversation-off gates for semantic and pointer paths. Preserve the visible ghost cursor contract even when AT-SPI delivers the effect.
- Attempt an effect once. Fallback to another mechanism is allowed only after proved non-delivery and current policy/identity checks. A timeout, changed state or failed readback is never permission for fallback.
- For #26 compare bounds to capture only when evidence is unambiguous. Do not apply universal pixel offsets. Semantic success does not close coordinate accuracy defects.
- Skeleton returns bounded structural nodes and honest child-count/unknown/truncation metadata. Root must use a valid scoped ref, preserve unrelated refs and fail without corrupting the map if a replacement subtree is incomplete.

### Retry and idempotency

The source contract being integrated uses `error.disposition = { delivery, retry }` and `error.suggestion`. Delivery values are `not-delivered`, `delivered`, `unknown`; retry is `safe` or `unsafe`; suggestion is `correct-request`, `observe-before-retry` or `do-not-retry`. Existing code/message fields stay compatible. These are Orbit values, not upstream spelling.

Default to `unknown`, `unsafe`, `observe-before-retry`. Only audited preflight failures can assert non-delivery. A policy denial is `not-delivered` but remains `unsafe` with `do-not-retry`; retry safety never grants authority. Errors after dispatch, lost acknowledgements and malformed worker replies stay unsafe unless the boundary proves otherwise. Metadata does not automatically retry anything. Observe exact state and select a new action deliberately.

Input deduplication already exists within a live broker session: [single actions](../src/session.ts#L323-L347) and [batches](../src/session.ts#L416-L456) retain request IDs, argument fingerprints and result promises in the session request map, capped at 10000 entries. Matching concurrent/repeated requests reuse the retained promise; conflicting arguments fail. Batch replay omits captured pixels rather than retaining/replaying images. This scoped in-memory protection is distinct from registered-launch request IDs and does not establish durable exactly-once effects across broker/session restarts. Remaining work is explicit durability/restart/retention semantics and integration of future semantic actions into the same deduplication boundary, preserving exact-target fingerprints and no double dispatch. Never blindly resend typing, Return, Save, account submission or payment after uncertain delivery.

### Explicit launch outcomes

For #32 the proposed `forwarded` outcome requires the real new window to be bound exactly after the launch PID exits; otherwise return `uncertain` with bounded candidate identities. A changed candidate list alone does not establish launch ancestry. Report requested and actual geometry separately, with the proposed `min_size_enforced` flag only when evidence supports that cause. Test single-instance races, existing windows, PID/window reuse, toolkit size clamps and normal cleanup. These proposed fields are not claims about the current shipped launch API.

### Chromium, profiles and privacy

Accessibility opt-in must be explicit and apply only to newly launched processes whose provenance is proven. Do not silently relaunch or change an existing owner browser. Single-instance forwarding can reuse an existing process and must not be treated as successful opt-in. Any in-app accessibility switch can affect a whole process, not just one window. Measure CPU/memory/load cost as well as tree coverage. Keep capture fallback and expose unavailable trees honestly.

Future profiles are declarative task hints: application/version compatibility, expected landmarks, observation budgets and verification steps. They cannot authorize arbitrary commands, skip gates, preserve stale refs or install a hidden browser. Native accessibility evidence does not prove the active URL/origin; a profile name is not origin enforcement. Do not claim domain isolation without an independently verified trusted origin signal.

Use original registered applications and explicit visible numbered workspaces. Ordinary web work prefers host browser tools; personal-profile use through Orbit requires explicit owner request. Preserve normal owner state, unrelated windows, unsaved work, focus and physical pointer. The ordinary shared clipboard is not a privacy boundary. Keep captures, trees, text, URLs, account identifiers and clipboard contents out of benchmark/public logs. Aggregate diagnostics must not copy raw provider errors or private content.

## Benchmark protocol and evaluator

Freeze a task matrix covering GTK4, Qt6, Gecko, Chromium/Electron tree availability, dense trees, popups/dialogs, failure recovery, original registered launch and concurrent owner activity. Include edit/save/reopen/normal-close tasks, not only RPCs. Keep application/runtime versions, task mix, model/settings, hardware, observation mode, task success definition, cleanup and token accounting fixed or explicitly partition results. Alternate baseline/candidate order to reduce drift. Never include live destructive/account actions merely to collect a benchmark.

The source evaluator is [the module](../src/efficiency-benchmark.ts) and [the CLI](../scripts/efficiency-benchmark.ts):

```sh
bun scripts/efficiency-benchmark.ts summary RUN.json
bun scripts/efficiency-benchmark.ts compare BASE.json CANDIDATE.json
```

The version-1 input is an explicitly measured serial run: `schemaVersion: 1`, `measured: true`, `execution: "serial"`, opaque `runId`, `configId`, `environmentId`, `protocolId`, `elapsedMs >= 1`, and samples with opaque `sampleId`, `taskId`, `outcome` (`success`/`failure`) and positive `durationMs`, plus `outcomeObserved: true` attesting an observed task result rather than a delivery acknowledgement. `configId` binds exact source revision, prepared build and runtime configuration through an opaque identity, with private provenance retained separately. Inputs allow at most 10000 samples; the CLI accepts regular JSON files up to 2 MiB. Optional `retries`, `interventions`, `responseBytes`, `tokens` are nonnegative measured integers, not estimates; tokens require `tokenMeasurementId`. Unknown fields/content are rejected. Elapsed time must cover summed sample duration. Optional metrics require complete coverage. Do not put application text into IDs.

Comparison requires distinct run IDs, matching environment/protocol/token definition, identical task counts and optional-metric coverage, and at least 20 samples per task in each run. Configuration IDs may differ. Report per-task and aggregate nearest-rank p50/p95 for all/successful samples, successful throughput against full measured elapsed time, failure rate, Wilson95 success interval and observed optional metric totals/means. Missing measurements stay absent, not zero. Wilson intervals assume independent trials; repeated desktop samples may violate that assumption. Output includes `latency`, `successfulLatency`, `successThroughputPerSecond`, `successRateWilson95`, per-task summaries and optional `metrics` (`total`, `meanPerSample`, `nonzeroSampleRate`). Comparisons include absolute/relative deltas and `observedRegressions` direction flags; an undefined percentage has `relativePercent: null`, not an invented zero. Deltas are descriptive, not significance, causality or generalization.

Twenty samples is a parser eligibility floor, not proof of adequate power or tail stability. Predeclare a task-level improvement target and acceptable reliability/intervention bounds before collecting data. Accept a candidate only if it meets those bounds, has no unauthorized side effect and produces source-bound reproducible evidence. Publish sample counts, denominators, failed tasks and limits alongside gains. No populated benchmark result or 80% improvement is established by adding an evaluator.

## Test gates and rollout

| Gate | Required evidence | Stop or rollback condition |
| --- | --- | --- |
| Source contract | Focused fixtures: error propagation/no leaks/no replay; valid/invalid benchmark comparisons; exact window selection; Unicode caps; identity churn; policy parity; incomplete subtree updates. | Any wrong-target action, safe classification without proof, content leak or silent truncation. |
| Repository integration | Lead runs one budgeted command at a time: frozen install if needed, `bun run scripts/limited.ts bun run typecheck`, then `bun run verify`. Documentation-only edits need no tests. | Type, protocol, compatibility or package regression. |
| Installed canary | Record artifact/source identity and capabilities; verify current compositor/plugin agreement. Start with read-only observations, then disposable original-app tasks. | Source/install mismatch, ABI mismatch, unexplained owner disturbance or unbounded resource use. |
| Live acceptance | Exact target/window, visible workspace and cursor, actual application postconditions, pause/narrow/off, owner focus/pointer, clipboard effects and exact normal cleanup. Test GTK4/Qt6 ref churn, Nautilus and Thunderbird criteria before closing their issues. | Uncertain delivery triggers observation, not replay. Wrong target or policy bypass disables the feature immediately. |
| Comparative rollout | Compatible measured baseline/candidate with per-task acceptance bounds and full failure accounting. Update dated acceptance/support claims only for exercised operations. | Reliability/intervention regression, incomplete evidence or task-specific slowdown beyond declared bounds. |

Release incrementally behind explicit capability negotiation/opt-in. Retain existing observation and guarded native input paths, but never fall back after uncertain delivery. Roll back the new feature/capability and invalidate its refs, not the owner application or saved data. Installed worker/plugin changes require coordinated idle handoff; do not restart shared infrastructure while others work. Record the previous artifact and ABI compatibility before replacing anything.

Windows, macOS, GNOME and KDE require separate consent, stable process/window identity, capture/input semantics, visible-workspace behavior and lifecycle implementations. Test original opening, observation, disposable editing, save/reopen, cursor, pause/off, owner activity and cleanup on each real host. Upstream cross-platform code is design evidence, not a substitute adapter or Orbit acceptance.

## Implementation ledger: foundation wave

Source work reviewed on 3 November 2026, based on `e1140384827aee9e7b34318c7044b88b167d7838`:

- Added the strict evaluator/CLI and isolated report metadata, without manufacturing workflow measurements.
- Added conservative broker, MCP and batch/capture error disposition. Existing request deduplication and transport behavior remain unchanged.
- Hardened observation with unique full native title matching, no substring/sole-window guessing, post-query compositor identity checks, UTF-8 whole-node bounds, explicit partial traversal and password-role text suppression. These checks do not establish durable accessible-object identity.
- Added content-free native observation cost/count metadata. No screenshot redaction or model/end-to-end timing is claimed.
- Linked the plan and pinned research; included new tests in default verification. Cross-reviews found and fixed null-child ambiguity and report-metadata mutation leakage.

Verification run: `bun install --frozen-lockfile --ignore-scripts` and budgeted typecheck passed. `bun run verify` passed 278 tests, skipped 4 platform-specific cases, failed 0. After final null-child/password-query hardening, the affected focused bundle passed 42 tests with 0 failures. These counts include Bun wrappers over native fixture suites; they are not live application acceptance.

Live gate: the read-only `native-check` command returned `COMPOSITOR_NOT_RESTARTED`: installed Hyprland 0.57.1 versus running 0.57.0. No logout, compositor/broker restart, plugin activation or application/account operation was attempted. Resume installed/native acceptance only after a normal owner-coordinated session transition and current source/ABI verification. Source development can continue meanwhile. No comparative workflow gain has been measured.

Remaining delivery is explicit: snapshot identity retention and refs (#24), semantic actions (#25), residual geometry (#26), drill-down (#28), Chromium decision (#29), launch outcomes (#32), profiles and platform adapters. Foundation source completion does not close those live gates.

## Implementation ledger: read-only host and retention primitive

Source work reviewed on 4 November 2026, after foundation commit `e3aa4f56a4ebfd9a1081d3fd3ee3cf81ed33dcbc`:

- Added an internal bounded retained-object registry, with mandatory injected validation, absolute TTL, whole-snapshot eviction/publication, reentry refusal and foreign/generation invalidation. Root retention counts toward budgets. It is not wired to a desktop provider or public refs API; Python object retention does not prove remote AT-SPI object survival.
- Added an experimental warm helper behind exact broker opt-in `ORBIT_A11Y_WARM_HOST=1`, with the cold default unchanged. Its only verb is observe. Repeated helper requests are framed/serialized under one deadline; malformed replies, timeout and EOF invalidate its generation without automatic retry.
- Added explicit parent-death protection, owned TERM/KILL/wait cleanup and unreaped-process quarantine. Actual trusted worker startup and supervisor-death fixtures verify SIGKILL and waitpid reaping without application accessibility initialization.
- Added bounded per-proxy cache clearing/cache-none, GLib event pumping and process-start checks. These are best-effort read freshness, not atomic snapshots, lossless events or provider identity proof. No performance claim follows.
- Independent reviews found and fixed request-lock/preflight cleanup interfering with another observation, plus optional helper cleanup failures preventing native pause/handback. Native lifecycle cleanup is still attempted and both errors retained.

Budgeted typecheck passed. Default `bun run verify` passed 282 tests, skipped 4 platform-specific cases, failed 0 across 44 files. Bun wrappers include pure registry, fake-provider transport and trusted-worker supervision fixtures. No real application/account task or native warm/cold performance comparison was performed. See the [host design and remaining authority/lifetime gates](accessibility-host-design.md).

At that wave, the recorded compositor readiness mismatch still prevented installed/live acceptance and was not bypassed. The later readiness repair is recorded below. Ref exposure, provider ABA proof, semantic authority/pause/off/narrow parity, Nautilus geometry and Thunderbird drill-down remain open. A warm helper is not safe semantic control.

## Implementation ledger: dispatch authority and observation round trips

Source work reviewed on 4 November 2026 after `82c1083d280cc9780027339e545d882d301bf781`:

- Re-evaluate current policy at queued broker dispatch and after an advisor await. A changed policy invalidates the pending advisor answer; no stale approval or second consultation restores authority. Actual allow decisions are journaled once at dispatch, preserving cached request promises and accepted single-action pause draining. Batch steps/capture recheck current authority after waits. These checks do not retract work already dispatched to a native worker/application.
- Current native observation includes fresh scoped window acknowledgement inside the admitted read. The backend validates frame/scale/pointer and all window identities before one atomic cache update, then strips the internal acknowledgement from the public response. Modern source fixtures prove one worker RPC rather than two; old workers retain the second scoped read, with the same selected-target and atomicity checks. This is a measured protocol count, not a wall-time gain.
- Cross-review found and fixed the legacy path accepting missing selected windows before cache commit. Empty, replaced, foreign, duplicate or malformed legacy/modern acknowledgements now refuse without partially changing state or retrying input.
- Added a [pinned GTK4/Qt6/libatspi remote lifetime audit](research/atspi-identity-lifetimes.md). GTK UUID realization paths give a conditional provider-specific source basis, not installed support; Qt ID wrapping and private routing remain unsupported identity gates.

Budgeted typecheck passed. Default verification passed 342 tests, skipped 4 platform-specific cases, failed 0 across 46 files. New source tests cover 48 acknowledgement/geometry/legacy cases and 12 queued-policy/advisor/batch cases.

### Native readiness repair, not application acceptance

A later read-only check found the owner session now running Hyprland 0.57.1, with no loaded plugin and an old 0.57.0 plan/build. The broker reported no active leases. Matching `hyprland-devel-0.57.1-1.fc44.x86_64` was downloaded, its Fedora signatures/digests verified, and extracted into a new private cache. Existing headers, original plugin artifacts and unrelated checkout changes were preserved; no package was installed.

The source-stamped plugin built successfully for running commit `acc1aa0bfd4bd575dcb0f76c35ccf12b660a1ab9`. Plugin source SHA-256: `beb3024586ce1e7f07735bd5f6cdf4cc129424f4e72ee1ee5491d60b7aff9a67`; new binary SHA-256: `31e6892227f58c98003bb147ed08b49dd9b3b5163840f58c4ab525bf2077b3cd`. Prior build metadata was retained privately. Normal `native-refresh --plugin-manifest` succeeded without restarting the shared broker, compositor or desktop, and `native-check` reported compositor, plan, build and loaded plugin agreement. This resolves the readiness gate only, not capture/input/owner-state behavior or any comparative speed claim.
