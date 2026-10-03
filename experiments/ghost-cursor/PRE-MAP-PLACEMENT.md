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

Typecheck passed. The full bounded suite passed with 583 passes, 45 skips and
zero failures across 628 tests. This run followed the owner's explicit approval
to stop five unrelated project sessions; the previous resource-related failed
run remains retained. The public audit checked 819 files with no findings, and
the staged Gitleaks scan reported no leaks. Raw runtime logs and appearance configuration remain
private. Owner-session activation, production launch transport, cursor visual
acceptance on this source and comparative whole-system performance are not
measured by this probe and remain required work.
