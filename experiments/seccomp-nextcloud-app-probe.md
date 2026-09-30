# Installed Nextcloud Desktop through the private broker

Status on 30 September 2026: the installed Qt Nextcloud client rendered its
setup UI on the owned Orbit display. A new opt-in copied TCP route let it
discover a disposable loopback fixture and request the login-flow endpoint.
A later offline arm copied one existing account configuration without its sync
folders and visibly restored the cached account identity. A subsequent private
service delivered one existing unlocked account credential to the client.
An exact-CONNECT tunnel subsequently let the client authenticate and display
existing account activities. Sync and conversations remain unproved. This is
not full current-account parity or production integration.

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

## TLS fixture and certificate rejection

The next arm runs the same owned discovery fixture with TLS. The harness
generates a one-day RSA certificate and key inside its disposable private
directory, with an IP subject alternative name for `127.0.0.1`. Bun's TLS server
uses that certificate on its still-bound ephemeral port. No system certificate
store, original application configuration or real account is changed; the
generated private key is removed with the temporary directory and is not
retained as an artifact.

An initial direct trial set process-only `SSL_CERT_FILE` and `SSL_CERT_DIR`
paths, including an OpenSSL-hashed certificate directory. Nextcloud still
displayed its self-signed-certificate rejection and sent zero HTTP requests.
[OpenSSL documents those default trust paths](https://docs.openssl.org/3.3/man3/SSL_CTX_load_verify_locations/),
but the trial did not establish that this Nextcloud setup path used them. That
attempt is a recorded failure, not evidence of general Qt/OpenSSL behavior or
a broker fault. The final harness no longer sets those environment variables.

The successful arm instead uses Nextcloud's observed private certificate
dialog to accept the single generated fixture certificate in its disposable
application state. This is a certificate exception for the test server, not
automatic trust for arbitrary certificates or proof of public CA validation.
The direct control and brokered TCP arm then both recorded the same four
requests: GET status, GET root, PROPFIND and POST login/v2. Each recorded
request had the HTTPS scheme and arrived at the TLS-only fixture. No plaintext
fallback action runs in the TLS arm. The generated login endpoint still returns
HTTP 503 and never supplies authentication material or a browser URL.

The brokered successful TLS run registered six TCP attempts, no copied TCP
send forwards, five private UNIX connections and one bus credential forward.
The client used ordinary writes, as in the earlier HTTP measurement. Its setup
frame retained the same hash as direct control. The original Nextcloud PID was
still present and the test instance was stopped only within its owned scope.
The wrapper reported stopped status 128 and no broker failure. TLS version,
cipher suite, session resumption and mutual TLS were not recorded.

The negative arm does not accept the certificate. It still registered six TCP
attempts, but Nextcloud reported that the certificate was self-signed and
untrusted and the server received zero HTTP requests. This separates certificate
rejection from a denied network connect. The TLS assertion gate requires that
rejection to be present in the application log in both arms; the accepted arm
must additionally deliver HTTPS status and login-flow requests, while the
unaccepted arm must deliver no request. Both brokered assertion runs passed.
The direct accepted control was observed separately before adding the gate.

```sh
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 ORBIT_NEXTCLOUD_BROKER_TLS=1 ORBIT_NEXTCLOUD_BROKER_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 ORBIT_NEXTCLOUD_BROKER_TCP=1 ORBIT_NEXTCLOUD_BROKER_TLS=1 ORBIT_NEXTCLOUD_BROKER_TLS_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_NETWORK=1 ORBIT_NEXTCLOUD_BROKER_TCP=1 ORBIT_NEXTCLOUD_BROKER_TLS=1 ORBIT_NEXTCLOUD_BROKER_TLS_UNTRUSTED=1 ORBIT_NEXTCLOUD_BROKER_TLS_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
```

Artifacts are in `output/seccomp-nextcloud-network-tls-control-2026-09-30/`,
`output/seccomp-nextcloud-network-tls-tcp-2026-09-30/` and
`output/seccomp-nextcloud-network-tls-untrusted-tcp-2026-09-30/`: reports, the
generated-state UI frames and logs. The successful brokered run also retains
the certificate dialog frame before accepting the fixture. These files contain
test state only. Current-account authentication, production CA chains and a
remote real service remain unmeasured.
Type checking and `git diff --check` passed after the TLS harness changes.

## Existing account configuration, offline

The [private configuration helper](nextcloud-private-config.ts) reads the
original owned regular configuration through a no-follow handle, with a hard
one-MiB read cap and change checks. It creates a separate mode-0600 destination
exclusively inside the probe's private configuration directory. It preserves
opaque account settings as exact lines, removing settings and grouped sections
under `Folders`, `Multifolders` and `FoldersWithPlaceholders`.
[Upstream folder setup](https://github.com/nextcloud/desktop/blob/master/src/gui/folderman.cpp)
loads those three groups for each account. The helper does not decode credential
values, select keyring items or read personal sync-folder contents. It rejects
source symlinks, overwriting a destination and a source without retained account
settings. Source identity and a private content digest are checked again before
launch and after the application stops; the digest and account values are not
included in the saved report.

The account-copy arm requires the experimental broker and disables its network
fixture, TCP route and direct-control launch. It keeps the isolated home,
private bus and private Wayland display. It does not grant the original secret
service or desktop bus to the cloned client. Raw application logs and the
copied config remain in the disposable directory and are deleted during scoped
cleanup. The report omits the window title, frame hash, account names and
addresses. Optional preview writes a mode-0600 frame only inside that temporary
directory and waits briefly for inspection; the frame is removed with the
directory and no account image is saved in `output/`.

```sh
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
# Optional brief private frame inspection, never a persistent account artifact.
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 ORBIT_NEXTCLOUD_CLONE_PREVIEW=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
bun run scripts/limited.ts bun test experiments/nextcloud-private-config.test.ts
```

On this workstation the copy retained one account's 21 settings and removed
seven folder settings. A temporary frame was visually inspected: Nextcloud's
Activities screen showed the original cached account identity and service,
with the explicit Offline label and no loaded activities. This proves cached
identity restoration, not authenticated remote access. The temporary frame's
absence was checked after cleanup. A later run without preview closed normally
with application exit 0, no scoped stop and no broker failure. All runs kept
the original Nextcloud PID present and the original config's content and inode
unchanged. No sync scheduling pattern appeared in the clone's log.

The sanitized log summary matched a credential-failure pattern. It did not
match the narrow account-restore log pattern, despite the earlier visual
confirmation; that field is named `accountRestoreLogPatternMatched` and is not
an account-presence verdict. No IPv4/IPv6 connect denial pattern appeared and
the TCP registration count was zero. These do not prove why the client stayed
offline: exact keychain failure classification, resolver behavior and a real
account connection remain unmeasured. The original secret store is outside
this arm's authority.

The helper tests initially found an account-counting error: the top-level
Accounts version setting was counted as an account. After requiring an actual
account child key, the same tests passed: three tests and eighteen assertions.
They cover flat and grouped folder forms, exact opaque value retention,
unchanged source bytes, detecting a later source change, source-symlink rejection
and refusing to overwrite a prepared copy. Type checking passed. Reports with
counts and booleans only are in `output/seccomp-nextcloud-account-clone-2026-09-30/`.
The parser does not establish every QSettings encoding, old client schema,
adversarial path mutation, filesystem-access boundary or concurrent sync policy.
It is an experimental preparation step for the observed current configuration.

## Empty private Secret Service control

The installed package is `nextcloud-client-34.0.3-1.fc44.x86_64`. A repeated
offline account-copy run matched the exact diagnostic `The name
org.freedesktop.secrets was not provided` four times. The earlier broad
credential-failure pattern alone did not establish this cause.

The new [empty service](nextcloud-empty-secret-service.py) owns
`org.freedesktop.secrets` on the existing owned Orbit bus. It neither imports
libsecret nor connects to the original session bus. It contains zero items,
returns empty search results, rejects encrypted transfer and supports the plain
fallback. It announces readiness only after synchronously acquiring the name.
It exits on its parent pipe closing or a scoped signal. Summary data contains
counts and allowlisted public attribute names only, never attribute values.
Its temporary summary is deleted with the probe directory.

```sh
# Missing-service negative control.
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 ORBIT_NEXTCLOUD_SECRET_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
# Empty-service control. No real keyring or credential is granted.
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 ORBIT_NEXTCLOUD_EMPTY_SECRETS=1 ORBIT_NEXTCLOUD_SECRET_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
```

The measured empty-service run rendered the client, closed normally with exit 0
and no broker failure, and received eighteen searches with `server`, `type` and
`user` fields. There were two OpenSession calls: one encrypted attempt rejected
and one plain fallback. No secret was returned. The original config remained
unchanged, the original client stayed present and no sync scheduling pattern
appeared. The missing-service diagnostic disappeared and `Entry not found`
appeared instead. A blocked IPv4/IPv6 connect diagnostic also appeared; zero
TCP connections were registered. This shows the installed client's private
bus lookup path works with the protocol control, not that authentication or
remote access works. It does not establish the account's exact requested
attribute values or which original keyring entry would match them.
Both assertion controls passed against the installed application. The negative
arm required a scoped stop with application exit 128; the empty-service arm
closed normally with exit 0. Type checking and `git diff --check` passed.

[Nextcloud's credential loading source at v34.0.3](https://github.com/nextcloud/desktop/blob/v34.0.3/src/libsync/creds/httpcredentials.cpp)
reads client certificate and key entries before the account password, and can
retry legacy key locations when an entry is missing. Therefore eighteen search
calls do not imply eighteen credentials or eighteen accounts.

## One existing credential, still offline

The new [one-credential adapter](nextcloud-one-secret-service.py) runs as a
trusted host-side helper before the private client starts. It derives an exact
selection from the prepared disposable configuration, requiring exactly one
flat webflow account, a simple HTTPS URL and an unescaped user value. It rejects
unsupported encodings or account shapes instead of guessing. It uses
[the v34.0.3 key format](https://github.com/nextcloud/desktop/blob/v34.0.3/src/libsync/creds/abstractcredentials.cpp)
and [QtKeychain's libsecret schema](https://github.com/frankosterfeld/qtkeychain/blob/main/qtkeychain/libsecret.cpp)
to select the `plaintext` item with the exact account key and `Nextcloud` server
attribute. Account values are never included in command arguments or reports.

The helper verifies the original Secret Service already owns its name, searches
with no unlock or load-search flags, requires exactly one unlocked match, then
loads that item's value only. It disables core dumps and process dumpability
before lookup, holds the value in memory and exposes it through the existing
one-item protocol holder on the owned private bus. The client receives neither
the host bus address nor a forwarding proxy. The helper provides no mutation
implementation and never forwards private operations to the host keyring.
Existing holder methods expose only one item; unsupported mutation operations
are rejected. Memory zeroization and protection from privileged processes are
not established.

```sh
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 ORBIT_NEXTCLOUD_ONE_SECRET=1 ORBIT_NEXTCLOUD_SECRET_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/nextcloud-one-secret-service.test.py
```

The installed client rendered on the owned display. The sidecar loaded one
original item, exposed one private item and returned its secret once. Nine
search calls included one matching search. No mutation handler was reached;
this counter does not establish the absence of attempts rejected by D-Bus
before dispatch. The client needed a scoped stop, exit 128, with no broker
failure. Its original config remained unchanged, its original process remained
present and no folder sync scheduling pattern appeared. TCP registration stayed
zero and a denied IPv4/IPv6 connect diagnostic appeared. The secret-service
missing diagnostic was absent. `Entry not found` still appeared, consistent
with absent certificate-related entries; it is not an account-password verdict.
[Webflow credential loading](https://github.com/nextcloud/desktop/blob/v34.0.3/src/gui/creds/webflowcredentials.cpp)
performs certificate lookups before reading the password, then can attempt
private persistence. No server accepted this credential during the offline arm.

The real application assertion passed, requiring an observed private window,
one original item read, one private item and at least one secret delivery.
Four synthetic selector tests passed for the observed key construction,
multiple-account rejection, source-symlink rejection and unsupported encoded or
non-webflow settings. These tests have not been demonstrated against a selector
without those guards, so no regression-detection claim is made. Type checking
and `git diff --check` passed. Saved evidence contains counts and booleans only
in `output/seccomp-nextcloud-account-clone-one-secret-2026-09-30/`.

This remains an experiment. The adapter is not integrated into production
session launch, does not establish all QSettings schemas or path-race defenses,
and does not prove host-keyring immutability against other processes, public
network authority, account authentication, conversations, sync or devices.

## Real account connection through an opaque tunnel

The opt-in [account tunnel](nextcloud-account-tunnel.py) reads the disposable
copy through a bounded no-follow handle, resolves its one HTTPS account hostname
once on the trusted host and pins one IPv4 address for the run. It binds an
ephemeral loopback port and accepts only a literal CONNECT request for that
account hostname and port. Other authorities, other ports and non-CONNECT
requests receive HTTP 403. After CONNECT it forwards opaque bytes without TLS
termination, certificate substitution, plaintext HTTP inspection or credential
logging. The application performs its ordinary server TLS validation.

The copied account's existing proxy fields are changed only in the disposable
file, after checking its open-handle identity before writing. The installed
client initially ignored that proxy during validation: three runs showed zero
tunnels and an Offline screen. The private log said `No system proxy set by OS`.
[ConnectionValidator at v34.0.3](https://github.com/nextcloud/desktop/blob/v34.0.3/src/gui/connectionvalidator.cpp)
looks up the system proxy when the global configuration uses its default, even
with an account proxy configured. Setting `http_proxy` and `https_proxy` to the
owned loopback listener in the private application environment completed that
path. Host proxy settings and original account config were not changed.

```sh
ORBIT_NEXTCLOUD_BROKER_PROBE=1 ORBIT_NEXTCLOUD_BROKER_ACCOUNT_CLONE=1 ORBIT_NEXTCLOUD_ONE_SECRET=1 ORBIT_NEXTCLOUD_ACCOUNT_TUNNEL=1 ORBIT_NEXTCLOUD_SECRET_ASSERT=1 bun run scripts/limited.ts bun run experiments/seccomp-nextcloud-app-probe.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/nextcloud-account-tunnel.test.py
```

The first successful native run registered sixteen private TCP connection
attempts, accepted eight tunnels and forwarded 34,198 client bytes and 137,941
server bytes in its report snapshot. The installed client logged its transition
to Connected. A second run was visually inspected on the owned display: the
Activities screen listed existing account activities and stated that no
synchronisation was configured. Its temporary frame was removed during cleanup,
and absence was checked afterward. That preview report saw five accepted tunnels
and four aggregate I/O failures, which include closure and timeout paths and
are not classified upstream service failures. The Connected assertion passed.
No folder sync scheduling pattern appeared. Each run read one original keyring
item, delivered it once, kept the original config unchanged and kept the original
Nextcloud process present. Those two successful runs needed a scoped stop, exit
128, with no broker failure. A final run after the bounded no-follow config
preparation change closed normally with exit 0: fourteen TCP attempts, seven
accepted tunnels, no aggregate I/O failure, and the Connected assertion passed.

The Connected evidence is stronger than a visible account name or successful
TCP handshake: the pinned v34.0.3 validator checks an authenticated WebDAV
PROPFIND before reporting Connected. The visually loaded activity history adds
direct application evidence of authenticated remote reading. The tunnel itself
cannot classify HTTP requests or prove remote account immutability because it
does not decrypt TLS. No file sync, activity mutation, native Talk conversation
or device operation was measured in this arm.

The live disposable tunnel control passed: selected authority received HTTP 200
and echoed a binary fixture exactly; a different host, a different port and an
ordinary GET were denied with HTTP 403. Opaque unrelated config bytes survived
proxy preparation. These controls have not been run against a tunnel without
its authority check, so regression-detection is not claimed. Type checking
passed. Evidence reports contain no account identifiers or raw application logs
and live in `output/seccomp-nextcloud-account-clone-one-secret-tunnel-2026-09-30/`.

The tunnel bounds headers to 8 KiB, connection/header waits to five seconds,
each accepted session to forty-five seconds, admission to sixteen concurrent
handlers and accepted tunnels to thirty-two. Header-reading tasks exist before
the admission check; a total inbound-task bound is not established. The listener
is scoped to this run. CONNECT
authority matching and a pinned address do not enforce TLS SNI or distinguish
other virtual hosts on the same address. Payloads are not filtered; this is
functional evidence for the installed client, not a complete network sandbox.
Multiple DNS addresses, IPv6, redirects to a different authority, all failure
paths and production integration remain unmeasured.

## Limits

This route is disabled by default and exists only in the experimental wrapper.
It is one numeric loopback endpoint, not Internet connectivity, DNS, remote
service TLS, IPv6, general UDP, current-account login, token refresh or native sync.
Port reuse after the selected server closes is not pinned like a UNIX O_PATH
endpoint. The measured harness keeps its server bound until scoped cleanup;
adversarial port rebinding, borrowed descriptors, concurrent target memory
mutation and notification cancellation races remain unmeasured. Existing
private-bus PID normalization, arbitrary inherited/accepted descriptor
authority, filesystem authority and full outbound isolation are not solved.
The connect cancellation join still has no separate hard deadline. These
limits prevent treating the successful fixture discovery as full application
compatibility or as permission to expose the person's own services.
