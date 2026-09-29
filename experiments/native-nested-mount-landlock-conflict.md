# Pathname socket policy and nested mount conflict

Status on 29 September 2026: measured in a synthetic Orbit desktop mount.
No personal application, browser profile, account, or window was used.

Run the [fixture](native-nested-mount-landlock-probe.py) inside the Orbit
resource slice:

```sh
bun run scripts/limited.ts timeout 20s /usr/bin/python3 \
  experiments/native-nested-mount-landlock-probe.py
```

The fixture creates two disposable UNIX sockets. One is the selected socket
inside the private session directory. The other is a host socket under
`/var/tmp`. Both appear in an outer Bubblewrap mount. A child then attempts
to connect to the host socket and start a nested Bubblewrap mount.

| Child policy | Host socket | Nested Bubblewrap |
| --- | --- | --- |
| Baseline outer mount | Connected | Exit 0 |
| Landlock rule for selected socket | `EACCES` (13) | Exit 1, `Failed to make / slave` |

The command exited 0 and printed those two measured rows. The strict rule
blocks the unselected host socket, but it also prevents the nested mount.
This matches the [Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html):
a process under Landlock filesystem restrictions cannot modify the filesystem
topology with mount operations. In the repository's native Codex project test,
the same strict bootstrap made nested Bubblewrap fail. A preceding native GTK
fixture also failed when the rule was applied to its mount path.

A production attempt that installed the strict rule after the outer mount was
reverted. The repository's runtime behavior was not changed by this attempt.
The synthetic result does not prove that every nested tool fails, nor that a
different policy or broker is impossible. It establishes a concrete design
constraint: the current Landlock socket rule cannot be installed in the app
process while preserving its ability to make nested mounts. A future design
needs to gate host socket access without putting this filesystem topology
restriction on the process that creates nested application sandboxes.

No personal app data or account capability was measured by this fixture.
