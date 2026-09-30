# Installed Loupe through the experimental socket broker

Status on 30 September 2026: the baseline broker opens Loupe but fails to load
the generated PNG. The opt-in loopback and broker-created pair modes together
now render that one generated PNG, matching the direct private-display control.
Current application state and production integration remain unproved. The
stages below retain the failures that established the regression.

The [harness](seccomp-loupe-app-probe.ts) creates a normal Fedora backend session
and uses only that owned display environment. It checks the private compositor,
bus and XDG config/data roots before launching `/usr/bin/loupe`. Its PNG is a
generated 600 by 360 image with green and blue halves in a disposable directory.
It copies no personal application profile and opens no personal image file.
The backend's existing appearance/preference snapshot still applies; complete
current application state parity is not measured.

Installed RPM versions measured here: Loupe 50.0-1.fc44, bubblewrap 0.12.0-1.fc44
and glycin-libs 2.1.5-1.fc44, all x86-64. This is the installed executable, not a
Python GTK replacement.

```sh
ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_DETAILS=1 ORBIT_LOUPE_BROKER_AUDIT=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
```

## Measured result

The brokered window title was `orbit-generated-halves.png`. Its frame displayed
the image-load failure and a More Information button. Opening that button only
inside the owned display showed a loader-process exit status 1, with a
`bwrap --unshare-all` command launching
`/usr/libexec/glycin-loaders/2+/glycin-image-rs --dbus-fd 15`.
The compositor stayed operational, and closing the owned modal and application
ended the final measurement normally: application exit 0, broker failure 0,
five approved connections, one private-bus credential forward and five data
forwards. None of those numbers establishes successful image loading.

The control used another fresh owned display without the experimental broker.
Its frame visibly contained the green and blue halves. The harness also checks
two known interior frame positions, (480, 400) and (800, 400), against broad
green/blue RGB bounds. The brokered error frame failed that color check; the
control image frame passed it. This deliberately measures one image at the
default 1280 by 800 private viewport, not arbitrary image rendering or every
viewport size. The saved full frames provide separate visual evidence.

The optional broker audit prints only denied syscall number, FD number, process
name, errno, socket domain/type/protocol, peer address length, netlink message
type and whether the socket network namespace differs from a fresh broker-side
reference socket. It prints no message payload, pathname, credential value or
netlink namespace cookie. It is disabled unless
`ORBIT_PRIVATE_BROKER_AUDIT=1`; the harness sets this only for the audit arm.

Two denied calls from `bwrap` had this shape:

```text
syscall=44 fd=5 comm=bwrap errno=13 domain=16 type=3 protocol=0 peerBytes=12 nlType=20 differentNetns=1
```

On this x86-64 build that is `sendto`, EACCES, `AF_NETLINK`, `SOCK_RAW`,
`NETLINK_ROUTE`, and `RTM_NEWADDR`. It is not an unnamed UNIX socket pair.
The network namespace cookie comparison establishes a different socket network
namespace; it does not establish ownership of that namespace or authorize any
network mutation there.

[The upstream bubblewrap 0.12.0 network implementation](https://raw.githubusercontent.com/containers/bubblewrap/v0.12.0/network.c)
configures loopback with `RTM_NEWADDR` and then `RTM_NEWLINK` after creating its
network namespace. The observed denied message is consistent with that first
operation. This identifies a necessary failure to address; it does not prove
that no later loader, private IPC or file-descriptor problem remains. That
baseline added no netlink allowance or sandbox-disable workaround.

## Opt-in private loopback transport

The follow-up arm uses `ORBIT_LOUPE_BROKER_LOOPBACK=1`, which enables
`ORBIT_PRIVATE_BROKER_LOOPBACK=1` only in this experimental launcher. It copies
and validates the two exact loopback messages used by the measured bubblewrap
version: a 40-byte `RTM_NEWADDR` for interface 1, IPv4 127.0.0.1/8, permanent
host scope, with exactly the local/address attributes and create/exclusive/ack
flags; and an attribute-free `RTM_NEWLINK` setting only `IFF_UP` on interface 1.
The destination must be the kernel, with no groups, padding or send flags.
The message PID must equal the duplicated socket's bound netlink port ID.

The FD must be an `AF_NETLINK` raw `NETLINK_ROUTE` socket whose network namespace
cookie differs from a broker-side reference recorded before launching the
application. The notifying task's current network namespace must also differ
from the broker's namespace. The broker sends its own validated copy through
that duplicated FD; it does not continue a mutable application buffer. Its
kernel response remains on the application's socket. This does not enter the
application's network namespace or mutate the broker's own network socket.

```sh
ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_LOOPBACK=1 ORBIT_LOUPE_BROKER_AUDIT=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
ORBIT_LOOPBACK_CONTROLS=1 bun run scripts/limited.ts bun run experiments/seccomp-loopback-controls.ts
ORBIT_LOOPBACK_CONTROLS=1 ORBIT_LOOPBACK_UNFIXED_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-loopback-controls.ts
```

The [controls](seccomp-loopback-controls.ts) use disposable fixtures. A valid
loopback address message on a host-namespace socket was denied with EACCES and
zero forwards. In a fresh `bwrap --unshare-all` namespace, its two setup messages
were forwarded and the fixture started. Nine modified cases were denied with
EACCES: wrong address, address interface, address flags, message type, extra
data, userspace destination, link interface, link flags and link change mask.
The unfixed control disables the opt-in route: bubblewrap then exits 1 with
`Failed RTM_NEWADDR: Permission denied` before the private fixture starts,
with zero forwards. The host message remains denied in both arms.

Loupe's opt-in run forwarded four loopback messages and reached the actual
`glycin-image-rs` process. Its next denied call was `sendmsg` on an unnamed
`AF_UNIX` stream socket, with peer address length 2. The displayed image still
failed the green/blue check. The application and broker exited 0 without forced
termination, with five approved connections, one bus credential forward and
five bus data forwards. Artifacts are in
`output/seccomp-loupe-loopback-2026-09-30/`.

The loopback-only arm closes the measured loopback setup failure only. It does not establish
that the FD's namespace is the notifying task's namespace, prove ownership of
every foreign namespace, or handle arbitrary netlink messages, private socket
pairs, large messages or application identity. Borrowed foreign namespace FDs,
namespace transitions and adversarial races remain unmeasured. The route is
disabled by default and is not deployed to the managed service or personal
applications. The original synthetic `broker-disconnect` arm still exited 0
with its existing denial, thread, FD reuse and disconnect controls intact.

## Broker-created private pairs

`ORBIT_LOUPE_BROKER_PAIRS=1` enables `ORBIT_PRIVATE_BROKER_PAIRS=1` in the
experimental launcher. The filter now notifies `socketpair` calls in this mode.
The broker creates only protocol-0 UNIX stream or sequenced-packet pairs,
preserves the requested nonblocking and close-on-exec flags, and injects both
endpoints through
[SECCOMP_IOCTL_NOTIF_ADDFD](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html).
It records both kernel `SO_COOKIE` values. An existing FD number or a generic
unnamed socket is not sufficient for admission.

Before injection, the broker opens the notifying target's `/proc/<tid>/mem`,
revalidates the live notification, and checks the output array through that
handle. It writes the result through the same handle after revalidating again.
The [proc memory interface](https://man7.org/linux/man-pages/man5/proc_pid_mem.5.html)
requires ptrace access. The
[upstream kernel implementation](https://raw.githubusercontent.com/torvalds/linux/v6.19/fs/proc/base.c)
stores the opened memory context in the file, so these result writes do not
re-resolve a numeric PID. This is not a proof of transactional cancellation or
every user-memory mapping semantic.

The target launcher closes all inherited FDs above stderr before executing the
application in pair mode. The recorded pairs may send copied messages through
the existing bounded `sendmsg` route and null-destination `send` route. Their
registered endpoints may be delegated with `SCM_RIGHTS` over another registered
pair only. Device and other socket rights remain denied. Regular file/pipe
rights keep the pre-existing policy. The copied limits remain 4096 payload
bytes, eight iovecs, four rights and the two supported send flags.

The first pair arm allowed streams only. It then found the loader's legitimate
sequenced-packet creation requests. After admitting that type, the next failure
was plain pair data; after that route, Loupe's delegation of a registered
endpoint was still denied. Reports retained in the pair output directory are
`before-seqpacket.json`, `before-pair-plain-data.json` and
`before-pair-rights.json`. Those stages all failed the image color check.

```sh
ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_LOOPBACK=1 ORBIT_LOUPE_BROKER_PAIRS=1 ORBIT_LOUPE_BROKER_AUDIT=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
ORBIT_PAIR_CONTROLS=1 bun run scripts/limited.ts bun run experiments/seccomp-pair-controls.ts
ORBIT_PAIR_CONTROLS=1 ORBIT_PAIR_UNFIXED_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-pair-controls.ts
```

With all three pieces, installed Loupe visibly rendered the green/blue PNG. The
frame positions measured RGB (24,179,75) and (25,76,230), matching the control's
color check. A final run after pinning the result memory handle again passed:
application exit 0, no forced stop, no broker failure, five approved
connections, one bus credential forward, five bus data forwards, four loopback
forwards, five created pairs and thirteen pair message forwards. Artifacts are
in `output/seccomp-loupe-loopback-pairs-2026-09-30/`. The loader's nested sandbox
was retained; no image-loader sandbox was disabled.

The [pair controls](seccomp-pair-controls.ts) proved exact stream bytes `AB`,
plain bytes `G`, separate sequenced-packet messages `CD`/`EF`, and delegation
bytes `FZ`. Nonblocking and close-on-exec flags were preserved. Oversized data,
unsupported send flags, device rights, unregistered socket rights, a reused FD
number and datagram creation were denied with EACCES. The receiver got EAGAIN
instead of any rejected payload. An invalid output array returned EFAULT before
creation. The bounded registry accepted 128 pairs total, including 125 closed
extra pairs after the first three, and rejected the next creation. Closing a
pair does not reclaim that session's registration slot. The unfixed control
leaves pair mode off: its initial `sendmsg` fails with EACCES and zero registered
pairs. The original synthetic `broker-disconnect` arm still passed unchanged.

The pairs are created in the broker's socket namespace and carry its peer
credentials, not the original target's identity. Injection of two descriptors
and writing the result array is not atomic; partial failure, interruption,
read-only/mutating output mappings and resource-pressure recovery remain
unmeasured. Cancellation can leave an injected private FD even when the call
fails. Registry lifetime, larger messages, other pair types and complete kernel
ABI parity are unsupported. The mode is disabled by default and remains outside
production. These limits prevent claiming arbitrary application compatibility
or full isolation from the successful one-image measurement.

## Send buffer pressure control

The successful image did not exercise a full outgoing socket buffer. The
single broker handler previously forwarded copied payloads without adding
`MSG_DONTWAIT`. A blocking application's send could therefore stop that handler
inside `sendmsg` or `send`, preventing the launcher's outer deadline from being
checked. The [pressure controls](seccomp-send-pressure-controls.ts) reproduced
both cases against the unfixed source before changing it. A private stream pair
with a requested 4096-byte send buffer accepted 8128 bytes of nonblocking fill
data. The next one-byte send with flags zero stalled until the independent
2.5-second watchdog killed only that experiment's target process group and
broker. Both broker exits were 137 and neither produced its final status JSON.

```sh
# Run on the unfixed source to verify the watchdog observes the stall.
ORBIT_SEND_PRESSURE_CONTROLS=1 ORBIT_SEND_PRESSURE_EXPECT_STALL=1 bun run scripts/limited.ts bun run experiments/seccomp-send-pressure-controls.ts
# Run on the fixed source to require prompt EAGAIN and successful later traffic.
ORBIT_SEND_PRESSURE_CONTROLS=1 bun run scripts/limited.ts bun run experiments/seccomp-send-pressure-controls.ts
```

All copied outbound send operations now add `MSG_DONTWAIT`, including private
bus/pair data, connected `sendmsg`, explicit selected datagrams and the bounded
loopback netlink relay. They do not set `O_NONBLOCK` on the duplicated shared
file description. The [Linux send documentation](https://man7.org/linux/man-pages/man2/send.2.html)
specifies that this flag applies to one call and returns EAGAIN/EWOULDBLOCK
instead of waiting for space. This is an explicit experimental ABI difference:
a target using a blocking FD can receive EAGAIN. Transparent blocking behavior
would require a cancellable queue/retry design and remains unsupported.

After the change, both pressure controls exited 0 without the watchdog. The
full-buffer calls returned EAGAIN (11) in approximately 17 and 16 microseconds.
Both targets retained their blocking FD flag, drained exactly the original
8128 bytes without the rejected byte, and exchanged `Z` afterwards. The existing
pair bounds, descriptor delegation and denial controls passed. Installed Loupe
again rendered the expected green/blue PNG with exit 0, five private pairs,
thirteen pair message forwards and no forced stop or broker failure.

The saturation regression directly measures private stream `sendmsg` and plain
`send` only. Full selected-datagram and netlink queues, user-memory faults and
cancellation races remain unmeasured.
This change alone is not proof that the entire broker's deadline is bounded,
or that arbitrary application blocking semantics are preserved. The following
experiment addresses the previously unmeasured connect backlog case.

## Selected connect backlog pressure

The [connect pressure control](seccomp-connect-pressure-controls.ts) creates
only a disposable owned selected UNIX listener. Its backlog is one and two
fixture connections fill the pending queue; a third nonblocking fixture
connection confirms EAGAIN before the target launch. Against the unfixed source,
the broker's synchronous duplicated-FD `connect` then stalled. Its target
remained at `connecting` until the independent 2.5-second watchdog killed the
owned target process group and broker, exit 137 with no final broker JSON.

```sh
# Run on the unfixed source to observe the blocking connect regression.
ORBIT_CONNECT_PRESSURE_CONTROLS=1 ORBIT_CONNECT_PRESSURE_EXPECT_STALL=1 bun run scripts/limited.ts bun run experiments/seccomp-connect-pressure-controls.ts
# Require timeouts, unchanged FD flags, released workers and later connectivity.
ORBIT_CONNECT_PRESSURE_CONTROLS=1 bun run scripts/limited.ts bun run experiments/seccomp-connect-pressure-controls.ts
```

The experimental relay now executes the copied pinned-address connect in one
broker worker thread and waits with a 100-millisecond monotonic deadline. On
expiry, it requests deferred cancellation and joins the worker before releasing
the duplicated FD and stack request. The [GNU C library clocked join interface](https://sourceware.org/glibc/manual/2.41/html_node/Waiting-with-Explicit-Clocks.html)
supports `CLOCK_MONOTONIC`; [Linux pthread cancellation documentation](https://man7.org/linux/man-pages/man7/pthreads.7.html)
lists `connect` as a cancellation point. No socket flags or timeouts are changed
on the application's shared file description. The worker remains in the same
broker process, preserving the experiment's existing broker PID semantics for
private bus peer credentials.

The fixed blocking target made eight sequential attempts against the full
queue. All returned ETIMEDOUT (110) in 100.4 to 101.2 milliseconds, retaining
blocking FD flags. After each cancellation the broker had one thread; its FD
count remained five before and after the attempts. The nonblocking target
returned EAGAIN (11) in approximately 0.42 milliseconds and retained its
nonblocking flag, also leaving one broker thread and five FDs. Both controls
then drained the two fixture connections and successfully connected a fresh
target socket, delivered exact `AB` bytes and exited 0 without the watchdog.
Installed Loupe again rendered the expected green/blue PNG and exited 0 with
five approved connections, five created pairs, thirteen pair message forwards,
no forced stop and no broker failure. The earlier disconnect and send-pressure
controls passed after the worker change, as did type checking.

The 100-millisecond limit is experimental, not transparent indefinite blocking
behavior. Deadline expiry racing with successful connection can leave that
socket connected while returning a timeout and without registering its cookie.
Only the pinned approved destination can be affected. The final cancellation
join has no separate hard deadline: the observed local UNIX backlog waits were
cancellable, but arbitrary kernel waits, user-memory faults and other
notification operations remain unmeasured. This does not establish a globally
bounded broker or justify production integration by itself.

## Verification and limits

Artifacts are in `output/seccomp-loupe-2026-09-30/` and
`output/seccomp-loupe-control-2026-09-30/`: JSON report, full frame and stderr,
plus the brokered details frame. Multiple brokered runs retained the loading
failure. A first details run closed only the modal and required a scoped
process stop; the harness now closes the remaining owned app window as well,
and subsequent runs exited normally.

An attempted optional strace run failed because `/usr/bin/strace` was absent;
that attempt did not measure the application. It was replaced with the broker
metadata audit. Initial type checking exposed the broad `Bun.spawn` return type
used for the saved process variable; the actual spawn result is now narrowed
before reading its output streams. Type checking and `git diff --check` passed.
The original synthetic `broker-disconnect` arm also exited 0 after adding the
audit, with its existing blocked endpoint, FD reuse, thread and disconnect
controls intact. The audit changes diagnostics only, not admission policy.

The harness launches through the experimental C wrapper using an owned backend
environment, not the production session launch action. The direct control does
not disable the managed service or change production policy. The private bus
still reports the broker PID in brokered mode. Accounts, conversations, current
Loupe state, personal files, devices, arbitrary formats and full outbound
isolation remain unproved. Every private compositor and experiment process was
closed after the measurement.
