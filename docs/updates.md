# Automatic updates

Implementation and design notes. The staging and activation orchestration is built, but this is not a
verified automatic upgrade path for every installation.

## Current limits, 20 September 2026

- `bun run verify tests/update.test.ts`: 20 passing tests, 0 failures. Restart and health checks are
  injected in activation tests; this does not measure a real service upgrade or rollback.
- Only launchers resolving into the updater's managed `versions` directory qualify. A source checkout
  updates through git; a global package installation is not automatically a managed updater install.
- Linux has an opt-in systemd timer. End to end activation and rollback on a managed installation,
  including compatibility with state written by a newer version, remain **not measured**.
- macOS has no updater launchd timer, and activation still attempts a systemd restart.
- Windows has no updater scheduler. Activation still assumes there is no managed broker and can accept
  an absent broker as healthy. This does not integrate with the installed Windows scheduled tasks.
- `update on` records the opt-in flag before attempting the timer. `automatic: true` alone is not
  evidence of a working scheduler; inspect the timer result. Do not rely on automatic updates on
  macOS or Windows yet.
- GitHub source releases and the registry feed are separate. The updater checks the registry, whose
  latest version is still `0.1.0-alpha.6`; the GitHub `0.1.0-alpha.7` release does not reach that feed.

The historical design and implementation notes below explain the intended Linux flow and its limits.
The question it answers is the one an installed base creates: when a fix or a feature lands, how does it
reach a machine that already has Orbit, on its own, without taking away the session the person is
watching.

## The one thing that makes this hard

An Orbit session is not a connection. It is live state inside the broker process: the `Sessions` object
holds it, the CDP relay in [src/egress.ts](../src/egress.ts) is a listener that process owns, the origin
lease lives in a network namespace below the browser, and the policy is an object fixed at creation. A
socket handover, which is the usual answer for "restart without dropping anything", moves the listening
socket and nothing else. It would give the new process the socket and leave every session behind in the
old one.

So the honest boundary is this. **An update can be prepared with zero effect on a running session. It
cannot be activated inside one.** Everything below follows from that sentence. Any design that claims
otherwise is claiming that a browser, its namespace, its relay and its journal can be handed between two
processes, which is a different and much larger project than an updater.

## What an installed machine looks like today

Measured on this host on 14 September 2026:

- `~/.local/bin/sbar-orbit` is a symlink to `<source>/bin/sbar-orbit`, replaced atomically by rename
  ([src/local-install.ts:61](../src/local-install.ts)). The service unit and the agent connector
  configuration both point at that stable name.
- The user service runs `<source>/bin/sbar-orbit serve --managed-socket` in `sbarorbit.slice`, with
  `Restart=on-failure`, `TimeoutStopSec=30`, `KillMode=mixed` ([src/service.ts:59](../src/service.ts)).
- On this machine the symlink points straight at a working checkout, so "update" here means `git pull`
  underneath a running broker. That is the hazard the next section describes, not a design.

## Three things a reading of the source found

**The broker runs scripts out of its own tree while a session is alive.** Creating a browser session
spawns `src/native/supervise.py` ([src/chrome.ts:75](../src/chrome.ts)), a native session spawns the same
file ([src/fedora.ts:138](../src/fedora.ts)), and saving an account spawns `src/native/one_secret.py`
([src/clone.ts:68](../src/clone.ts)). The broker's own modules are all statically imported, so they are
resolved once at start and an overwrite cannot reach them; these child scripts are read from disk at the
moment they are used. Overwriting the tree in place therefore pairs an old broker with a new supervisor
at the next `session.create`.

Measured on this host on 14 September 2026 by [experiments/live-overwrite.ts](../experiments/live-overwrite.ts),
against a staged copy of the tracked source with its own private socket, so no live session was involved.
The result is more precise than the reading was, and in one direction better than expected:

| While the tree is overwritten | What happens |
|---|---|
| A session already open | Survives. It answered `session.observe` after both overwrites, because its supervisor was already running |
| A new session, half written file | `BACKEND_FAILED`, `Owned Chrome exited with code 1 before publishing its endpoint: SyntaxError: '[' was never closed` |
| A new session, completed change of interface | `BACKEND_FAILED`, `Owned Chrome exited with code 2 before publishing its endpoint: supervise: --mode is required` |
| A new session, after the file is restored | Created |

So an in place update does not take away the session the person is watching. It takes away their ability
to start another one, for as long as the broker and the tree disagree, and it reports that as a backend
failure rather than as an update in progress. On a `git pull` that window is milliseconds; on a version
whose supervisor interface changed it lasts until the service restarts. Both are avoided entirely by
never writing into the tree a running broker executes from, which is what the design below does.

**The native runtime was inside the source directory, and is not any more.** Moved on 14 September 2026,
which is step 2 below, done. What follows is what the problem was.

**The native runtime is inside the source directory.** `nativeRuntimePaths` resolves
`<source>/.runtime/sway` ([src/runtime-paths.ts:5](../src/runtime-paths.ts)), 9.9 MB on this host. A new
version in a new directory starts with none of it, so every native session on that machine would stop
working after an update until someone reran `./install.sh --native`, which downloads and compiles. An
update that silently removes a capability is worse than no update. This has to be decided before an
updater ships, and it is a relocation with its own compatibility question, so it belongs in its own step:
the runtime moves to a shared location outside the versioned tree, keyed by the package versions the
bootstrap pins, or activation carries the built runtime forward.

It is now `${XDG_DATA_HOME}/sbar-orbit/runtime/sway-1.11-3.fc44-<digest>`, one build per pinned package
set, shared by every version that pins the same set. A runtime built at the old path is still found and
is adopted by `./install.sh --native` rather than downloaded again, and `preflight` reports which of the
two it found. Gate, measured on this host: with the source tree's own `.runtime/sway` hidden, two native
sessions open, capture and drive an application from the shared runtime.

That gate is also what found the defect in the first attempt. `node:fs/promises` `cp` rewrote the
unpacked tree's relative soname links into absolute paths back into the source tree, so the adopted
runtime kept working only while the tree it came from still existed: sway could not load
`libliftoff.so.0` the moment it did not. The copy is `cp -a` now, and the link staying relative is
asserted in `tests/native-runtime.test.ts`. A copy that passes while the original is still there is
exactly the failure a version swap turns into a broken machine.

**The stable name already exists, which is the part that works.** Because the service, the connector
configuration and the person's `PATH` all go through one symlink, repointing it is the whole of
activation. Nothing else on the machine has to be rewritten to change versions.

## The shape that fits

Five parts. The first three are what makes it safe; the last two are what makes it automatic.

### 1. Versions live side by side, and one symlink says which is current

```
~/.local/share/sbar-orbit/
  versions/0.1.0-alpha.4/     the tree, with its dependencies prepared
  versions/0.1.0-alpha.5/
  current -> versions/0.1.0-alpha.5
  previous -> versions/0.1.0-alpha.4
```

`~/.local/bin/sbar-orbit` points at `current/bin/sbar-orbit`. A running broker keeps executing out of its
own version directory, which nothing touches, so preparing the next one is invisible to it. This is the
standard atomic swap: build into a new directory, switch a symlink only after the new tree validates,
keep the previous one for rollback ([systemd-sysupdate](https://www.freedesktop.org/software/systemd/man/latest/systemd.offline-updates.html)
applies the same A/B model at the OS level). It is also the only way to get rollback at all: an in place
overwrite has nothing to roll back to.

### 2. Preparing is separate from activating, and only preparing is automatic

A timer wakes a small oneshot unit, not the broker. It asks the release feed what the newest eligible
version is, fetches it, verifies it, unpacks it into `versions/<new>`, prepares dependencies with the
frozen lockfile, and runs the new tree's own `preflight` against the machine. If any of that fails, the
directory is deleted and the current version has not been touched. The result is a prepared version and a
record of why it is or is not ready.

### 3. Activation happens at a session boundary, and rolls itself back

Activation is: repoint `current`, restart the service, wait for the new broker to answer `doctor`. If it
does not answer inside a bounded time, repoint `current` back to `previous` and restart again. The
boundary is what protects the person's work: the swap runs only when the broker reports zero open
sessions, and a machine with a session open stays on its current version with the new one sitting ready.
The panel and `status` show that a version is waiting, and the person can say now.

This is where the sentence at the top gets paid for. "Without affecting the current session" is delivered
by waiting for the session to end, not by moving it. The cost is honest and small: a machine that always
has a session open never updates by itself, which is why the pending state has to be visible rather than
silent.

### 4. What makes it automatic, and what keeps that from being a weapon

Automatic updates are an amplifier, and the amplification is measured. A compromised publisher account put
a malicious Nx Console version on the registry for under 40 minutes, and roughly 6,000 machines took it,
mostly through auto update ([VentureBeat](https://venturebeat.com/security/npm-sigstore-provenance-stolen-identity-audit-grid-2026)).
In the same episode 633 malicious versions passed Sigstore provenance verification, because the attacker
held the maintainer's credentials and the signature says who signed, not whether they meant to
([npm provenance](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/),
[Sigstore](https://blog.sigstore.dev/npm-provenance-ga/)). Signing is worth having and it is not the
control that would have helped there.

Two mechanisms carry most of the safety, and they are cheap:

- **A maturation delay.** A version is not eligible until it has been public for a set time, measured in
  days rather than minutes. Every one of those 6,000 installs happened inside 40 minutes. A delay costs a
  fix nothing that matters and takes the attacker's window away.
- **A kill switch, on the machine.** `sbar-orbit update off` stops the timer. It has to work without the
  network and without the broker, because the case it exists for is the one where something is wrong.

Beyond that: verify the archive against the digest manifest the packager already writes
([scripts/package.ts](../scripts/package.ts)), which the source verifier already knows how to check
([scripts/verify-source.ts](../scripts/verify-source.ts)); refuse a version whose major differs, and tell
the person instead; and never run anything that needs `sudo`, which the installer already refuses. Note
plainly what the digest does and does not prove: it ties the tree to the archive, not the archive to a
person. Authenticity today is whoever controls the publishing account.

### 5. What auto update must never do

| Never | Because |
|---|---|
| Activate while a session is open | The session is in-process state and would end with the process |
| Overwrite the tree a running broker executes from | The next `session.create` would pair an old broker with new child scripts |
| Cross a major version by itself | An interface change is a decision, not a fix |
| Run anything requiring elevation | The installer's whole contract is that it needs no root |
| Change a policy, a lease or a permission silently | Autonomy is fixed at session creation and only ever tightens |
| Take a version younger than the maturation delay | That is the window a stolen account gets |

## What has to survive a version change

Workspaces, saved accounts, the diagnostic journal, restore points and the person's configuration all live
outside the source tree and are untouched by a swap. The native runtime does not, which is the second
finding above. Anything a new version reads and an old one wrote needs the ordinary rule: a version reads
what the previous one wrote, or it says so and refuses rather than guessing. Not measured: whether any
on-disk shape has changed between the published alphas in a way that would break a downgrade, which is the
case rollback creates.

## The four decisions, made

The owner handed these back on 14 September 2026 with "decide them yourself". Each is written with the
constraint that settled it, so a later reader can reopen one by attacking its reason rather than its
conclusion.

1. **Activation is silent when the machine is idle and the panel is not on screen, and waits otherwise.**
   The goal is automatic; this project's rule is that the person owns their screen, and activation
   restarts the panel. Idle with no panel visible satisfies both, and needs no mechanism that does not
   already exist. Zero open sessions is a precondition in every case, never waived.
2. **One channel.** Three published alphas and one maintainer. A second channel is a thing to maintain
   that nothing yet tests, and the maturation delay already gives this machine the early exposure a
   second channel would have been for.
3. **The native runtime is shared, outside the versions**, keyed by the package set the bootstrap pins.
   It is the only option that keeps native sessions working across an update without a download, which is
   the second finding above. A version that finds a runtime built at the old path inside a source tree
   adopts it rather than rebuilding, and `preflight` reports which path it found.
4. **The release feed is the npm registry.** `bun add -g` already points there, so this adds no second
   path for the same bytes, and the version metadata the eligibility rules need is already published
   there.

## If it is built, this is the order

Each step is usable on its own, and each has a gate that has to pass before the next one starts.

1. **Prove the hazard.** A test that overwrites a source tree under a running broker and then creates a
   session. Run it against today's layout, where it should fail, because that is the thing the design
   exists to prevent.
2. **Move the native runtime out of the source tree**, shared across versions and keyed by the pinned
   package versions. Gate: a native session works from a tree that never built one.
3. **Versioned layout and `sbar-orbit update activate`**, manual, no timer, no network. Done on
   14 September 2026 in [src/update.ts](../src/update.ts). `versions/<version>` side by side, `current`
   and `previous` repointed by rename so no reader sees the name missing, activation refused while any
   session is open with no way to waive it, and a broker that does not answer `doctor` after its
   restart puts the old link back and restarts again. The failed version is kept rather than deleted,
   because it is the evidence. An install whose launcher does not go through a managed version
   directory is refused by name: a source checkout's updater is git. Seven checks in
   `tests/update.test.ts`, and the three that matter were run against the code with the session guard
   and the rollback removed, where they failed.
4. **`sbar-orbit update check` and `stage`**, network, verification, maturation delay, no activation.
   Done on 14 September 2026. `check` reads the registry document, orders versions the way the registry
   does, refuses a different release line by name, and reports a young version with its age in hours.
   `stage` downloads, checks the archive against the digest the same document published, unpacks with
   the system `tar` and prepares dependencies from the frozen lockfile, into a directory nothing points
   at. Six checks against a fake feed, since a test that reached the registry would be measuring the
   network and one that downloaded a real archive would be installing software as a side effect. `check`
   was also run against the real registry from this checkout, where it answered that this is the newest
   version the feed has.
5. **The timer**, plus `update on|off|run`, plus the pending state in `status`. Done the same day. The
   units are written by every install and enabled by none of it: `update on` is the only thing that
   starts the timer, absence of the switch means off, and the switch is read before the feed, the
   install shape and everything else, so `update off` stops a run with no network and no broker. Daily
   with `RandomizedDelaySec=4h`, so one release does not reach every machine in the same minute, and
   `Persistent=true` so a machine that was asleep still checks once. `sbar-orbit status` and its one line
   summary carry a waiting version, so a machine that never reaches a boundary is explainable rather
   than just out of date.

## What the panel does across a swap, which the first draft of decision 1 had wrong

Decision 1 said activation restarts the desktop panel, and it does not. The panel is a separate process
the person's session started, and nothing in activation touches it: the broker restarts, the panel
reconnects to the same socket, and it keeps running the Python of whichever version it was started from
until the person's next login restarts it. So activation does not reach the person's screen at all, and
the condition about the panel being visible is unnecessary: a boundary is zero open sessions, and that
is the whole of it. What remains true is that a panel and a broker can be from different versions for a
while, which `status` reports rather than hides.

## What is built, and what is still not measured

All five steps are built and their unit gates pass: 22 checks in `tests/update.test.ts`, the three that
guard activation run against the code with the guard and the rollback taken out, where they failed, and
`sbar-orbit update check` run against the real registry, where it answered that this is the newest version
the feed has.

One gate has not been run and this is where it is written down. **An end to end activation on a machine
whose launcher goes through a managed version directory, with real systemd and a real broker, is
`not measured`.** Every activation test injects the restart and the health check, which means the
orchestration is tested and the two commands that reach the machine are not. This host cannot be that
gate: its launcher points at a working checkout, which the updater refuses by design, and pointing it
somewhere else would be an experiment run on the person's own installation. The place for it is the
fresh-machine container in `experiments/fresh-machine/`, which already gives a clean Fedora a real
systemd user session, and the run would be: install from the registry, prepare a second version, activate
it, read `doctor`, break it deliberately, watch the rollback, read `doctor` again.

Also not measured: what a downgrade does to anything a newer version wrote on disk, which is the case a
rollback creates.
