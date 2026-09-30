# Real GTK client through the experimental socket broker

Status on 30 September 2026: a disposable real GTK3 client rendered and accepted
Orbit keyboard input on an owned private Wayland compositor through the
experimental seccomp broker. This is not a production launcher or evidence of
account, conversation, file or device parity.

The [harness](seccomp-wayland-app-probe.ts) creates a Fedora session through the
normal session dispatcher, then reads only that owned backend's private display
environment. It rejects an endpoint outside `/tmp/orbit-native-*/wayland-N` and
forces GTK's Wayland backend. The [C launcher](seccomp-wayland-app-probe.c)
reuses the transport from the synthetic socket probe. It pins one owned Wayland
socket with `O_PATH`, installs the inherited filters before executing the GTK
client, and admits that exact pathname through the pinned identity. The
synthetic fixture's default selected pathname is retained for its existing arms.

The GTK window contains one entry. Orbit's private keyboard types a fixed ASCII
phrase into it. Its change callback writes the text to an owned disposable file;
the harness compares the exact bytes and captures the private window. The GTK
client quits after 18 seconds. Its experimental launcher owns and cleans up one
process group; the normal backend owns and closes the compositor separately.
No personal app profile, existing conversation or account credential is used.

```sh
ORBIT_WAYLAND_BROKER_PROBE=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
```

Two brokered runs before the direct control showed the real window, exact typed
text, application exit 0, broker failure 0 and one approved Wayland connection.
Their generated stderr was empty. The second added a disposable UNIX stream
server outside the selected endpoint. The same client attempted to connect to
it before opening its GTK window. The client received EACCES (13) and the
listening server accepted no connections.

The direct control runs the same trusted disposable GTK client in a fresh owned
private display environment without the experimental broker. It also rendered
and accepted the exact keyboard text, but its attempt to connect to the
disposable server succeeded and that server accepted one connection. Thus the
blocked result is not explained by a missing server or a broken client test.
This control does not disable the managed service or its production policy.

The final brokered run also passed after restricting the launcher to a
canonical socket path under one private runtime directory, checking that
directory's owner and private permissions, and disabling the unconfigured
datagram route. The window was visible, the exact text matched, the application
and launcher exited 0, the broker reported no failure, and the denied server
again accepted zero connections. The generated stderr was empty.

Local report, frame and stderr artifacts are in ignored output directories:
`output/seccomp-wayland-app-2026-09-30/` and
`output/seccomp-wayland-app-control-2026-09-30/`.
The C launcher compiled with `-Wall -Wextra -Werror`, and type checking passed.
An initial harness run stopped before session creation because a local variable
shadowed Node's process object; that was corrected before the measured runs.

## GTK4 image and input measurement

The same harness has a GTK4 arm, selected with
`ORBIT_WAYLAND_BROKER_GTK4=1`. It uses the installed GTK 4.22.5 Python bindings,
creates a disposable 240 by 120 PNG with green and blue halves, and opens it
through `Gtk.Picture.new_for_filename`. The picture's paintable reports its
intrinsic dimensions after loading; a frame provides separate visual evidence.
Neither the image nor the entry contains personal content.

```sh
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 ORBIT_WAYLAND_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
```

On 30 September 2026 both arms displayed the image, reported a loaded paintable
with width 240 and height 120, accepted the exact ASCII keyboard text, and exited
0. The brokered arm reported four approved compositor connections and no broker
failure. Its denied server received zero connections and the client received
EACCES. The direct arm connected successfully to the same kind of disposable
server, which accepted one connection. Artifacts are in
`output/seccomp-wayland-app-gtk4-2026-09-30/` and
`output/seccomp-wayland-app-gtk4-control-2026-09-30/`.

Both arms emitted theme parser, Vulkan surface and Mesa device warnings despite
the visible frame. Thus these runs do not attribute those warnings to the
experimental broker or prove accelerated rendering. The brokered arm also
reported inability to acquire its session bus, with permission denied; the
direct arm instead reported an unavailable accessibility bus service. Session
bus and accessibility parity are not established. No warnings were suppressed.
Type checking passed after adding this arm.
The original brokered GTK3 arm was rerun after the shared harness changes: the
window and exact text still succeeded, the process exited 0, the broker reported
one approved connection and no failure, and the blocked server accepted zero
connections.

This measures GTK4's public filename image path for one generated PNG. It does
not establish which loader implementation or sandbox process handled it, nor
prove glycin, every image format, or arbitrary nested sandbox compatibility.

## Private session bus and listener handoff

`ORBIT_WAYLAND_BROKER_BUS=1` adds exactly the owned backend's `bus` socket as a
second pinned stream endpoint. The harness requires its address to equal
`unix:path=<this private runtime>/bus`; the launcher requires its canonical
pathname to be in the same private directory as the compositor. The person's
session bus is never used. With this flag absent, no second endpoint is allowed.
The synthetic probe retains its original selected endpoint and default policy.

The client now attempts `Gio.bus_get_sync` and the bus's `GetId` method with a
3-second call timeout, writing only connection status and whether a 32-character
ID was returned. No bus ID, account data or credential content is saved.

```sh
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 ORBIT_WAYLAND_BROKER_BUS=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 ORBIT_WAYLAND_BROKER_BUS=1 ORBIT_WAYLAND_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
```

The measurement before admitting the bus failed with permission denied at
connection, while GTK4 still displayed and accepted input. Admitting its pinned
socket moved the failure to sending credentials. The first such run also failed
to initialize GTK and exited 1. That run's report and traceback are retained as
`before-handoff-fix.json` and `before-handoff-fix-stderr.txt` in the bus output
directory.

The owned-display launcher formerly handed its seccomp listener to the parent
with a `sendmsg` exception on one FD number, then permanently denied that number.
Opening the additional bus exposed a legitimate reuse conflict. The launcher
now writes the listener's number, waits for an acknowledgement, and the parent
duplicates the listener with `pidfd_getfd` while the child holds it open. The
filter has no `sendmsg` handoff exception and no reserved application FD number.
This changes the real-client experiment only; the synthetic fixture retains its
explicit numeric-reuse negative control.

After that change, the same bus arm displayed GTK4, showed the PNG, accepted the
exact text, and exited 0. It reported nine approved connections, no broker
failure, and zero accepts at the blocked server. Bus authentication still failed
with `Error sending credentials: Error sending message: Permission denied`.
The direct control on a fresh owned display connected and completed `GetId`,
displayed the PNG and accepted text, and exited 0. Thus the private bus itself
was operational; admitting its socket did not establish brokered D-Bus support.

Artifacts are in `output/seccomp-wayland-app-gtk4-bus-2026-09-30/` and
`output/seccomp-wayland-app-gtk4-bus-control-2026-09-30/`. At that stage the transport
admitted only `SCM_RIGHTS` ancillary messages, so it rejected explicit
`SCM_CREDENTIALS`. [Linux's UNIX socket documentation](https://man7.org/linux/man-pages/man7/unix.7.html)
also distinguishes connection peer credentials from message credentials and
describes kernel restrictions on sending another PID. A future implementation
must resolve these semantics before claiming application or service identity
parity. That first bus stage added no credential rewrite or extra ancillary policy.
After the handoff change, the no-bus GTK3 arm still displayed and accepted the
exact keyboard text, exited 0, and denied the blocked endpoint. The synthetic
`broker-disconnect` arm also exited 0 with its original stream, rights, thread,
FD reuse, nested-path and disconnect controls intact. Type checking passed.

## Explicit private bus credential mode

An additional opt-in, `ORBIT_WAYLAND_BROKER_BUS_CREDENTIALS=1`, admits one
bounded initial credential message per approved private bus socket. It requires
the bus flag above. This is an experiment with broker identity, not transparent
application identity and not an account/keyring bus policy.

The broker records the bus socket's `SO_COOKIE` separately from compositor
cookies. It copies and validates a single `SCM_CREDENTIALS` item with exactly
one NUL payload byte. The supplied PID must match the notifying thread's TGID
from `/proc/<tid>/status`, and the supplied real UID/GID must match that task and
the broker's real UID/GID. The broker emits its own kernel-valid credentials;
the server already sees its PID as the connection peer. A successful initial
message consumes that cookie's credential allowance. No mutable inspected
message is continued in the application.

The next measured failure was plain authentication data: GIO uses `send`, which
enters the intercepted `sendto` syscall with a null destination. The opt-in now
copies that route only for approved private bus cookies after their initial
credential message, with a maximum 4096 bytes and only `MSG_DONTWAIT` and
`MSG_NOSIGNAL`. Other destinations and socket pairs stay denied. Both routes
still execute in the broker and add `MSG_NOSIGNAL`; full client signal semantics
remain unproved.

```sh
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 ORBIT_WAYLAND_BROKER_BUS=1 ORBIT_WAYLAND_BROKER_BUS_CREDENTIALS=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
ORBIT_WAYLAND_BROKER_PROBE=1 ORBIT_WAYLAND_BROKER_GTK4=1 ORBIT_WAYLAND_BROKER_BUS=1 ORBIT_WAYLAND_BROKER_BUS_CREDENTIALS=1 ORBIT_WAYLAND_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-wayland-app-probe.ts
```

The new credential controls were run before implementing either route. The
valid credential case and GIO authentication both failed with EACCES. After the
credential route alone, the valid case sent one byte, but GIO failed at sending
data. Those reports are retained as `before-credential-route.json` and
`before-bus-data-route.json` in
`output/seccomp-wayland-app-gtk4-bus-credentials-2026-09-30/`.

With both routes, GIO connected and completed `GetId` and
`GetConnectionCredentials`. Its UID matched the application, its PID did not
match the application, and its PID matched the parent broker. The direct
control connected to its own private bus and reported the application's UID
and PID, with no parent-PID match. Only these comparisons are retained, not raw
credentials or bus IDs. Both arms displayed the PNG, accepted the exact text,
and exited 0. A measured brokered run reported 12 approved connections, three
credential forwards and ten data forwards, with no broker failure.

The broker denied wrong PID, UID, GID, non-NUL initial payload, repeated
credentials, oversized plain data, compositor credential and plain messages,
and unapproved socket-pair plain data with EACCES. The valid initial credential
message sent one byte. The direct control's kernel rejected wrong PID/UID/GID
with EPERM, while it accepted the non-NUL, repeat, oversized, compositor and
socket-pair payload controls. The blocked external disposable server still
received zero brokered connections and one direct connection.

The experiment is deliberately restricted to the disposable private bus. These
measurements do not authorize applying credential rewriting to the person's
services. Process-based authorization, credential transitions, namespace PID
mapping, every D-Bus operation and large D-Bus messages remain unmeasured.

### Strict barrier regression

Review found that replacing the listener handoff had also removed the second
strict filter from the real-client launcher. It is restored with the invalid
FD sentinel `-1`, so no valid application FD is reserved. The strict filter
denies `sendmmsg` and the listed io_uring entry points, while the listener
continues to broker selected `sendmsg` calls.

A disposable regression compiled the same current launcher twice, removing
only that strict-filter installation line in the unfixed control. Its client
called x86-64 `sendmmsg` on a valid owned socket pair with zero messages. The
unfixed control returned 0; the restored filter returned -1/EACCES. Both
launchers exited 0, with no broker failures. This establishes that the check
detects the missing barrier. A zero-message call is not evidence of a payload
escape, and io_uring bypass resistance is not established by this measurement.
The original synthetic `broker-disconnect` arm was rerun after these changes
and exited 0 with two connected messages, two rights, no unexpected bytes,
zero blocked accepts and no broker SIGPIPE. The no-bus GTK3 arm also still
displayed and accepted the exact text, exited 0, and reported zero credential
and bus-data forwards. Type checking and `git diff --check` passed.

## Limits

The [installed Loupe measurement](seccomp-loupe-app-probe.md) demonstrates why
the successful small GTK4 image case cannot stand for real application image
support: Loupe's nested glycin loader fails through this broker, while the
direct private-display control renders the same generated PNG.

The GTK client is launched by the experimental C program using the owned
backend environment, not by Orbit's production `session.act` launch action.
This does not establish the production launch boundary. The transport still
has the synthetic probe's limits: only bounded selected stream messages and
file descriptors are admitted; private socket pairs, larger messages, other
rights, signal parity, cancellation and slow peers need further work. Only the
selected compositor and, optionally, its private bus are configured, so account/keyring buses,
application owner sockets, shared audio and portals are not authorized by this
experiment. The client runs with disposable XDG state, not the person's current
application state. No claim about real account app compatibility is made.

Other GTK4 image paths, nested application sandboxes, GPU paths, non-ASCII entry,
physical devices and the person's existing application sessions were not
measured. Full outbound isolation remains unproved, including the inherited
connected-descriptor routes documented in the synthetic probe. The launcher
has a 30-second process limit but its synchronous broker operations are not
proven to obey that limit under an adversarial blocked syscall. No production
policy or managed service was changed or restarted by this work.
