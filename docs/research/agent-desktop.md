# agent-desktop: pinned comparison and adoption limits

Source review: 3 November 2026. Upstream: [vercel-labs/agent-desktop at 17467da5142d471b1e3a6b24828a5d3ad4d8c547](https://github.com/vercel-labs/agent-desktop/tree/17467da5142d471b1e3a6b24828a5d3ad4d8c547). This compares source contracts, not a benchmark or a live cross-platform test. Later upstream changes are outside this review.

## Position

| Dimension | Upstream at the pin | Orbit |
| --- | --- | --- |
| Integration | CLI and C library over a shared Rust core and compile-time platform adapter. No MCP server advertised in the reviewed interface. | MCP broker and native worker with registered original-application opening and exact target handoff. |
| Primary observation | OS accessibility tree, qualified refs, screenshots available separately. | Image/text/both observation; bounded accessibility content complements capture. |
| Interaction | Semantic/headless by default, without pointer movement or focus change; headed physical paths have platform-specific constraints. | Hyprland prepared native input with visible agent cursor/indicator and selected visible numbered workspace, preserving the owner pointer/focus. |
| Platforms | Separate AX, UI Automation and AT-SPI adapters. Capability differs by operation and display server. | Measured native control is Hyprland; Windows/macOS and other compositor native adapters remain future work. Discovery/install support is not native control. |
| Visibility | The command list includes `cursor-overlay`; do not describe this pin as having no overlay capability. Headless actions themselves do not move the physical pointer. | Visible ghost cursor and workspace presentation are product obligations, including future semantic actions. |
| Authority | Upstream permission and action policy are upstream contracts. | Pause, narrow, protected/full settings, conversation off and exact target gates must apply to every action route. Same-user cooperation, not a security sandbox. |

Sources: upstream [README](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/README.md), [Linux input reference](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/skills/agent-desktop-linux/references/display-servers-and-input.md), Orbit [product contract](../desktop-only.md) and [acceptance](../acceptance.md).

## Useful designs, with their actual limits

### Qualified refs are not universal retained-object identity

Upstream refs include a snapshot ID, for example `@s8f3k2p9:e8`, and bare element refs are rejected. Ref lookup is scoped to the selected session namespace. Complete capture proof and current uniqueness reduce positional aliasing, but they do not establish object survival on every platform.

The pinned [identity guidance](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/docs/solutions/best-practices/identity-fingerprint-against-os-reorder-2026-04-16.md) explicitly distinguishes macOS accessibility-address retention from other platforms. On non-macOS, a captured unique element that is destroyed and recreated can be acted on as its replacement if exactly one live element matches the predicate. Identical twins are refused, but identical replacement is not the same problem. This is a known limitation, not a promise that all stale targets fail closed.

The [2.6 JSON contract](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/docs/json-output.md) documents capture-proof requirements, identity-unproven refs and ambiguity failures. Do not copy only the ref syntax and infer its stronger macOS identity behavior on Linux. Orbit [#24](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/24) needs bounded native identity retention or a proven equivalent, process/window generations and a live replaced-row test on GTK4 and Qt6 before claiming the original target cannot alias a replacement. Ordinary edits on a surviving text field must remain valid.

### Semantic effects and visible feedback are separate

AT-SPI Action, EditableText and Value can avoid incorrect box centers. Upstream Linux documents semantic background actions on X11 and Wayland, but this is not arbitrary background physical input. Orbit [#25](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/25) should reuse policy checks and visible ghost-cursor feedback, verify application effects, and forbid fallback after uncertain delivery. Semantic actions may change application state even if the owner pointer never moved. Geometry bugs in [#26](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/26) still need independent coordinate-path acceptance.

### Error disposition is evidence, not automatic recovery

Upstream [JSON output](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/docs/json-output.md) separates delivery from retry and limits recovery hints to safe cases. Its vocabulary includes `not_delivered`, `delivery_uncertain`, `delivered_unverified` and `delivered_verified`, with `unknown` preserved when delivery is not established. It also warns that even verified element state does not prove application persistence.

Orbit [#27](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/27) adopts the distinction, not exact enum parity: the source contract uses nested `error.disposition`, conservative `unknown`/`unsafe` defaults and fixed suggestions. A timeout or missing acknowledgement never proves non-delivery; a no-delivery policy refusal still does not authorize retry. The [execution plan](../efficiency-plan.md#retry-and-idempotency) records Orbit values and idempotency requirements. Neither system should infer an application save or account submission from a success receipt.

### Progressive observation requires map integrity

Upstream [concepts](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/CONCEPTS.md) distinguishes partial full snapshots from root drill-down. Full snapshots may return incomplete data with explicit tree/subtree markers; root traversal replaces descendants in an existing refmap and must not silently install incomplete replacements. Orbit [#28](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/28) needs bounded skeleton/root traversal, clear count/unknown/completeness metadata and atomic map replacement. A live Thunderbird row drill-down is its acceptance gate, not an upstream feature demonstration.

## CLI and FFI are not feature-identical

The pinned [FFI snapshot entrypoint](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/crates/ffi/src/commands/snapshot.rs) explicitly omits exact `window_id`, skeleton and root traversal. It constructs `window_id: None`, `skeleton: false`, `root_ref: None`, `timeout_ms: None`, `force_electron_a11y: false`. The C snapshot API therefore cannot be assumed to expose the corresponding CLI controls. Choosing it as an Orbit backend would require an exact-target contract, not app-name targeting by convenience.

The same entrypoint documents ownership of allocated result strings and null versus allocated-error outputs. Refmap persistence occurs before result serialization, so serialization failure does not imply no state change. Upstream [JSON output](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/docs/json-output.md) also notes that status-only C functions cannot expose full successful delivery/steps/target reports. An ABI version check is necessary for integration, not evidence of feature parity or target correctness.

## Why this does not replace Hyprland native control

The [pinned Linux guide](https://github.com/vercel-labs/agent-desktop/blob/17467da5142d471b1e3a6b24828a5d3ad4d8c547/skills/agent-desktop-linux/references/display-servers-and-input.md) says GNOME Wayland physical pointer commands are refused, keyboard delivery uses Mutter RemoteDesktop with focus/capability checks, window operations are restricted and capture uses portal consent. X11 physical input uses XTEST and headed pointer paths move the owner cursor. These constraints do not supply Orbit's exact-client Hyprland input, visible ghost cursor and owner-preserving workspace presentation. A GNOME-specific path is not a generic Wayland/Hyprland adapter.

Keep the Hyprland plugin for its input/capture/presentation/lifecycle obligations. A separately designed accessibility component could complement it after identity, policy, bounded-lifetime and installed-runtime validation. Do not swap backends silently or let semantic fallback bypass conversation off.

## Adoption order and evidence

1. Ship observation correctness, content-free measurement tooling and conservative error metadata as independently tested source foundations. Record installed identities separately.
2. Resolve #24 identity lifetime and budget design before #25 semantic actions or #28 drill-down. Test churn, identical replacements, ambiguity, expiry, process restart and incomplete observations.
3. Evaluate explicit Chromium/Electron opt-in in [#29](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/29), measuring cost and usable trees without changing existing owner processes.
4. Reuse adapter lessons for [#30](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/30) and [#31](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/31) only after per-platform consent, identity, effects and lifecycle acceptance. Keep [#32](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/32) launch outcome evidence distinct from control.
5. Before copying code, preserve upstream Apache-2.0 license and applicable notices, pin the reused source, review dependencies and document provenance. No upstream code or binary is introduced by this research document.

No upstream binary was installed or run for this review. No account, platform detection, ban resistance or relative speed was tested. Snapshot/tree/clipboard/trace/debug artifacts may contain private content; exclude them from public benchmark records. Use the [execution plan](../efficiency-plan.md) for staged gates and [dated acceptance](../acceptance.md) for actual Orbit runtime evidence.
