# Installed Loupe through the experimental socket broker

Status on 30 September 2026: the installed Loupe window opens through the
experimental broker, but it cannot load the generated PNG. The direct control
on a fresh Orbit-owned display loads the same generated image. Brokered image
viewing is failed, not passed by the application's normal exit.

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
that no later loader, private IPC or file-descriptor problem remains. No netlink
allowance or sandbox-disable workaround was added.

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
