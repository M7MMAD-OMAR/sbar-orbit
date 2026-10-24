# Orbit 0.3.1

Native control now survives a compositor restart and no longer stops when the
owner looks at the application.

## Compositor restart

A host plan and a loaded plugin belong to one compositor instance. After Hyprland
restarts, `sbar-orbit native-refresh` re-stages the recorded plugin build, loads it
and swaps the current plan atomically. The owner's control directory, with its mode
and action log, is kept and never rewritten. A changed compositor ABI, commit or
version stops with a rebuild instruction instead of loading a mismatched binary.
Record the build once with `native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON`.
The autostart entry then runs `native-refresh --if-configured` at each desktop
start, and a running broker needs no restart because every new worker binds the
plan `current` points to. A missing compositor endpoint now names this command.

## Owner and agent together

Owner focus, hover and workspace changes no longer refuse a claim or end a lease.
Real key, button or wheel input to the leased client pauses agent input until about
two seconds of owner idle, then it resumes by itself. The worker also waits a bounded
time for a pause in owner input before reporting `OWNER_BUSY`.

## Upgrading

Rebuild the native plugin against your compositor and record it with
`native-refresh --plugin-manifest`. The plugin source changed in this release, so an
older prepared build is refused by the source check until it is replaced.

Measured in a nested Hyprland 0.56.2 lab with a GTK fixture (22 of 22 checks) and
on the owner's live session for handoff while the owner watched. Pause and resume on
real typing in the live session, and the restart path itself, are not yet measured
there. This is cooperative application control, not an OS security sandbox.
