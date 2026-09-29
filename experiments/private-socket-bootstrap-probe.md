# Private UNIX socket bootstrap probe

This experiment uses only disposable files and a synthetic application. It does not launch or change a personal application or profile.

Run:

```sh
bun run scripts/limited.ts timeout 30s /usr/bin/python3 experiments/private-socket-bootstrap-probe.py
```

The probe builds a private `bwrap` mount, then launches a fixed bootstrap before the synthetic application. The parent copies the bootstrap code, Landlock helper, and strict JSON policy into sealed memory files. `bwrap` copies those bytes into read-only files under its private `/mnt`. The command after mount setup is `/usr/bin/python3 -I -S` running that bootstrap. There is no shell or application command before the bootstrap.

The bootstrap checks the expected private HOME, the shared project alias, and its canonical target. It creates a Landlock ruleset for exact verified host sockets, grants pathname socket access in private HOME and private `/tmp`, restricts itself, then uses `execv` to start the synthetic application. Failure exits 78 before the application marker is written.

| Layout | Bootstrap | Private HOME socket | Private `/tmp` socket | Exact host socket | Late socket in shared project | Save |
| --- | --- | --- | --- | --- | --- | --- |
| Shared project mounted inside private HOME | Denied before app | Not run | Not run | Not run | Not run | Not run |
| Shared project mounted at `/mnt/shared`, symlink at `~/project` | App started | Connected | Connected | Connected | `EACCES` | Atomic save visible on host |

The earlier [directory grant probe](private-unix-socket-landlock-probe.py) also shows why the layout check matters. With a shared project bind mounted beneath private HOME, granting `ACCESS_FS_RESOLVE_UNIX` on HOME lets the child connect to a new host socket in that project. Moving the bind mount outside HOME and using a symlink blocks it. Installing Landlock before `bwrap` makes mount setup fail on this machine, so the policy needs to be installed after mount setup and before app execution.

A later [copied Desktop probe](codex-no-home-socket-probe.md) found a narrower option for the measured cases. Without a HOME directory grant, the copied Codex Desktop connected to its own HOME socket, and a synthetic app in the nested project layout was denied access to a late host socket. This preserves the project's canonical path. It still needs production integration and broader application tests.

## Integration boundary

The native supervisor can create sealed policy and bootstrap file descriptors after verifying selected socket identities and mount sources. It can give those descriptors to `bwrap` with `--ro-bind-data`, set the sole payload command to the trusted bootstrap, and pass the desired application command as arguments. The bootstrap must verify the actual mount layout, apply the pathname and abstract socket policy, then `execv` the app. Any failure must end the launch before app execution. No user-controlled shell or interpreter code may run between the mount setup and the policy.

The current production mount uses a nested project bind and only abstract socket scoping, so this probe is not a production fix. The symlink changes the canonical path of the project to `/mnt/shared`; application compatibility has not been measured. Every mount inside a directory granted pathname socket access needs an equivalent escape check. The test covers synthetic sockets and a file save, not Electron, GTK, VS Code, or Codex behavior. The private HOME is still a host directory owned by the same user; a separate same-user host process can place a socket there, which this directory grant would allow. That property needs an explicit trust decision or a different private HOME layout before claiming a full security boundary.
