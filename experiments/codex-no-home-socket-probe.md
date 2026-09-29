# Copied Codex Desktop without a HOME socket grant

This experiment used a copied Codex Desktop candidate, a disposable HOME, a disposable Xvnc display, private `/tmp` and runtime directories, and no network. It did not read or change the personal Codex profile, application, display, or pointer.

Run:

```sh
bun run scripts/limited.ts timeout 60s /usr/bin/python3 experiments/codex-no-home-socket-probe.py
```

The fixture requires the already copied executable at `/var/tmp/orbit-codex-candidate-review/app/ChatGPT` and checks it is not the installed executable. A fixed bootstrap inside `bwrap` installs Landlock after mount setup. Its pathname policy grants only the exact disposable X11 socket and the private `/tmp` and runtime directories. It does not grant the HOME directory. A small `LD_PRELOAD` fixture records pathname UNIX `bind` and `connect` calls whose target begins with the disposable HOME path.

Two bounded runs completed. In the 25 second run, the policy marker was written, the copied Desktop stayed alive, and one X window was mapped. In the second run, its mapped window class was `Chatgpt`. The tracer recorded nine calls to `$HOME/.codex/ipc/ipc.sock`. The first three `connect` calls returned `ENOENT` because the socket did not yet exist. Subsequent `bind` and `connect` calls succeeded. No HOME socket call returned `EACCES`. The app log showed an offline error in the longer run, as expected with the network disabled.

The related [directory grant probe](private-unix-socket-landlock-probe.py) ran a closer shared project layout. With the project mounted inside private HOME and no HOME socket grant, a child-created HOME socket and the exact allowed host socket connected, while a late socket created by the host in the shared project returned `EACCES`. An atomic file save remained visible on the host. Granting the HOME directory instead allowed the late host socket. This indicates that a broad HOME grant is unnecessary for the measured own-socket behavior and unsafe for the current nested project bind.

These results establish initial launch behavior for this copied build and synthetic socket behavior for the nested project layout. They do not measure sign-in, existing chats, tool execution, extended app use, or every Electron and GTK socket path. The preload tracer observes calls through the wrapped libc functions and cannot prove that no other socket mechanism was used. Production still uses abstract socket scoping for desktop mounts; this fixture changed no production policy.
