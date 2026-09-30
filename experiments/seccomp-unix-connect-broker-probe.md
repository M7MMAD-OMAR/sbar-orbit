# Seccomp broker for selected pathname UNIX connects

Status on 29 September 2026: synthetic proof of mechanism, not a production
socket policy. It did not start or modify a personal app, account, browser,
profile, window, or session.

The earlier [Landlock fixture](native-nested-mount-landlock-conflict.md) proved
that a strict pathname socket rule blocks nested Bubblewrap mounts. This
experiment asks whether an external broker can intercept `connect(2)` while
the application retains its ability to mount a nested sandbox.

Run the [fixture](seccomp-unix-connect-broker-probe.c) through its
[runner](seccomp-unix-connect-broker-probe.sh) under the Orbit resource limit:

```sh
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh naive
```

The fixture creates two disposable host UNIX stream sockets and an outer
Bubblewrap mount. The selected socket is bind mounted at a private `/tmp`
path. The other host socket remains visible under `/var/tmp`. A seccomp user
notification filter intercepts `connect(2)` in the child and its descendants.
The external broker copies the child's `sockaddr_un`, duplicates its socket
descriptor with `pidfd_getfd`, and performs the selected connection on that
same socket object. It uses a pinned `O_PATH` descriptor to the selected
socket, addressed through `/proc/self/fd`, so a later path mount in the child
cannot redirect the broker to a different socket. All other intercepted
connections receive `EACCES` in this fixture.

The extended fixture also creates a host UNIX datagram socket and attempts
`sendto(2)` and `sendmsg(2)` to it. The broker still intercepts only
`connect(2)`. The runner accepts `naive` to replace the pinned descriptor
with a lookup through the notifying process's mount namespace. Both arms
were run on 30 September 2026. Measured pinned output:

```text
blocked_visible=1
broker_mode=pinned
selected_result=0 selected_errno=0
blocked_result=-1 blocked_errno=13
blocked_sendto_result=1 blocked_sendto_errno=0
blocked_sendmsg_result=1 blocked_sendmsg_errno=0
nested_selected_result=0 nested_selected_errno=0
nested_exit=0
selected_accepts=2 blocked_accepts=0
blocked_datagrams=2
probe_exit=0
```

The nested Bubblewrap mount deliberately puts the blocked host socket over
the selected path in its own namespace. The broker still connects to the
original selected socket. The selected server accepted both connections;
the blocked stream server accepted none. In the `naive` arm, the same nested
connection was diverted to the blocked host socket: the selected server
accepted once and the blocked server accepted once. The datagram server
received two messages in both arms. The path race therefore needs the pinned
socket identity, and a `connect(2)` filter alone leaves working bypasses.

This establishes a way past the specific Landlock mount conflict for
`connect(2)` on this host, including a child launched inside nested
Bubblewrap. It does not establish full pathname UNIX isolation. The filter
does not yet intercept `sendto(2)`, `sendmsg(2)`, or `io_uring` operations,
nor does it support abstract sockets, dynamically created private sockets,
nonblocking semantics, network sockets, or every architecture. The broker's
handling of app shutdown, PID reuse, thread races, listener failure, descriptor
exhaustion, and socket replacement needs production design and tests. The
fixture is limited to x86_64, UNIX stream sockets, one selected socket, and
two short lived connections. App login, existing sessions, chats, files, and
devices were not measured.

The [Linux seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html)
documents user notification and warns that syscall filtering alone is not a
complete sandbox. The
[pidfd_getfd manual](https://man7.org/linux/man-pages/man2/pidfd_getfd.2.html)
documents that a duplicated socket descriptor refers to the same underlying
socket object. This prototype uses that property to avoid resuming an
untrusted `connect(2)` pointer after a policy check.
