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

The public route uses `/usr/lib/chatgpt/ChatGPT` by default. A broker operator
may configure a separate staged candidate with both
`ORBIT_CODEX_CANDIDATE_EXECUTABLE` and
`ORBIT_CODEX_CANDIDATE_MANIFEST_SHA256`. These are broker environment settings,
not action fields an agent can supply. If only one is set, the action fails.
The executable may be `/var/tmp/<private-root>/app/ChatGPT` for a disposable
fixture, or
`~/.local/share/sbar-orbit/codex-candidates/<private-root>/app/ChatGPT`
for a candidate retained across application restarts. Broker configuration
must use the expanded absolute path. The candidate root and
the dedicated `codex-candidates` directory must belong to the user and have
mode `0700`. Every ancestor under the user's home must be owned by that user,
canonical and free of shared write permissions. The candidate tree must contain only owned
regular files and directories, with no links, special files or shared write
permissions. Its private manifest pins the SHA-256 of every app file. The
broker setting pins the manifest itself. The verifier also requires the copied
Desktop binary and source ASAR to match the current installed app, the version
to match, and the candidate ASAR to differ from that source. The CLI may have a
different hash when a reviewed patch is added, but any change requires a new
manifest and broker pin.

After staging and finalizing all candidate files, generate its manifest with
`bun run scripts/write-codex-candidate-manifest.ts
<absolute-candidate-root>/app/ChatGPT`. The script writes
`<absolute-candidate-root>/candidate-manifest.json` once and prints the manifest
SHA-256 for broker configuration. It never overwrites a manifest. Build a fresh
candidate directory after changing any file. Two durable candidate copies have
been pinned for experiments, but no broker candidate setting has been changed.
This route does not activate the candidate or restart the person's Desktop.
Retaining the candidate directory preserves its files, but does not itself
prove account, thread or tool continuity after a Desktop restart.

The owner must provide an authority socket below `/run/user/<uid>` with its
adjacent `.state` socket and a private Orbit display. Preparation checks that
every socket parent is owned by the user and private, that both sockets have
modes limited to the user, and that both accept a connection. It records each
socket device and inode. Orbit now creates separate, session-local gate sockets
and gives their paths to the attached Desktop. The native mount helper hides
the host runtime and does not bind either raw owner socket into the private
namespace. The gate checks the recorded socket identities when connecting,
forces `thread/list` to use the SQLite-only mode, and rejects unknown methods,
`thread/read`, `thread/resume`, model turns, host commands, file reads, project
imports and owner state writes. It strips account responses to bounded identity
fields and never returns an access token. The gate permits only a limited
project and conversation title view. Its 8 MiB message limit excludes larger
responses. A hostile process running under the same user could still race a
socket pathname, so the inode checks are a measured restriction, not complete
same-user isolation.

The client gets a fresh HOME inside the Orbit session, an empty `CODEX_HOME`,
empty Electron user data, and `CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1`.
It receives a private snapshot of the host GSettings database and uses the
`dconf` backend, matching the normal private Codex launcher. The installed
Desktop defaults its appearance to the system setting, so this supplies the
host's dark preference in the private display without changing host settings.
In a later disposable combined run, an attached copied Desktop rendered dark
with a synthetic private dconf preference. The person's Desktop was not used.
No account token file, conversation database, project state, or application profile
is copied. An earlier raw-socket prototype could obtain a fake access token
through `getAuthStatus` and forward `command/exec` to the host owner. The new
gate fixture denied both, along with owner state writes. The attached Desktop
still attempts to resume a conversation when its title is clicked. The gate
correctly refuses that request, so conversation content, complete account
identity, model turns, file edits and full UI parity have not been established
under this boundary. The personal Desktop remains on its original stdio
app-server and has not been attached.
Opening model turns requires more than permitting `turn/start` through this
gate. The current gate drops owner notifications and server requests. In the
exact-tag app-server, a second client's `turn/start` can steer an already
active turn, while dynamic tool requests are sent to all subscribed clients
and the first response can win. A disposable two-client probe observed that
callback race. A later deterministic red fixture confirmed that both clients
received the same dynamic tool callback and the model accepted the nonowner's
reply. See `experiments/codex-two-client-tool-owner-red.md`. A private
writable route therefore needs an atomic turn owner,
tool and approval requests bound to that initiating client, private executor
placement, a per-turn tool ceiling that also covers existing conversations,
and filtered turn notifications. These conditions have not been implemented
for the active route. See `experiments/codex-dynamic-tool-routing-probe.py`.
Its temporary HOME is removed on release. The preparation helper
accepts a fixture executable inside the session. For the installed Desktop
executable it also requires the optional feature's staged manifest. That
manifest is only a prerequisite: it does not prove that the installed bundle
still contains a working patch. The staged candidate uses the broker-pinned
complete file manifest described above. Verification happens before launch,
but same-user changes after verification remain a race until the candidate is
mounted from pinned immutable files.

`tests/native-codex-attach.test.ts` uses temporary Unix listeners and a
fixture executable. The fixture connected to both gate sockets from inside
the private mount, could not see the raw owner sockets, saw the attach-only
setting, and saw no copied Codex state.
The same test rejected a changed inode on either socket before launch. A second test rejected
permissive, linked, and out-of-runtime socket paths, and an unrelated executable.
The original focused run passed with 2 tests and 10 assertions on September 28, 2026.
After the public route changed, `ORBIT_TEST_NATIVE=1 bun run verify
tests/native-codex-attach.test.ts tests/native-codex.test.ts
tests/agent-interface.test.ts` passed 17 tests with 93 assertions. The added
action test verified that an absent owner returns `UNSUPPORTED` without creating
a private home or supervised child. `bun run typecheck` also passed. This test
did not launch the installed Desktop or use the person's account.

The newer gate tests passed 5 focused tests with 54 assertions and typecheck.
They exercised fake raw token and host command responses, rejection through
the gate, owner state write denial, a changed owner socket inode, bounded
messages and the forced `useStateDbOnly` list option. The attach-only Desktop
patch skipped local project migration in a disposable fixture, leaving the
owner's project records untouched. Its full external test suite had 43 passes
and 2 test harness incompatibilities, unrelated to that patch. A gated fake
Desktop showed a shared project and conversation title, then displayed
`Failed to resume chat, Codex private client is read only` when opening the
conversation. Its footer showed `Settings`. The fake owner used an API key and
had no ChatGPT display name, so this fixture cannot measure ChatGPT account
label parity. No personal application, account or profile was used.

An exact-tag CLI source experiment in
`experiments/codex-thread-readonly-metadata.patch` adds an opt-in
`thread/read` request for metadata only. A red test first proved the normal
read repaired a missing SQLite row. With the patch, three read-only tests
passed and an ordinary owner test still repaired the row. App-server library
and test targets compiled. An incremental source experiment in
`experiments/codex-thread-readonly-legacy-history.patch` allows legacy
`includeTurns: true` reads. Its component baseline reproduced the SQLite
repair, and three patched store tests passed with fixture user text and
unchanged rollout bytes. App-server library and tests compiled. The loaded
app-server RPC test timed out during linking before its assertion ran, and
assistant text was absent from the fixture. Paginated reads remain denied.
An incremental test-only patch in commit `edac120` then added user and
assistant messages to both loaded-sequence and unloaded legacy fixtures.
The ordinary read changed the state database WAL in both red controls.
The read-only component calls passed with unchanged state main, WAL, SHM,
and rollout bytes and modification times, and kept the missing row absent.
Three tests also passed after applying the patches in a detached exact-tag
worktree. This still does not measure the app-server RPC, Desktop rendering,
concurrent owner writes, or personal history. See
`experiments/codex-thread-readonly-legacy-content-files.md`.
An exported app-server RPC fixture for the loaded and unloaded cases did not
reach an assertion: its bounded build timed out at 300 seconds. Its red and
green requests remain unmeasured. See
`experiments/codex-thread-readonly-legacy-rpc-fixture.md`.
An isolated standalone RPC test subsequently compiled with a smaller target.
The ordinary unloaded read changed the fixture SQLite WAL and failed its file
assertion. Both loaded and unloaded `readOnly: true`, `includeTurns: true`
requests returned the fixture user and assistant text without changing the
measured state main, WAL, SHM, or rollout files. The ordinary loaded read did
not change those files, so the loaded assertion did not demonstrate red
sensitivity. This is a disposable RPC measurement, not a Desktop or personal
account measurement. See
`experiments/codex-thread-readonly-legacy-rpc-small-target.md`.
Neither source patch is in the staged candidate or the Orbit gate. The Desktop
source has a dormant attach-only legacy viewer patch in commits `3b148f5` and
`d60630e`.
Its readiness setting is off by default. These patches do not yet make
conversation content available, and they do not establish a safe writable
thread route.

The separate paginated history experiment in
`experiments/codex-paginated-readonly-cached-pool-negative.md` remains a
negative result. Ordinary turn and item page reads created a missing history
database. A proposed cached-pool path refused the missing database and
returned two fixture pages, but its SQLite `-shm` file changed during SELECT.
The main database and WAL bytes stayed stable in that run. The proposed patch
was not exported or enabled; paginated reads remain denied by the gate.

A later disposable component fixture ran a separate SQLite reader inside a
`bwrap` read-only bind while its writer stayed open outside. Two reader runs
saw successive committed markers without changing the main database, WAL or
SHM bytes, sizes or modification times during either quiescent reader window.
This evidence is in
`experiments/codex-paginated-bwrap-readonly-positive.md`. No Orbit helper,
app-server request or Desktop viewer uses this boundary yet.

An exact-tag, test-only framed helper prototype then requested two turn pages
and two item pages through one disposable `bwrap` child per page. It returned
both cursors and fixture user and assistant content while the main database,
WAL, and SHM bytes and metadata stayed unchanged across the four calls. The
exported patch applied and passed in a clean exact-tag worktree. This is one
synthetic rollout segment, with no state database validation, concurrent writer
test, app-server RPC, Orbit gate, or Desktop rendering. The active gate still
denies paginated reads. See
`experiments/codex-paginated-framed-helper-prototype.md`.

A later exact-tag app-server RPC probe used the request shape the Desktop sends
for paginated hydration. On a cloned fake account, `thread/turns/list` returned
the fixture user and assistant text, and two `thread/items/list` pages returned
user and assistant items. The writable red control changed the history SQLite
WAL and SHM after initialization. An opt-in SQLx read-only pool under a
`bwrap` read-only history mount returned the same content without changing any
watched state or history main, WAL, SHM, or rollout file. The original fake
fixture was also unchanged. This is one saved turn, so turn cursor traversal
was not tested. The opt-in pool blocks ordinary history writes in that process
and cannot be used on the live owner. The active gate still denies these RPCs;
concurrent owner writes, Desktop rendering, and personal data remain unmeasured.
See `experiments/codex-paginated-rpc-readonly-pool.md`.

Desktop patch `523302a` adds an attach-only account projection from sanitized
`getAuthStatus` and `account/read`, leaving the owner's token path unchanged.
A synthetic test passed and matched the copied ASAR. It returned fixture email
and plan without asking the private client to fetch a token. A first fake
ChatGPT UI run captured a loading screen after 10 seconds, so no account label
was measured in the interface. A second disposable UI run reached the dark
window after 40 seconds with one fixture project, but its footer said
`Settings`. Direct RPC inspection found that this fixture's custom model
provider did not require OpenAI authentication. Its `getAuthStatus` returned
no auth method and `account/read` returned no account, so the run cannot
measure ChatGPT identity projection. With authentication required, a fake JWT
carrying an account ID made `account/read` fail while the offline fixture
could not complete workspace discovery. A separate fake JWT without an account
ID returned ChatGPT email and plan to direct RPC, but the Desktop displayed
`Unable to load sign-in requirements` after 40 seconds. The footer was not
measured. Neither synthetic JWT reproduces a complete real account session,
and no real account was used.

The gate now has an experimental projection of `configRequirements/read`: it
passes the owner request through and returns only validated login methods and
the absence of application restrictions. A disposable API-key client retained
its dark project and conversation title with this projection. In a separate
fake ChatGPT fixture, this removed the sign-in requirements error but the
Desktop still showed `Sign in to ChatGPT` after 40 seconds. The account footer
and authenticated conversation work remain unmeasured.

Desktop commit `1563cd1` adds an attach-only identity route in the copied
bundle. It enters the app route only when the private preload hook is present
and sanitized account information contains a bounded email; the private client
still has no ChatGPT token. Owner mode and missing-email cases kept the normal
login route in synthetic tests. The installed-ASAR staging path was corrected
to include the account, project, preload, viewer, identity, and composer
patches. A disposable public stage passed 57 targeted tests, with one
documented CLI integration skip, and its fake ChatGPT UI showed the fixture
email in the Codex section footer. That fixture lacked a projected account id, so
the UI said it had no Codex access and did not show its projects or chats. A
later source trace identified a more specific cause: the private account
projection omitted the account id required by the local Codex access check.
That UI result therefore does not measure the fixture's entitlement. It also
does not establish real account parity, existing conversation access, tool
actions, or persistence. The original personal Desktop and account were not
used or changed.

Orbit commit `4379d5b` and Desktop commit `f6f45f6` project only the selected
workspace account id from the owner after a successful fake `accounts/check`.
The gate validates its ASCII shape and length, and the private Desktop keeps
`hasChatGptToken` false. A public-staged fake plus-account fixture then showed
the fake owner email, one project, and a saved conversation title in the dark
Codex UI. Clicking the conversation returned `Attach-only conversation viewer
is unavailable`, so its answer text was not shown. A separate optional tool
ceiling check failed: the mock model received 12 tools instead of zero. The
UI result establishes neither a writable session nor isolated model tools.
No real account or personal profile was used, and the installed app was not
modified or launched. See
`docs/codex-attached-fake-account.md`.

A later copied candidate combined that fake plus-account projection with the
patched startup `allowedTools` CLI. Its local mock model saw zero tools for
one new turn while the dark private UI showed the fake email, project, and
saved conversation title. The full fixture still exited 1 because opening
the conversation did not show its answer: the attach-only viewer was
unavailable. This does not extend the startup ceiling to existing threads or
prove real-account work. See
`experiments/codex-combined-fake-account-zero-tools.md`.

The candidate verifier passed 23 focused tests across four files with 110
assertions, including complete-tree pinning, changed ASAR, added files, links,
unsafe permissions, an unpatched ASAR and paths outside the private root. These
tests used disposable files, not the user's account or staged Desktop candidate.
The disposable tests also cover a durable candidate path, a rejected sibling
directory, and linked or shared-write Orbit parent directories. They do not
measure an actual Desktop restart.

A later disposable fixture used a separate exact-version staged candidate and
its pinned manifest with the public `launch-app codex active` action. The first
Orbit private window showed the owner's fixture project, conversation and
completed answer. After closing it, a fresh Orbit window showed the same
content. Neither client had a local auth file, and both owner socket inodes
stayed unchanged. The owner had a fake API key only. The reproducible
`--public-attach` fixture and screenshot are in the Desktop feature's
`evidence/` directory. This does not test the person's real account or
original running Desktop.

The same public action then passed a second disposable fixture with a patched
Codex CLI inside a newly pinned candidate. The owner started a thread with
`allowedTools: []`, and its local mock model received zero tools. A completed
answer remained visible after the Orbit client window was closed and reopened.
The copied candidate and its manifest stayed separate from the installed app.
This test does not show an allowed Orbit tool action or account continuity.

A later disposable Desktop fixture exposed exactly one named toy Orbit MCP tool
to the mock model. The model called it, received its result, and completed a
turn visible in two sequential public Orbit attached windows. This proves the
positive tool ceiling and the Desktop rendering path for one synthetic tool.
The toy server only recorded a disposable action; this run did not reach the
real Orbit broker.

Another disposable combined run used the real session-bound Orbit MCP adapter
and broker. The mock model saw only `mcp__orbit_private.orbit_act`, called it
once, and received its result. The broker journal recorded one allowed pointer
action; a blank Fedora session's private pointer presence changed from absent
to `(317, 219)`. The completed turn appeared in both the first and reopened
public attached Codex windows. The owner used a fake API key, and the action
did not touch the person's pointer, app, profile or account. This test did not
use the later read-only authority gate, edit a file, or prove that an attached
client cannot call other owner RPCs directly.

The same fixture then tested an owner restart. It sent SIGTERM only to the
copied Desktop main process identified inside its private process tree, and
started a new owner with the same temporary profile. The app-server resumed
the thread, the sidebar bridge returned the same project, and a new public
Orbit client displayed the project, tool item, prompt and completed answer.
The new owner had a different PID, and both authority socket inodes changed.
No client auth file was present. This used a fake API key, a private display and
a copied candidate, not the person's running Desktop or account. A stale
sidebar socket found by the fixture was fixed in the optional Desktop source:
the new owner probes it and removes it only after a refused connection and an
unchanged inode check. Its focused source tests passed 3/3. The screenshot is
`codex-desktop-linux/linux-features/shared-app-server-socket/evidence/private-public-owner-restarted.jpg`.

This establishes mount and temporary HOME behavior for disposable listeners.
A later combined run used the same internal helper with a copied, patched
Desktop and a fake-key authority. The private window showed one shared fixture
project and conversation in dark mode, without a local auth file. Reproducible
scripts and its screenshot are in the Desktop feature's `evidence/` directory.
It does not establish a connection to the person's Desktop authority, real
account or complete UI parity, durable state, or safe model tool access.

The gate now has a dormant `allowLegacyThreadRead` option for focused tests.
With that option selected, it accepts only `thread/read` requests carrying a
UUID thread ID, a boolean `includeTurns`, and `readOnly: true`. Its default
still denies every `thread/read`. The focused gate test checked both metadata
and full-turn request shapes and rejected missing or false `readOnly`, extra
fields, invalid IDs, and `turn/start`. This option is not passed by Orbit's
active launch route or enabled in the Desktop viewer. It cannot safely be
enabled against an owner executable that may ignore the added read-only RPC
field.
The fake account's saved new-thread rollout declares `history_mode: paginated`
under CLI `0.155.0-alpha.9.2`. The dormant legacy Desktop viewer accepts
legacy history only, so that particular saved conversation would still fail
its history-mode check even if the legacy read option were enabled. A
paginated read path must be measured and connected separately.
The external Desktop source now has a separate dormant paginated viewer flag.
On a disposable ASAR extraction, its exact hydration method requested metadata
and two full turn pages with `readOnly: true`, then returned two fake turn texts
in order. The source suite passed 53 tests with one live CLI test skipped. No
Desktop window was rendered. The Orbit gate still denies page RPCs, and a
stock owner may ignore `readOnly`; the flag must remain off until a separate
read-only helper and gate route are verified. See the Desktop feature report
`linux-features/shared-app-server-socket/evidence/paginated-viewer.md` in
`codex-desktop-linux` commit `9da0bd7`.

An additional exact-tag two-client red fixture held a model response while a
second client sent `turn/start` to the first client's active turn. The server
accepted the second request and returned the same turn ID. The fixture did
not measure whether the model later consumed the second client's text. This
is another reason the attached route continues to deny writes. See
`experiments/codex-two-client-active-steer-red.md`.

An opt-in source patch then bound `turn/start` and `turn/steer` to the client
that began an active turn. A disposable two-client green fixture rejected both
methods from the other client and accepted both from the owner. The mock model
had received only the warm-up and owner requests before release. This binary
also contained earlier legacy read-only RPC changes. Other input methods,
tool callback ownership, per-turn tool limits, and Desktop use have not been
tested together. The patch is not in the installed application or active gate.
See `experiments/codex-turn-owner-steer-optin.md`.
