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
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh strict
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh broker-dgram
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh broker-connected
# Deliberate negative control, expected exit 1:
bun run scripts/limited.ts timeout 20s bash \
  experiments/seccomp-unix-connect-broker-probe.sh strict-connected
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
`sendto(2)`, `sendmsg(2)`, and `sendmmsg(2)` to it. In the baseline and `naive`
arms the broker still intercepts only `connect(2)`. The runner accepts `naive`
to replace the pinned descriptor with a lookup through the notifying process's
mount namespace. The first two
arms were run on 30 September 2026. The baseline was rerun after adding the
`sendmmsg(2)` attempt. Measured pinned output:

```text
blocked_visible=1
broker_mode=pinned
selected_result=0 selected_errno=0
blocked_result=-1 blocked_errno=13
blocked_sendto_result=1 blocked_sendto_errno=0
blocked_sendmsg_result=1 blocked_sendmsg_errno=0
blocked_sendmmsg_result=1 blocked_sendmmsg_errno=0
nested_selected_result=0 nested_selected_errno=0
nested_exit=0
selected_accepts=2 blocked_accepts=0
selected_stream_broker_pid=1
selected_datagrams=0
blocked_datagrams=3
probe_exit=0
```

The nested Bubblewrap mount deliberately puts the blocked host socket over
the selected path in its own namespace. The broker still connects to the
original selected socket. The selected server accepted both connections;
the blocked stream server accepted none. `SO_PEERCRED` reported the broker PID
for both selected connections. In the `naive` arm, the same nested
connection was diverted to the blocked host socket: the selected server
accepted once and the blocked server accepted once. The datagram server
received three messages in the pinned baseline. The path race therefore needs
the pinned socket identity, and a `connect(2)` filter alone leaves working
bypasses.

The `strict` arm adds a second seccomp filter after the trusted child has sent
its notification listener to the external broker, before any target operation.
It returns `EACCES` for every `sendto(2)`, `sendmsg(2)`, and `sendmmsg(2)` call.
It also denies `io_uring_setup(2)` and `io_uring_enter(2)` to prevent either
new or inherited rings from submitting an uninspected connect or send. The
`io_uring` denial is a policy in the fixture, not a measured application result.
Measured strict output on 30 September 2026:

```text
broker_mode=pinned-strict
selected_result=0 selected_errno=0
blocked_result=-1 blocked_errno=13
blocked_sendto_result=-1 blocked_sendto_errno=13
blocked_sendmsg_result=-1 blocked_sendmsg_errno=13
blocked_sendmmsg_result=-1 blocked_sendmmsg_errno=13
nested_selected_result=0 nested_selected_errno=0
nested_exit=0
selected_accepts=2 blocked_accepts=0
selected_stream_broker_pid=1
selected_datagrams=0
blocked_datagrams=0
probe_exit=0
```

This closes the three measured direct datagram bypasses without breaking the
two selected stream connections in this short fixture. It cannot be applied
unchanged to real applications: it denies ordinary sends on already connected
sockets, including legitimate IPC. The listener handoff occurs before the
strict filter in trusted fixture code. Production startup would need to keep
untrusted application code from running during that interval. An inherited
connected socket can still be used through `write(2)` or `writev(2)`, and
other descriptor transfer paths need analysis. Neither real application
compatibility nor complete outbound isolation was measured.

The `broker-dgram` arm allows one bounded `sendto(2)` route to a selected
datagram socket. The first seccomp filter notifies the external broker for
`connect(2)` and `sendto(2)`. After listener handoff, a second filter denies
`sendmsg(2)`, `sendmmsg(2)`, `io_uring_setup(2)`, and `io_uring_enter(2)`.
The broker copies at most 4096 payload bytes and an explicit pathname from
the child, checks the notification ID, duplicates the child's socket, and
sends to a pinned descriptor for the selected datagram socket. It never
continues the original `sendto(2)` with a child-controlled pointer. A nested
Bubblewrap process bind mounts the blocked datagram socket over the selected
pathname and repeats the send. Measured output on 30 September 2026:

```text
broker_mode=pinned-datagram
blocked_sendto_result=-1 blocked_sendto_errno=13
blocked_sendmsg_result=-1 blocked_sendmsg_errno=13
blocked_sendmmsg_result=-1 blocked_sendmmsg_errno=13
selected_sendto_result=1 selected_sendto_errno=0
nested_selected_sendto_result=1 nested_selected_sendto_errno=0
selected_accepts=2 blocked_accepts=0
selected_stream_broker_pid=1
selected_datagrams=2 blocked_datagrams=0
selected_dgram_broker_pid=1
probe_exit=0
```

This arm admits an approved datagram destination while denying the three
measured sends to the blocked destination, including after the nested mount
changes the child's path lookup. Both selected datagrams carried the broker
process ID in `SCM_CREDENTIALS`. An application that checks sender credentials
could reject this route. It accepts only explicit pathname `sendto(2)` with
zero flags and a payload from 1 to 4096 bytes. Connected sends, `sendmsg(2)`
ancillary data, larger messages, abstract sockets, and real application
behavior remain unmeasured or unsupported. The sender credential difference
and these limitations prevent treating this as a production socket policy.
The [direct private mount fixture](namespace-unix-peer-credential-probe.md)
measures one route that preserves client process identity without a brokered
connection, but it does not isolate every host socket path.

## Bounded connected messages and file descriptors

The `strict-connected` negative control adds a selected stream connection and
attempts a two-byte, two-vector `sendmsg(2)` containing one `SCM_RIGHTS` pipe
descriptor. It was run before the connected-message implementation. The
connection succeeded, but `sendmsg` returned `EACCES`; the server received no
message or descriptor and the fixture exited 1. It was rerun after the changes
and still failed as expected. This measures the strict arm's IPC compatibility
failure rather than treating connection success as a usable IPC route.

The new `broker-connected` arm intercepts `sendmsg` in addition to `connect`
and `sendto`. After each selected stream connection, it records the kernel
`SO_COOKIE` of the duplicated connected socket. A later send is admitted only
when its current duplicated socket has an approved cookie. A descriptor number
alone is not authority. The broker copies the message header, up to eight
vectors and 4096 payload bytes into its own memory. It never resumes a syscall
with inspected child-controlled pointers. Ancillary data is limited to one
`SCM_RIGHTS` item holding up to four regular-file or pipe descriptors. Each is
duplicated from the notifying task, validated and closed after the broker send.
Socket and device descriptor transfers are denied in this arm.

The first filter permits the trusted listener-handoff `sendmsg` on its one
channel descriptor. A second filter permanently denies `sendmsg` on that
descriptor number before target operations start. Reusing that descriptor does
not reopen the handoff exception. This remains trusted fixture startup code,
not a production application launcher.

Measured final connected output on 30 September 2026 included:

```text
connected_sendmsg_result=2 connected_sendmsg_errno=0
oversized_sendmsg_result=-1 oversized_sendmsg_errno=13
device_rights_result=-1 device_rights_errno=13
unapproved_pair_result=-1 unapproved_pair_errno=13
handoff_reuse_result=-1 handoff_reuse_errno=13
descriptor_reuse_result=-1 descriptor_reuse_errno=13
thread_connected_sendmsg_result=2
x32_signal=31
selected_accepts=4 blocked_accepts=0
connected_messages=2 connected_rights=2 unexpected_stream_bytes=0
selected_datagrams=2 blocked_datagrams=0
probe_exit=0
```

The selected server received both exact `AB` messages and read the expected
`K` marker from both passed pipe descriptors, one from the main thread and one
from a worker thread. It received no trailing payload from the denied cases.
The nested mount replacement and the three direct blocked datagram sends
remained denied or pinned to their original selected destinations.

Two additional failures were reproduced before correction. A worker-thread
connection returned `EACCES` when the broker used a process-only pidfd. The
connected arm now opens the notifying task with `PIDFD_THREAD` rather than
guessing its process leader. This requires Linux 6.9 or newer, as documented
in the [pidfd_open manual](https://man7.org/linux/man-pages/man2/pidfd_open.2.html).
The final worker-thread message and descriptor transfer passed on this host.

An x32-marked `getpid` test was not rejected by the former filters, producing
`x32_signal=0` and a failing fixture. All fixture filters now reject the x32
syscall bit explicitly; the same test terminated with `SIGSYS` (31) and passed.
This test does not establish that an x32 connect bypass worked on this kernel.
The [seccomp manual](https://man7.org/linux/man-pages/man2/seccomp.2.html)
explains that x86-64 and x32 share the architecture identifier and need separate
syscall-bit handling. The runner disables core dumps for this intentional
signal test. Baseline, naive, strict and broker-dgram arms were also rerun.

This is still not a production isolation policy. Connected sends require zero
flags and no explicit destination; the map holds at most 32 approved cookies.
Unapproved socket pairs are denied, so ordinary application-created private
socket pairs need a separate design. Large messages, other ancillary types,
socket/device rights and nonblocking send semantics are unsupported. The
sender credential difference remains. Inherited connected sockets can still
send through `write` or `writev`; these changes do not close that route. Broker
blocking, cancellation, concurrent descriptor races, listener failure and
resource exhaustion need further design and adversarial tests. No personal
application, account, conversation or profile was launched or changed here.

This establishes a way past the specific Landlock mount conflict for
`connect(2)` on this host, including a child launched inside nested
Bubblewrap. It does not establish full pathname UNIX isolation. The baseline
filter does not intercept direct datagram sends. The strict arm denies them
broadly. The selected datagram arm supports one bounded route but does not
support abstract sockets, dynamically created private sockets, nonblocking
semantics, network sockets, or every architecture. The broker's handling of app
shutdown, PID reuse, thread races, listener failure, descriptor exhaustion,
and socket replacement needs production design and tests. The
original fixture is limited to x86_64, two selected sockets, two short lived
stream connections, and two selected datagrams. The connected arm adds the
bounded message, descriptor and thread checks above. App login, existing
sessions, chats, files, and devices were not measured.

The [Linux seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html)
documents user notification and warns that syscall filtering alone is not a
complete sandbox. The
[seccomp user notification manual](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html)
describes notification ID validation and the risk of continuing a syscall
after inspecting mutable arguments. The
[pidfd_getfd manual](https://man7.org/linux/man-pages/man2/pidfd_getfd.2.html)
documents that a duplicated socket descriptor refers to the same underlying
socket object. This prototype uses that property to avoid resuming an
untrusted `connect(2)` pointer after a policy check.
