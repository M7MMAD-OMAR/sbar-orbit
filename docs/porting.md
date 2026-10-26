# Native platform adapter contract

See [current support](support-tiers.md). The Hyprland adapter implements registered
opening, native handoff, input, capture and explicit workspace presentation, with
the operation-specific limits in [current acceptance](acceptance.md). Other native
platform adapters and universal application compatibility remain incomplete.

Every adapter must provide:

- Discovery tied to original installed application identity and packaging.
- Explicit user consent and permission status, with actionable refusal reasons.
- Visible numbered workspace selection that preserves normal user work.
- Original profile and environment, without cloning or a substitute desktop.
- Target-bound input with application-state evidence, visible agent activity and
  measurable owner pointer and focus behavior.
- Capture permission and target verification before returning pixels.
- Bounded custom window placement and verified resulting geometry.
- Exact lifecycle handling that preserves existing windows and unsaved content.
- Recovery after application exit, stale identity, permission loss and uncertain delivery.

The broker, policy, request identity, MCP and CLI can share platform-independent
contracts. Opening, input, capture, workspace behavior and permission prompts require
platform implementations and real host acceptance. A simulated service test proves
only its service contract. No installer should advertise unsupported native control.

Browser automation, profile copying, private sessions and an embedded viewer must
not be used to fill missing platform capabilities. The old porting proposals were
removed because they described those retired mechanisms. Git history retains them.
