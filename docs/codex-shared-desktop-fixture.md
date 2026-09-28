# Disposable shared Codex Desktop windows

Measured on 28 September 2026 with the installed Linux Desktop bundle copied
into temporary storage. The optional socket feature in the local
`codex-desktop-linux` source preserves the normal Desktop child launch
arguments and adds an attach-only mode for a second window. It remains off in
the installed application. The source changes are commits `7666335` and
`cd35657` in the local `codex-desktop-linux` source checkout.

The test launched two copied Desktop windows on separate private Xvnc displays,
with separate Electron user data and temporary home directories. The first
window owned one Codex app-server on a user-only Unix socket. The second
connected to that same authority without replacing its socket or ownership
lock. Two protocol clients initialized and one read a temporary thread made
through the Desktop-owned authority. All private processes were stopped.

A later run used a disposable fake API key and completed the second window's
onboarding. Its sidebar visibly showed `Disposable fixture conversation` under
Recents after a turn started through the first authority. It showed `No
projects` and the light theme because the test supplied no project list or
personal appearance state. The fake key and network isolation prevented a
successful model turn, so this does not prove that a completed conversation is
rendered or that the person's account works in both windows.

Read-only bundle inspection located sidebar project, order, assignment and pin
keys in the client local global state. The installed bootstrap constructs that
state from `CODEX_HOME/.codex-global-state.json` and reads appearance settings
from `CODEX_HOME/config.toml`. The second window's temporary copies did not
contain the person's settings. Source inspection found that each Desktop loads
the whole global state into its own in-memory map and persists the whole map
through an atomic replacement. No interprocess version check or merge was
found in that path. Atomic replacement prevents partial JSON, but two writers
can lose each other's unrelated updates. Appearance changes are sent to the
shared app-server as configuration edits; their concurrent behavior has not
been measured. A fresh private copy can match the initial sidebar and theme,
as the separate local state pilot showed, but that copy does not keep later
changes synchronized. A shared owner for global state mutations is needed
before both windows can safely edit the person's sidebar.

The original installed Desktop still has its stdio app-server and was not
restarted or modified. Neither the person's account and projects nor the full
host tool isolation needed for an agent turn have been tested through these
two windows. These results establish the shared window and visible thread path
only for disposable state.

## Later owner state fixture

Source commits `aa491bc` and `dd88724` in `codex-desktop-linux` add an
opt-in owner socket for selected sidebar keys. The second Desktop checks a
private `CODEX_HOME`, reads the owner's sidebar state through that socket,
forwards supported changes to the owner, and uses its own local state file.
The owner remains the writer of its state file. Reproducible fixture scripts
and a screenshot are in that feature's `evidence/` directory.

A fresh two-window run used temporary homes, separate private displays and a
fake API key only in the owner home. The second home had no `auth.json`. Its
window passed onboarding and visibly rendered the fixture project and its
assigned conversation. With synthetic dark GSettings preferences in the
second private home, its screenshot was dark. Both processes stayed alive,
and the owner's authority and state socket identities stayed unchanged. The
fixture processes were then stopped.

This is evidence for a disposable project, conversation title and appearance
in a second Desktop. It has not used the person's account, original app,
personal projects or real conversation content.

An additional fresh run, recorded by external source commit `2f84a68`,
launched the copied second Desktop through Orbit's private Wayland supervisor.
The supervisor verified and mounted both owner sockets. The second Desktop
stayed alive, created its private global-state file with one project, had no
local auth file, and showed the shared fixture project and one assigned
conversation in dark mode. The screenshot and reproducible scripts are in
`codex-desktop-linux/linux-features/shared-app-server-socket/evidence/`.
An additional disposable run kept a local mock model inside the owner's private
network namespace. The owner completed one turn. The Orbit client opened that
thread in its private Wayland window, and the screenshot visibly contains the
fixture prompt and completed answer. The runner checks the persisted answer,
screen text, absent client `auth.json`, one private project, and unchanged owner
socket inodes. The fixture and screenshot are in the same `evidence/` directory.
This tests rendered completed content with synthetic credentials only. Every
sidebar key, the person's real account, and complete host tool isolation are
still unmeasured.

The runner then closed the first Orbit client and launched a fresh private
client while the same owner stayed running. Both client runs showed the project,
conversation and completed answer. Neither private client had an `auth.json`,
and the owner's socket inodes stayed unchanged. The second screenshot is
`private-orbit-reopened-turn.jpg`. This measures a client window reopen, not an
owner restart or persistence of the person's real application state.
