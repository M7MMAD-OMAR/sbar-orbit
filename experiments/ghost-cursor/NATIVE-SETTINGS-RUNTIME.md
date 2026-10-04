# Public native owner controls

Measured 4 October 2026 in a private Hyprland lab with Bun 1.3.14, system
Python 3.14 and GTK 4.22.5. No owner-display activation was performed.

`sbar-orbit native-settings` opens the native GTK4 owner controls. It accepts
no mode, action or configuration arguments. Linux, system Python with GTK4 GI,
the shared resource budget, and the owner's fixed absolute ORBIT_NATIVE_PLAN
and ORBIT_NATIVE_CONTROL configuration are required. The control directory
must already be a real, private directory belonging to the current user.
The owner launches this UI; agent RPC does not expose a settings entry.

The same durable ActionControl storage is used by native actions and the UI.
Protected mode approves the displayed exact request once. Full access admits
Orbit native actions while retaining intent and outcome records. This is the
cooperative Orbit API boundary; experimental direct compositor IPC is not an
OS-enforced access boundary.

## Private public-command measurement

The actual `bun src/cli.ts native-settings` process was launched inside the
private lab. AT-SPI found its GTK child and exercised exact one-use approval,
replay denial, full/protected mode roundtrip and activity readback. Three damaged
journal shapes disabled approval and mode application with a visible error.
The settings window was refused as an agent target. Closing while its storage
was locked settled within the fixture's two-second exit deadline. The probe
reported all five checks true and 12 journal events. Its private target-only
screenshot was visually inspected. The light lab theme does not prove owner
dark-theme inheritance.

The probe supplies an absolute placeholder plan path because the settings UI
does not operate the compositor. This proves the public UI shares control
storage; it does not prove a prepared owner host or activate that host.
An additional forced-parent-death fixture verifies independent cleanup of the
GTK child. Restoring the old root-only cleanup in a temporary source copy fails
with `Owned UI processes survived cleanup`; the fixed version passes. The
negative-control child was removed by lab shutdown. All lab processes and the
temporary lab directory were removed afterward.

Three public CLI refusal tests pass with nine assertions: supplied action
arguments, missing owner configuration and relative configuration. Their first
run failed because the test parsed stdout while CLI failures are on stderr.
That was a test error, not a production refusal failure.

```sh
bun run scripts/limited.ts bun test tests/native-settings.test.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py run LAB -- /usr/bin/python3 ABSOLUTE_REPO/experiments/ghost-cursor/native_settings_probe.py --cli
```

The guarded experimental preview imports this same runtime UI. The command
does not install GTK, change host preparation or start the managed broker.
Owner activation, final theme and desktop acceptance, broader input/toolkit
coverage and CPU/memory/latency comparison remain open. No faster or
zero-overhead claim follows from this UI test.

## Source binding

- `src/native/settings.py`: `cc95e19c647053a0ed6cf3540e29db225f7aaef66fc40659777f96a769065165`
- `src/native/control.py`: `2332734a5d75f443f42616e6a9bdae87f2c1b27b61563456887fbbcc1ac57a27`
- `src/native-settings.ts`: `9aa50a908859c1a131274bc2e82124c1a9613f22af3c4c88fa9036aa8b486aad`
- `src/cli.ts`: `85cba40e5c2143dd7d992ef3a7058a4caa113ab62bff0b7af8308a5009edd6e8`
- `experiments/ghost-cursor/native_settings.py`: `9bb909f35e62e5fe254a03b9b2d5dd0779c85bc817c58f909891360e0aea9648`
- `experiments/ghost-cursor/native_settings_probe.py`: `f71edfcff24cb57b45e0485135e0762b0798499a0d71ff9475b948425354b61f`
