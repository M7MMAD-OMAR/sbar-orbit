# Claude Desktop authentication on this workstation

Measured on 28 September 2026. This note concerns the installed Claude Desktop
package and Orbit's private display pilot. It does not establish a working
authenticated Claude session in Orbit.

## What the evidence says

The installed wrapper reports version `2.2553.13-3.2.4`. The running host
process has no `CLAUDE_PASSWORD_STORE` override, and its current `main.log`
contains `basic_text` backend markers from 28 September. The installed
`app.asar` has separate legacy and scoped OAuth persistence paths. Both return
before saving when Electron `safeStorage.isEncryptionAvailable()` is false and
log that tokens will not persist. The same bundle logs an unavailable secure
storage backend at startup. These are observations of the installed code and
host log, not a claim about every Claude build.

Electron documents `basic_text` as the Linux fallback when a recognized secret
store is unavailable, and documents `--password-store=gnome-libsecret` as an
explicit backend selector. See the [Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

The earlier Orbit pilot copied a small part of the host profile and presented
one Claude keyring item to a private process. Its window showed the account
name and projects, then requested sign-in again. The copied profile can explain
the visible account metadata. It did not supply a verified active OAuth token
to the private process. A token held only in the host process memory cannot be
transferred by copying profile files. One authenticated Claude request in the
private window remains unmeasured.

Two follow-up empty-profile attempts did not establish a usable secure backend.
A synthetic one-item Secret Service ended in a `libsecret` crash. A run with the
real filtered Secret Service and the explicit `gnome-libsecret` selector exited
before a window or useful app log appeared. The crash metadata names
`secret_service_ensure_session_sync`. It does not prove which part of the
service interaction was invalid.

## Disposable private keyring pilot

On 28 September, a private Fedora display ran the installed Electron ELF with
an empty `0700` home, private XDG directories, Orbit's private D-Bus bus and
`--password-store=gnome-libsecret`. The installed `AppRun` wrapper was not
invoked because it runs global cleanup routines. Orbit's supervisor set the
core limit to zero for Claude. The private keyring process also had a zero core
limit and was not dumpable. The host Claude app stayed open. Its main log inode
stayed stable, although its byte size grew during one later run while the host
app was active; the writer was not identified. The private window mapped
without using the host display or pointer.

Starting `gnome-keyring-daemon` with an empty home and `--components=secrets`
registered `org.freedesktop.secrets`, but `secret-tool store` failed because
`/org/freedesktop/secrets/collection/login` did not exist. The private Claude
log reported `isEncryptionAvailable=false` with backend `gnome_libsecret`.
Merely registering the service is therefore insufficient.

Adding `--unlock` and supplying a disposable private passphrase created a
usable login collection. A synthetic secret stored through `secret-tool` was
read back through a separate process on the same private bus. Claude mapped and
remained alive for the bounded run. Its private startup log did not contain the
earlier `isEncryptionAvailable=false` warning. The private window showed the
fresh-profile "Get started" page. This proves the private Secret Service
round trip and Claude window mapping. It does not directly prove a positive
Electron `safeStorage.isEncryptionAvailable()` result, token persistence, or
an authenticated Claude request.

The active host OAuth token still appears to exist only in host process memory
under the measured `basic_text` backend. An empty private keyring cannot copy
that in-memory token. A future pilot must directly check Electron safeStorage
availability, then establish whether an account authorized in a persistent
private profile survives a restart and can make an authenticated request. That
would still require a separate method to reuse the already active host login
without signing in again.

The bounded pilot can be repeated with
`bun run scripts/limited.ts bun experiments/claude-secure-storage-pilot.ts`.
It prints only status, counts and selected warning flags, creates its own
private session, and removes that session on exit. `ORBIT_CLAUDE_ELF` selects
another installed Claude ELF. The pilot does not copy or modify the host
profile and does not request the host display.
