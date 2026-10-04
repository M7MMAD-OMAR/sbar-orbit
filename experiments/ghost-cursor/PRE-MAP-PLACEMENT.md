# Native pre-map placement

Reviewed 4 October 2026. Private compositor prototype evidence only.

The scoped enrollment command now returns `ok <launch-token>`. The launcher
exports that token as `HL_EXEC_RULE_TOKEN` before executing the application.
The plugin installs a token-only window rule before enrollment returns. It
places new windows in `special:ghost silent`, disables initial focus and focus
on activation, and allows rendering without focus. No numeric PID fallback is
registered. The existing exact scope identity checks remain required for input.

The rule is an ordinary managed rule, rather than an expiring exec rule. A
configuration reload restores rules for registrations whose retained identity
still validates. Reload and registration prune rules for exited or revoked
processes. These are sampled placement checks, not continuous cgroup monitoring.
Input ownership checks continue to refuse observed invalid identities. This
same-user protocol is cooperative and does not prevent deliberate token copying.

## Version and official references

The implementation targets Hyprland 0.56.2 at commit
`efb50993780079460b0cbed1363e2166a2de1d9f`. These version-specific sources were
reviewed on 4 October 2026:

- [Window rule matching](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/desktop/rule/windowRule/WindowRule.cpp): token matching is independent of the optional numeric PID fallback.
- [Rule lifetime](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/desktop/rule/Rule.cpp): exec rules expire; ordinary rules need explicit lifecycle management.
- [Rule engine](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/desktop/rule/Engine.cpp): registration, removal and configuration replacement.
- [Executor](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/supplementary/executor/Executor.cpp): launch tokens are delivered through the application's exec environment.

## Reproduction and evidence

Start a fresh private lab, load a version-matched plugin built from the intended
source, and run this command through `lab.py run LAB --` inside one bounded
command:

```sh
/usr/bin/python3 experiments/ghost-cursor/native_pre_map_probe.py
```

Use an absolute probe path when `lab.py run` changes the working directory.
The probe binds its report to the mapped plugin binary and its build source
hash. It enrolls a process in a real user-manager scope, then executes the GTK3
fixture before connecting to Wayland. It does not use a compositor exec wrapper,
move an already mapped window or restore focus to conceal a transient failure.

The source before this change failed `Window mapped outside agent space`. The
intermediate pre-map source failed `Revoked process retained its placement rule`
after live cgroup migration and configuration reload. The final source passed
initial mapping, a new window after reload, removal of placement after migration,
focus preservation and absence of transient keyboard focus events during the
two owned mapping checks. All fixture processes and both scopes were cleaned up.

Final plugin source SHA-256:
`0638b71f633bff30225a30bc7cc6d575519a92ffdf0a899d8854f9c2a2cfc363`.
Loaded binary SHA-256:
`ed25594790e1e78a85c08edc09fa4fc31d84170a8c49dfaf626d7981ab9f3b93`.
Build optimization: O0 prototype.

An initial fixture failure was retained: changing the process environment after
startup did not publish its launch token through `/proc/PID/environ`. The fixture
now models the real launcher's exec boundary. Both negative checks were rerun
against that corrected fixture. A later GTK4 and Qt cursor recording attempt
failed when `grim -T` timed out on the GTK4 surface; it is not accepted evidence
for this revision. Earlier recordings remain historical evidence only.

Follow-up diagnosis found two lab preconditions were missing. A headless lab can
have no pointer device, and its nested compositor can enter a zero-size FALLBACK
output after GBM allocation fails. A diagnostic change to enumerate additional
seat resources did not fix the pointer failure and was discarded. The retained
renderer log showed allocation failures on the NVIDIA render node. KWin 6.7.5
supports selecting render-only devices with
[`KWIN_RENDER_NODES`](https://github.com/KDE/kwin/blob/v6.7.5/src/core/gpumanager.cpp).
The lab now accepts an explicit validated render node and requires a live
1920x1200 WAYLAND-1 output before reporting successful startup. Invalid output
evidence is retained before the lab is stopped. The option accepts render-only
character devices; the nested real-input and display-card refusal remains in force.
Default and explicit NVIDIA startup checks also subsequently produced valid
outputs. The retained allocation failure does not establish that either path
always fails. Attempts to disable or resize the output through a legacy monitor
keyword returned success without changing the observed geometry; those fixture
mutations failed their assertions and are not accepted negative runtime checks.

The output-failure cleanup probe injects unavailable evidence storage into the
actual old startup exception handler. The old handler fails both cleanup
assertions. The fixed handler passes all three checks, including preservation of
the original error alongside evidence and cleanup errors. Output validation also
rejects a recorded zero-size FALLBACK, wrong geometry, disabled or extra outputs.
This check runs without opening any display:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab_output_test.py
```

To reproduce the recording, start the lab with `lab.py up --render-node
/dev/dri/renderDNUMBER`, selecting a verified local render node, then load the
version-matched plugin. Stage the allowed theme subset with
`native_appearance_stage.ts SOURCE_CONFIG LAB` and use its returned directory.
The device preconditions must persist through both native tasks. Build
`person_pointer.c` with its generated virtual-pointer protocol source and
`libwayland-client`; then launch the following inside the private lab with
`lab.py spawn LAB --`, through one bounded command at a time:

```sh
/absolute/path/to/person-pointer 960 1080 1920 1200 hold
wtype -s 60000
```

The first fixture creates a private pointer without clicking; the second holds
a private keyboard for 60 seconds without typing. Run the absolute path to
`native_scoped_cursor_demo.py STAGED_CONFIG prefer-dark` through `lab.py run
LAB --` before that keyboard expires. These are explicit test preconditions,
not production input devices. Stop the lab with `lab.py down LAB` after the
probe, including on failure; it owns both fixture processes.

A fresh lab with the Intel render node and held private simulated-person pointer
and keyboard completed the GTK4 and Dolphin recording: 21 native actions,
3.0311073 seconds of overlapping input, continuing stand-in typing, and pointer
samples fixed at one position. The text task displays its scoped cursor before
its initial capture. The 58-frame APNG preserved decoded pixels and durations,
shrinking 4,192,755 source PNG bytes to 1,356,262 bytes. Its SHA-256 is
`a38523cd232c16feefc200892027337709304fe3f6fef8fedcdd4201a013b1e9`.
The final pre-map probe was rerun successfully on that valid nested output and
confirmed the mapped plugin binary and source hashes above. This recording proves
private native operation only. It does not measure owner-session activation,
whole-system noninterference or comparative performance.

For the preceding pre-map revision, typecheck passed. The full bounded suite passed with 583 passes, 45 skips and
zero failures across 628 tests. This run followed the owner's explicit approval
to stop five unrelated project sessions; the previous resource-related failed
run remains retained. The public audit checked 819 files with no findings, and
the staged Gitleaks scan reported no leaks. Raw runtime logs and appearance configuration remain
private. Owner-session activation, production launch transport, owner-session
cursor visual acceptance and comparative whole-system performance are not
measured by this probe and remain required work.

After the output readiness and cleanup follow-up, bounded typecheck and the full
suite passed again: 583 passes, 45 skips, zero failures, 3,772 assertions across
628 tests in 135 files. The standalone output regression suite also passed its
three checks after detecting two failures in the saved unfixed handler. These
gates do not replace the outstanding owner-session and performance checks.
