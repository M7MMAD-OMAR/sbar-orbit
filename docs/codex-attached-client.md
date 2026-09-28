# Codex attached client experiment

`prepareCodexAttachedLaunch` in `src/native-codex-attach.ts` prepares an internal
Codex Desktop client for the optional shared app-server socket feature. Nothing
in the public `launch-app` action calls it. The installed Desktop and its
personal profile are not changed by this path.

The caller must provide an authority socket below `/run/user/<uid>` with its
adjacent `.state` socket and a private Orbit display. Preparation checks that
every socket parent is owned by the user and private, that both sockets have
modes limited to the user, and that both accept a connection. It records each
socket device and inode. The native mount helper opens those same inodes
through descriptors immediately before launch, checks their owners and
permissions again, and binds them as `orbit-codex-authority.sock` and
`orbit-codex-authority.sock.state` inside the private mount namespace.
The host runtime is hidden by a temporary filesystem. The client receives only
the mounted authority socket, not the rest of the host runtime.

The client gets a fresh HOME inside the Orbit session, an empty `CODEX_HOME`,
empty Electron user data, and `CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1`.
It receives a private snapshot of the host GSettings database and uses the
`dconf` backend, matching the normal private Codex launcher. The installed
Desktop defaults its appearance to the system setting, so this supplies the
host's dark preference in the private display without changing host settings.
Actual dark rendering in an attached Desktop has not been observed yet.
No account token, conversation database, project state, or application profile
is copied. Its temporary HOME is removed on release. The preparation helper
accepts a fixture executable inside the session. For the installed Desktop
executable it also requires the optional feature's staged manifest. The
manifest is only a prerequisite: it does not prove that the installed bundle
still contains a working patch.

`tests/native-codex-attach.test.ts` uses temporary Unix listeners and a
fixture executable. The fixture connected to both mounted sockets from inside
the private mount, saw the attach-only setting, and saw no copied Codex state.
The same test rejected a changed inode on either socket before launch. A second test rejected
permissive, linked, and out-of-runtime socket paths, and an unrelated executable.
The focused run passed with 2 tests and 10 assertions on September 28, 2026.

This establishes mount and temporary HOME behavior for a disposable listener.
It does not establish a connection to the person's Desktop authority, account
or UI parity, durable state, or safe model tool access. A future private client
experiment needs a verified patched Desktop binary and a disposable Desktop
authority before any connection to a personal authority is considered.
