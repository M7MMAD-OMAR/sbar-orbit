# Automatic updates

A study, not an implementation. Nothing described here is built, and every measurement in it is marked.
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
at the next `session.create`. Not measured: what that pair actually does, which is a test worth writing
before any updater exists, since it is the failure a naive `git pull` or an in place `bun add -g` causes
on a machine with work open.

**The native runtime is inside the source directory.** `nativeRuntimePaths` resolves
`<source>/.runtime/sway` ([src/runtime-paths.ts:5](../src/runtime-paths.ts)), 9.9 MB on this host. A new
version in a new directory starts with none of it, so every native session on that machine would stop
working after an update until someone reran `./install.sh --native`, which downloads and compiles. An
update that silently removes a capability is worse than no update. This has to be decided before an
updater ships, and it is a relocation with its own compatibility question, so it belongs in its own step:
the runtime moves to a shared location outside the versioned tree, keyed by the package versions the
bootstrap pins, or activation carries the built runtime forward.

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

## Decisions that are the owner's, not mine

1. **May an update activate on its own at an idle moment, or must the person always say now?** The stated
   goal is automatic. This project's own rule is that the person owns their screen, and activation
   restarts the desktop panel, which is visible. A middle position exists: activate silently when the
   broker is idle and the panel is not on screen, ask otherwise.
2. **One channel or two.** A single stable channel is less to maintain and less to explain. Two lets this
   machine run ahead of everyone else's, which is the only way a maturation delay gets tested by anyone.
3. **Where the native runtime lives.** Shared outside the versions, or rebuilt per version. Shared is the
   only one that keeps native sessions working across an update without a download.
4. **The release feed.** The npm registry, which is where `bun add -g` already points, or the GitHub
   releases this project already signs with a digest. The registry is simpler; the releases carry the
   manifest the source verifier already reads.

## If it is built, this is the order

Each step is usable on its own, and each has a gate that has to pass before the next one starts.

1. **Prove the hazard.** A test that overwrites a source tree under a running broker and then creates a
   session. Run it against today's layout, where it should fail, because that is the thing the design
   exists to prevent.
2. **Move the native runtime out of the source tree**, shared across versions and keyed by the pinned
   package versions. Gate: a native session works from a tree that never built one.
3. **Versioned layout and `sbar-orbit update activate`**, manual, no timer, no network. Gate: activate,
   `doctor` answers, roll back, `doctor` answers again, and a session open at the time is refused with a
   reason rather than ended.
4. **`sbar-orbit update check` and `stage`**, network, verification, maturation delay, no activation.
   Gate: a tampered archive is refused, and a version younger than the delay is reported as not eligible.
5. **The timer**, plus `update on|off|status`, plus the pending state in `status` and on the panel.
   Gate: a machine left alone with a session open stays on its version and shows the pending one.

Nothing in this file is measured except the three source findings and the layout of this host. The rest is
a design, and it stays `not measured` until it runs.
