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

## Limits

The GTK client is launched by the experimental C program using the owned
backend environment, not by Orbit's production `session.act` launch action.
This does not establish the production launch boundary. The transport still
has the synthetic probe's limits: only bounded selected stream messages and
file descriptors are admitted; private socket pairs, larger messages, other
rights, signal parity, cancellation and slow peers need further work. Only one
selected compositor socket is configured here, so account/keyring buses,
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
