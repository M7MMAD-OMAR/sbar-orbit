# Current native support

Updated 27 October 2026. This table describes the current native-only implementation.
Retired browser and private desktop measurements do not establish current support.

| System | Discovery | Original opening | Input and capture |
| --- | --- | --- | --- |
| Fedora 44, Hyprland 0.57.0, Wayland, x86_64 | Implemented, locally exercised | Original GNOME Text Editor opened and controlled on a numbered workspace, 30 October 2026 | Plugin built against and loaded on 0.57.0 (commit 0aa6745f705f): click, typed text, keys, shared clipboard, window capture and the activity overlay measured once. Drag, scroll and the click ring are not re-measured on 0.57.0. The source no longer builds for 0.56.x; a compositor of another commit needs its own headers. |
| Fedora 44, Hyprland 0.56.2, Wayland, x86_64 (earlier releases) | Implemented, locally exercised | Limited, real installed application results below | Implemented source/ABI-bound control; dated editor Save, shared clipboard, Chrome local selection and Calculator input/capture/closure measurements. Other operations need their own evidence. |
| Other Linux distributions with Hyprland | Registration implementation available | Not measured on another host | Not measured |
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
executed failure. `Held` describes historical product refusal, not the current runtime policy. `Not measured` means
there is no acceptance evidence. None of these is universal support.

Original browser and terminal launch registrations are accepted. Copied profiles,
hidden/private desktops and the old viewer are absent. Original application processes use the
normal owner environment and OS permissions, not a security sandbox.

[Executed external-agent tasks](external-agent-acceptance.md) additionally record
real Claude Code and Hermes tool calls, failed application operation, host cache
incompatibility and the Codex CLI provider failure. Connection negotiation and
original opening do not establish a completed model-driven application workflow.

[Current shared clipboard acceptance](native-acceptance-0.3.0.md) records the actual
application results and source identity. Owner focus/pointer preservation during
concurrent owner activity and visible cross-workspace cursor appearance are not
certified by those captures.

Use the [current acceptance index](acceptance.md) to distinguish those 22 October
measurements from the later [keyboard and Calculator checks](native-input-reliability.md).
Source CI on Windows and macOS establishes its named source/service contracts,
not native control on either platform.
