# Installed Nextcloud Desktop through the private broker

Status on 30 September 2026: the installed Qt Nextcloud client rendered its
setup UI on the owned Orbit display. A new opt-in copied TCP route let it
discover a disposable loopback fixture and request the login-flow endpoint.
No existing native account, credential, sync folder or conversation was copied
or measured. This is not current-account parity or production integration.

## Setup and independent control

[The harness](seccomp-nextcloud-app-probe.ts) runs installed
`/usr/bin/nextcloud`, reported by its own log as `34.0.3daily`, on an owned
Fedora backend with its private Wayland display and bus. It supplies a disposable
home and configuration, using the documented
[`--confdir` and `--logfile` options](https://docs.nextcloud.com/server/stable/user_manual/de/desktop/options.html).
It does not read the original Nextcloud configuration, keyring or sync folders.
All commands run inside the shared resource budget, one at a time.

The direct control and the default experimental broker both displayed the same
setup screen. Their retained 1280 by 800 JPEG files had identical SHA256
`3d5e9f493aba7bf108b6b77d871087dd5aef323086dee9001fffcf7b24b95693`.
The initial inline rendering was misread as blank; inspecting the actual files
corrected that interpretation. A later eight-second startup observation again
matched. An optional Qt software-rendering diagnostic also opened the window,
but changing the rendering mode was not required for the successful TCP run.

One original Nextcloud process was present before each run and the same PID was
still present afterwards. Closing the test setup window left its background
client alive, so the harness scoped its stop to that spawned process or the
wrapper's owned child group. Direct control exited 143; the broker wrapper
reported its generic signalled application status 128, `stopped: 1` and no
broker failure. These are controlled stops, not normal application exits or
proof that every operation left the original client unaffected.

## Network failure before the new route

The network arm binds its own HTTP fixture to `127.0.0.1` on an ephemeral port.
It returns generated Nextcloud status JSON at `/status.php`; all other paths
return HTTP 503. It never issues a login URL, token or redirect and cannot
authenticate or start sync. Only request methods and paths are retained.

The first direct attempts exposed two harness issues rather than isolation
failures: the client could upgrade the entered address to HTTPS and display a
retry-without-TLS dialog, and typing immediately after a click could miss input
focus. The harness now waits between focus, text and submission, retaining an
entered-address frame. In direct control it uses the observed dialog to retry
this credential-free local fixture without TLS. This does not apply to a real
account. The verified direct run then recorded:

- GET `/status.php`
- GET `/`
- PROPFIND `/remote.php/dav/files//`
- POST `/index.php/login/v2`

The brokered run before the TCP route recorded zero fixture requests. Its
entered-address frame showed the correct local URL and its GUI reported a
connection failure. The application log recorded `Permission denied` for the
status request. The broker audit identified denied `connect` notifications
from `QNetworkAccessM`, domain AF_INET, stream type, TCP protocol, EACCES (13).
This distinguishes a measured TCP policy failure from the earlier setup and
input issues. Artifacts remain in `output/seccomp-nextcloud-network-2026-09-30/`.

## Explicit selected TCP experiment

`ORBIT_PRIVATE_BROKER_TCP_PORT` enables exactly one IPv4 TCP destination:
`127.0.0.1` and the configured numeric port. The wrapper validates a decimal
port from 1 through 65535. It obtains a reference network-namespace cookie;
the broker checks the duplicated socket's kernel domain, stream type, TCP
protocol and matching namespace cookie before using a copied `sockaddr_in`.
The address length and zero padding must be exact. No mutable target sockaddr
is continued in the kernel, and no target namespace is entered.

The existing cancellable connect helper now accepts a bounded copied socket
address and explicit length. It retains the 100-millisecond monotonic deadline
and leaves shared FD flags unchanged. Successful or EINPROGRESS TCP attempts
register the kernel socket cookie in a separate 32-entry registry. That count
is registered attempts, including pending connects, not proof of completed
connections by itself. Copied sends accept only registered TCP cookies with
the existing 4096-byte and eight-vector bounds and supported flags. TCP
ancillary data is denied. Normal `write` and `writev` remain unmediated, which
the real client used here; zero copied TCP send forwards does not mean no data
was sent. Socket authority comes from the approved copied connect in this arm,
not inspection of every subsequent byte.

```sh
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 ORBIT_NEXTCLOUD_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 ORBIT_NEXTCLOUD_BROKER_TCP=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
ORBIT_TCP_CONTROLS=1 bun run scripts/limited.ts bun run experiments/seccomp-tcp-controls.ts
ORBIT_TCP_CONTROLS=1 ORBIT_TCP_UNFIXED_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-tcp-controls.ts
```

The installed client with the TCP arm recorded the same four requests as direct
control. Its startup image retained the same hash, its broker registered four
TCP attempts, and it reached the fixture's deliberate HTTP 503 login failure.
Five private UNIX connections, one private bus credential forward and five bus
data forwards were recorded. No socket pairs or loopback netlink messages were
needed by this client. The original process remained present. Artifacts are in
`output/seccomp-nextcloud-network-tcp-2026-09-30/`.

[TCP controls](seccomp-tcp-controls.ts) measured exact echo bytes `AB`, plain
`C`, and nonblocking `EF`. EINPROGRESS (115) completed with SO_ERROR zero and
the nonblocking flag was preserved. Exactly two connections reached the
selected fixture and zero reached a separately owned blocked port. Other
ports, another loopback address, UDP connect/sendto, TCP descriptor rights,
oversized data, unsupported flags and reuse of an old numeric FD were denied
with EACCES. No rejected payload reached the echo receiver. With the TCP arm
disabled, the first selected connect returned EACCES and neither server
accepted a connection.

After the generalized copied-address helper and TCP changes, the existing
eight-attempt connect-pressure control, private pair transport/rights/bounds
controls and original `broker-disconnect` fixture passed. Type checking and
`git diff --check` passed. No full production-suite claim is made for this
experimental change.

## Limits

This route is disabled by default and exists only in the experimental wrapper.
It is one numeric loopback endpoint, not Internet connectivity, DNS, remote
TLS, IPv6, general UDP, current-account login, token refresh or native sync.
Port reuse after the selected server closes is not pinned like a UNIX O_PATH
endpoint. The measured harness keeps its server bound until scoped cleanup;
adversarial port rebinding, borrowed descriptors, concurrent target memory
mutation and notification cancellation races remain unmeasured. Existing
private-bus PID normalization, arbitrary inherited/accepted descriptor
authority, filesystem authority and full outbound isolation are not solved.
The connect cancellation join still has no separate hard deadline. These
limits prevent treating the successful fixture discovery as full application
compatibility or as permission to expose the person's own services.
