# Codex active attachment route

`launch-app` with `app: "codex"` and `profile: "active"` calls
`prepareCodexAttachedLaunch` in `src/native-codex-attach.ts`. It requires the
optional shared app-server socket feature on the installed Desktop and a live
owner authority. If either shared socket or the attach feature is unavailable,
the action returns `UNSUPPORTED` before creating a private home or launching a
window. It never falls back to an account or history snapshot.

The default owner socket is
`/run/user/<uid>/codex-desktop/app-server-bridge/app-server.sock`. A broker
started with `ORBIT_CODEX_AUTHORITY_SOCKET` can select a different owner socket
under its user runtime. The action does not accept a socket path, executable or
project path from an agent. Project directory access through this route has not
been implemented.

The public route currently accepts only `/usr/lib/chatgpt/ChatGPT` as its
installed executable. A verified candidate staged under `/var/tmp` is not a
public launch target. Using that candidate without replacing the installed app
needs a separate explicit configuration and executable identity check. This
route does not activate the candidate or restart the person's Desktop.

The owner must provide an authority socket below `/run/user/<uid>` with its
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
In a later disposable combined run, an attached copied Desktop rendered dark
with a synthetic private dconf preference. The person's Desktop was not used.
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
The original focused run passed with 2 tests and 10 assertions on September 28, 2026.
After the public route changed, `ORBIT_TEST_NATIVE=1 bun run verify
tests/native-codex-attach.test.ts tests/native-codex.test.ts
tests/agent-interface.test.ts` passed 17 tests with 93 assertions. The added
action test verified that an absent owner returns `UNSUPPORTED` without creating
a private home or supervised child. `bun run typecheck` also passed. This test
did not launch the installed Desktop or use the person's account.

This establishes mount and temporary HOME behavior for disposable listeners.
A later combined run used the same internal helper with a copied, patched
Desktop and a fake-key authority. The private window showed one shared fixture
project and conversation in dark mode, without a local auth file. Reproducible
scripts and its screenshot are in the Desktop feature's `evidence/` directory.
It does not establish a connection to the person's Desktop authority, real
account or complete UI parity, durable state, or safe model tool access.
