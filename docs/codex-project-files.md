# Codex selected project files, research only

This research note predates the snapshot project grant described in `codex-local-state.md`. The current public Codex `active` route attaches to a live owner authority and rejects `projectPath`. No attached client project-file workflow has been measured.

## Current gap

The current [Codex launcher](../src/native-codex-attach.ts) creates an empty private home and connects to the owner's live authority through verified sockets. The [private mount](../src/native/mount_unix.py) replaces `/home` with that empty home and masks the host `/tmp` and user runtime. A host project path under `/home` therefore does not resolve inside private Codex. The old snapshot helper in `native-codex.ts` is not used by the public route. A project bind for the attached client needs separate validation.

## Candidate grant

An attached client project grant would need a separate action contract and mount policy. The existing file lease accepts only regular files. In the supervisor, reserve the selected directory for the application tree. In `mount_command`, reject the host home itself, protected profile directories, the Orbit session and runtime, and any path with symbolic source components. Open each source component with `O_DIRECTORY | O_NOFOLLOW`, retain the final directory descriptor, and bind it at the same absolute path with `--bind-fd` after the private home mount. Create only its missing parent directories inside the private home. Keep the owner's Codex profile paths masked.

The [current leases](../src/native/file_leases.py) lock exact regular-file paths. Directory grants need shared locks on ancestor directory keys and an exclusive lock on the selected directory key, held until all app descendants exit. Existing exact-file grants would need the same ancestor locks so a file inside a reserved project conflicts. These locks coordinate Orbit launches only.

## Boundary and conflict limits

Bubblewrap [binds directories recursively](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c). The selected project may contain a hard link to an original profile file, a pathname UNIX socket or a nested mount. Source-path checks and a pinned descriptor do not filter those descendants or prevent later host changes. A simple writable bind therefore treats the entire selected subtree as trusted. If that trust is unacceptable, use a virtual FUSE view that validates each opened file, rejects sockets, hard links and mount crossings, and stages writes through a broker. That is a larger design, not this candidate grant.

The current desktop mount uses abstract-socket Landlock only. Applying the existing pathname-socket policy after the outer bubblewrap setup could protect more sockets, but its filesystem rules would be inherited by Codex helpers. [Kernel documentation](https://docs.kernel.org/userspace-api/landlock.html) says such rules prevent mount topology changes, so nested bubblewrap compatibility needs a separate pilot before any claim. A direct writable project bind permits ordinary atomic saves, but a host editor can save the same file concurrently. The last writer may win; neither the proposed directory lease nor the [atomic-exchange experiment](../experiments/safe-save-rename-exchange.py) makes direct writes conflict-safe.

## Required measurements before implementation is claimed

- Parse and reject malformed `projectPath` values, unexpected launch arguments and protected roots.
- On disposable directories, reject symbolic source components, bind the pinned source after a pathname rename without redirecting to a replacement, report the original host path as stale, and read and write a file through its identical absolute path inside the private mount.
- Verify the original profile marker, an unselected sibling project, host runtime sockets and host X11 sockets stay inaccessible while the private display socket remains usable.
- Probe hard links, project-local sockets and nested mounts. Either reject them in a measured fail-closed path or document the selected-subtree trust boundary in the user-facing result.
- Verify directory leases collide with selected files and overlapping project directories, release after descendant exit, and leave host-process edits outside the lease claim.
- In a private Codex pilot, measure project opening and saving with unchanged original profile hashes and no effect on the person's display. Keep project listing and thread history as separate measurements.
