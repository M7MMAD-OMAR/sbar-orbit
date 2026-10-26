# Orbit 0.3.2

This release publishes the native application work since the last GitHub release,
0.2.1. Versions 0.3.0 and 0.3.1 were documented in the source without corresponding
published GitHub releases.

## Original applications and visible workspaces

Orbit controls original installed applications on explicit numbered Linux
workspaces, with normal owner state and the shared system clipboard. Hidden
substitute desktops, copied profiles and browser-specific session backends are
removed. Ordinary web tasks use the AI host's browser; using the owner's original
browser or personal profile requires an explicit request.

The existing full-monitor gradient indicator, workspace label, agent cursor and
click pulse mark active native work. Opening and presentation are separate:
presentation chooses an explicitly named unfocused output and preserves owner
focus. New windows request bounded floating geometry, with actual toolkit sizes
reported. Handoff binds exact window identities and the verified loaded plugin.

## Keyboard reliability and latency

- Modifier names accept case-insensitive canonical names and explicit left/right
  XKB aliases such as `Control_L`.
- Rejected key or text payloads release their matching preparation. An uncertain
  commit is never replayed, and cleanup remains token-bound and deadline-bound.
- Pending readiness uses delays of 1, 2, 4 and 8 ms, then at most 10 ms. Immediate
  readiness does not sleep. Exact token and configure serial checks remain.
- A recognized commit receipt avoids one redundant cancellation request. In a
  local Unix socket fixture, 40 samples per version measured median transport
  time of 11.963 ms before and 2.389 ms after, with four versus three requests.
  These are controlled transport measurements, not universal application timings.
- Existing client lease or capacity refusals report `APPLICATION_BUSY`, with an
  actionable public message and retained diagnostic classification. Orbit does
  not assume a conflicting lease is abandoned or take it over automatically.

## Compositor lifecycle and owner input

`native-refresh` renews a prepared host binding after a compositor restart while
preserving owner control state. Plugin source and compositor ABI must match.
Owner focus and hover do not end control; physical input to the leased client
temporarily pauses agent input. See the [0.3.1 notes](release-0.3.1.md) for the
measured limits of those paths.

## Verification and compatibility

The latest implementation passed 223 local tests, with zero failures and four
platform-dependent skips, plus typecheck and independent specification and
standards reviews. Native measurements on the Linux Hyprland host include
selection replacement in a local document and original browser address field,
recovery after a rejected modifier, and an original GNOME Calculator producing
`12345 + 6789 = 19134`. The exact calculator test window was normally closed and
its disappearance verified. Account challenges and platform detection behavior
were not tested or attributed to Orbit.

Cross-platform source and installation contract checks are distinct from native
desktop acceptance. Windows and macOS native control is not established by this
release. Read the [support matrix](support-tiers.md) and
[native input investigation](native-input-reliability.md) before extending an
acceptance result to another application or machine.

## Installation and upgrade

The GitHub release includes a source archive, an installable registry-format
package and SHA-256 files. The installable package includes the frozen Bun lockfile;
neither artifact includes dependencies or a compositor-specific native binary.

```sh
bun add -g https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/v0.3.2/sbar-orbit-0.3.2.tgz
sbar-orbit install --connect auto
```

The plugin changed since the previous public release. Rebuild it against the
running compositor, verify its source and ABI, and record it with
`native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON`. Upgrade shared services
only after active sessions finish and native unload readiness is verified.
Publishing a release does not restart the owner's running broker or replace its
loaded plugin.
