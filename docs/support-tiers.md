# Current native support

Updated 22 October 2026. This table describes the current native-only implementation.
Retired browser and private desktop measurements do not establish current support.

| System | Discovery | Original opening | Input and capture |
| --- | --- | --- | --- |
| Fedora 44, Hyprland 0.56.2, Wayland, x86_64 | Implemented, locally exercised | Limited, real installed application results below | Held after compositor incident |
| Other Linux distributions with Hyprland | Registration implementation available | Not measured on another host | Held, not measured |
| GNOME, KDE, Sway and other Linux compositors | Linux metadata discovery available | No opening adapter implemented | No working adapter certified |
| Windows | App Paths metadata implementation and service contracts | No native opening adapter implemented | No native control adapter implemented |
| macOS | Bundle metadata implementation and service contracts | No native opening adapter implemented | No native control adapter implemented |

A platform installer, discovery result, mocked platform test or successful build is
not application compatibility. Complete cross-platform desktop control is unfinished.

[The real opening report](native-opening.md) records individual applications, failed
attempts, measured geometry and cleanup. It does not certify their document editing,
account state, accessibility, pointer, keyboard or screen capture.

`Measured` means an actual observation within its stated host, source and operation.
`Limited` means that observation has explicit restrictions. `Failed` retains an
executed failure. `Held` means the product refuses activation. `Not measured` means
there is no acceptance evidence. None of these is universal support.

Browser launch, copied profiles, hidden/private desktops and the old viewer are
removed. There is no settings override. Original application processes use the
normal owner environment and OS permissions, not a security sandbox.

[Executed external-agent tasks](external-agent-acceptance.md) additionally record
real Claude Code and Hermes tool calls, failed application operation, host cache
incompatibility and the Codex CLI provider failure. Connection negotiation and
original opening do not establish a completed model-driven application workflow.
