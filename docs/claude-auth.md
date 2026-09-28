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

## Next bounded pilot

Use the installed Electron ELF directly in an Orbit-owned private display, with
an empty disposable `0700` home, XDG directories, D-Bus bus and a full
disposable GNOME Keyring Secret Service. Set `--password-store=gnome-libsecret`
only for that private process. First prove that a synthetic secret can be
stored and read on that private bus. Then run Claude for at most 90 seconds and
record only its backend selection, secure-storage availability, window mapping,
exit status and crash metadata. Compare with a separate empty-profile launch
using the default backend. Keep the original Claude process and profile under
read-only PID and hash checks, and disable core dumps for the disposable app.

Call the pilot successful only if the private app maps and reports an available
secure backend. Account sign-in, token persistence after restart and an
authenticated service request would still need separate measurements. The
installed `AppRun` wrapper runs global cleanup routines before launch, so the
pilot should invoke the ELF directly while the host application is open.
