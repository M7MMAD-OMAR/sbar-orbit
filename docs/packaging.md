# Source releases

The first release published to the npm registry is `0.1.0-alpha.3`, on 13 September 2026, as `sbar-orbit`, and `0.1.0-alpha.4` followed it the same day with the packaging fixes below; a published version is immutable, so `0.1.0-alpha.3` still carries what it shipped with. `0.1.0-alpha.1` and `0.1.0-alpha.2` were tagged and packaged locally and never published, so nothing but this repository's history refers to them. A release is a source archive requiring Bun, Linux cgroup delegation and Chrome/Chromium. Native runtime dependencies are separate. It is not a standalone installer.

## Build

From a Git checkout with the intended source tracked:

```sh
bun run scripts/public-audit.ts
bun run scripts/limited.ts bun run scripts/package.ts
bun run scripts/limited.ts bun run experiments/package-smoke.ts
```

The packager uses the tracked public file set, not a recursive copy of local directories. An extracted source release can use its source manifest instead. Private records, profiles, dependencies, runtime binaries and generated outputs are rejected as package inputs. A SHA-256 manifest covers every packaged source file.

When repackaging an extracted release, current tooling verifies every listed content digest, required release files and package-version consistency first. It rejects duplicate/private paths, symlinks anywhere below the selected source root and multiply linked files. Verified bytes are retained for copying, rather than reread later. Unlisted files are not copied. Bounds are 5000 entries, 10 MiB per source file and 64 MiB total source content.

To verify an existing extracted release using the current checkout:

```sh
bun run scripts/limited.ts bun run scripts/verify-source.ts /path/to/extracted-source
```

This checks content consistency, not publisher identity; verify the archive digest from a trusted release channel separately. It does not authenticate file permission metadata. A concurrent same-user filesystem writer is outside this check's security boundary. Modifications intended for a new release should be reviewed and committed in Git, with a new version, instead of repackaging an altered release against its old manifest.

The verifier accepted all 98 source entries in the existing `0.1.0-alpha.1` archive. A packager regression test accepted altered content before the fix and rejected it afterward. No browser or agent was launched for these checks, and the original release archive was not overwritten.

## Use

```sh
sha256sum -c sbar-orbit-0.1.0-alpha.3-source.tar.gz.sha256
tar -xzf sbar-orbit-0.1.0-alpha.3-source.tar.gz
cd sbar-orbit-0.1.0-alpha.3-source
bun install --frozen-lockfile --ignore-scripts
./bin/sbar-orbit serve
```

The smoke test extracts the exact archive, verifies its manifest, installs frozen dependencies, starts the broker outside its directory, captures a browser frame, opens the packaged Canvas viewer and stops its processes. Temporary installed dependencies are removed afterward, and the broker removes its workspace when it stops.

## Release discipline

- Use `MAJOR.MINOR.PATCH-alpha.N` for experimental releases and an annotated `v` tag at the tested commit.
- Keep the version, MCP metadata and changelog aligned.
- Scan the index, committed history and extracted archive for secrets and local identifiers.
- Never overwrite an already published artifact. Keep its digest with its release assets.
- The Apache-2.0 license and NOTICE cover project source; dependencies retain their own licenses.

These commands create no hosted release, no global service and no system installer. The repository
itself is published at <https://github.com/M7MMAD-OMAR/sbar-orbit>; publishing a release there is a
separate and deliberate step, and nothing in this file does it for you. Removing an extracted program directory does not remove account snapshots, nor any workspace a killed broker left behind; `sbar-orbit clean` does the latter.

## The whole installation in one command

```sh
./install.sh
```

This is the checkout's one command installation. It is a driver over the steps documented in the rest
of this file rather than a second implementation of any of them: prerequisites come from
`inspectPrerequisites`, the command link from `activateLocal`, the units from `installService` and
`enableAutostart`, and the closing check is a real `doctor` call to the managed broker. It runs inside
the same shared resource budget as every other Orbit entry point, through `scripts/limited.ts`.

Six steps, each reported as it happens, with the reason beside it when one does not pass:

| Step | What it does | What it refuses to do |
|---|---|---|
| Check what this machine already has | Reads prerequisites only | Never starts a browser, compositor or broker |
| Prepare project dependencies | `bun install --frozen-lockfile --ignore-scripts` | Skipped when the modules already resolve; no lifecycle scripts, ever |
| Link the sbar-orbit command | `activateLocal` into the prefix, default `~/.local` | Never edits shell configuration, and never puts the prefix on PATH for you |
| Install the broker service and desktop entries | The units, the panel autostart pair, then enable and start | Nothing that needs elevation, so a full logout still needs `loginctl enable-linger` |
| Write the agent connector configuration | `~/.config/sbar-orbit/mcp.json`, Orbit's own directory | Never writes into an agent host's configuration; the command to register it is printed instead |
| Verify the installed broker answers | One `doctor` call on the managed socket | Does not claim the browser, the display or any application works |

`--json` prints the report and nothing else, which is how an agent runs this: the report's shape, the
exit codes and the refusals are a contract in [agent-install.md](agent-install.md), checked against the
program by `tests/agent-contract.test.ts` so the document cannot drift away from it.

Options are `--prefix PATH`, `--no-service`, `--dry-run`, `--reinstall-deps`, `--json` and `--plain`.
A dry run reports every step and writes nothing, which is the safe way to read what it would do on a
machine you have not installed on before.

What it cannot do, and says so rather than failing later: it does not install Bun, since it is running
on Bun; it does not install a browser, Xwayland, grim or wl-clipboard, since those need a package
manager and elevation. Each of those remedies names the software in `packages` and builds its command
for whichever package manager the machine has, so the report is not written for one system. Each missing item is printed with the remedy `inspectPrerequisites` already carries for
it, gathered at the end under a heading that says these are left for the person. A remedy is a record
rather than a sentence: an id, a message, sometimes a command, and two separate flags.
`needsElevation` describes the command, a package manager and a person. `agentMayRun` is the
permission, and it is the one to branch on: putting a directory on PATH needs no elevation and is
still not an agent's to do, because it is the person's shell configuration. Those fields are what let
any agent, of any brand, act on the report without reading English prose.

The final report is installation state, not a measurement. It ends with the sentence saying so, because
a run that has linked a command and started a service has not shown that a browser session works on this
host, and the gates that would show it live in [validation.md](validation.md).

Tested with nine checks in `tests/install.test.ts`: a dry run that leaves the filesystem untouched, a
real install into a temporary prefix with no service, a refused source that is not an Orbit checkout,
the separation between prerequisites a dependency install can fix and ones it cannot, PATH membership,
and the display in both its terminal and non terminal forms. No test spawns a package manager.

## Install from a package registry

Two things the registry path had wrong until 13 September 2026, both found by packing rather than by
reading. `bun pm pack` builds from the working tree, not from the git index the source archive uses, so
a listed directory shipped whatever was sitting in it: `0.1.0-alpha.3` carries six `__pycache__` files
nobody meant to publish. The `files` list now excludes them, and `tests/packaging.test.ts` fails if the
tarball ever carries a path git does not track. The same test requires `bun.lock`, which was absent, so
`install --reinstall-deps` could not resolve against the frozen lockfile it names. With the lockfile
shipped, `bun install --frozen-lockfile --ignore-scripts` inside an extracted tarball installs the 100
packages in 319 ms, measured on this host on 13 September 2026.

`install --native` cannot work from the registry package, and now says so instead of failing at a path.
The package ships source, not `experiments/`, so the bootstrap the step spawns is not there. Measured
from an extracted tarball on the same day, `install --native --dry-run --json` reports the native step
`failed` with `this copy of Orbit carries no native bootstrap` and the remedy `native-bootstrap-absent`,
which points at the repository rather than at a command an agent may run. Browser sessions from a
registry install need none of it.

The package is shaped for `bun add -g sbar-orbit` as well as for a source checkout: `package.json` names the launcher as its `bin`, lists only the runtime files (`bin`, `src`, `scripts`, `desktop`, `viewer`, `bun.lock`, `install.sh`, the Markdown docs and the licence notices, 1.1 MB unpacked against 5.72 MB for the whole tree), declares Linux and Bun 1.3 or later, and is no longer marked private. The launcher finds its own source root from its location, so it runs unchanged from `node_modules/sbar-orbit`.

```sh
bun add -g sbar-orbit
sbar-orbit install --dry-run
sbar-orbit install
```

`0.1.0-alpha.4` was published on 14 September 2026 and installed back from the registry into a temporary `BUN_INSTALL` home: 95 packages resolved, `--help` and `preflight` ran from `global/node_modules/sbar-orbit`, `install --dry-run --json` reported `installed: true`, and `install --native --dry-run --json` reported the native step failed with `native-bootstrap-absent`, which is the intended answer there. The published tarball is 106 files, shasum `da60f2faf1bd0bc865d54cdaaa47d63f2ce1778a`, matching what `bun publish` packed, with the lockfile present and no `__pycache__`. The publish itself is worth one note: the registry staged the version and reported success while `npm view` still showed only the previous one, for about three minutes, and a retry inside that window was refused with `Cannot publish over previously staged version` rather than replacing it. Wait and re-read the registry rather than republishing.

`0.1.0-alpha.3` was published to the npm registry on 13 September 2026 and installed back from it into a temporary `BUN_INSTALL` home: `bun add -g sbar-orbit@0.1.0-alpha.3` resolved 95 packages, and from that install `--help`, `preflight` and `install --dry-run --json` ran with the source root under `global/node_modules/sbar-orbit` and `installed: true` on the dry run. Before that, the same was measured from a tarball built by `bun pm pack`: installed into a temporary consumer project with `bun add ./sbar-orbit-0.1.0-alpha.2.tgz`, and globally into a temporary `BUN_INSTALL` home so the person's own global installs were untouched. From both, `sbar-orbit --help`, `preflight`, `doctor --report` and `install --dry-run --json` ran and reported the same steps and the same source root as a checkout does, with `installed: true` on the dry run and the one remedy this host always reports, the untracked native runtime. That is tier `Limited` for the registry path: the published version resolves and installs, and the installer plans from it, on this host. It does not show that a fresh machine's `bun add -g` puts the launcher on `PATH`, or that `install` completes from there; the checkout path in the section above is the one that was run to completion. Publishing is `bun publish --access public` by a maintainer with a registry token, after the version in `package.json` and the changelog agree; the registry requires two-factor authentication or a granular token that bypasses it.

Native sessions need the private display runtime as well, and `./install.sh --native` builds it from the tracked bootstrap: three pinned Fedora packages downloaded and unpacked without installing, two protocol files checked against their digests, and the pointer helper compiled with the system C toolchain. It is opt-in, skipped when the runtime is already present, and refuses with the exact `dnf` line when the build tools are missing. Measured 13 September 2026 on this host, and in the clean Fedora 44 container once its image carried the compiler and the runtime packages: there the bootstrap completes and the compositor it built reports `sway version 1.11`. The first container attempt is why the runtime packages are named at all: the build succeeded and sway could not load `libevdev.so.2`, because the bootstrap unpacks its packages and the libraries they need are the machine's own.

## Activate a local source installation

The launcher-link manager arrived after the `0.1.0-alpha.1` archive, which does not carry it, and is part of `0.1.0-alpha.2`. Keep the source in a stable directory, verify the release digest, and prepare dependencies with `bun install --frozen-lockfile --ignore-scripts` first. Use only trusted source: package-name checks recognize Orbit but do not authenticate a release.

From the prepared source directory:

```sh
bun run scripts/limited.ts bun run scripts/local-install.ts install "$PWD" "$HOME/.local"
"$HOME/.local/bin/sbar-orbit" --help
```

This creates only the prefix directories and `bin/sbar-orbit` link. It does not install Bun, browser/native dependencies, a background service or host-specific MCP configuration. Add the prefix's `bin` to PATH yourself if needed. Existing shell configuration is untouched.

To upgrade, prepare the next version in a different directory and run the same install command from there with the same prefix. The command atomically switches the link, retaining both source versions. To roll back, run it from the earlier directory. Existing running brokers continue using their original code; stop them through their normal lifecycle before restarting from another version.

To remove the command, while the linked source directory still exists:

```sh
bun run scripts/limited.ts bun run scripts/local-install.ts uninstall "$HOME/.local"
```

Removal deletes only the recognized launcher link. Source versions, dependencies, accounts and any workspace a killed broker left stay in place. It refuses ordinary files, unrelated links and symlinked prefix/bin directories. A missing or invalid source makes a link unrecognizable; inspect it manually instead of forcing removal. A concurrent or interrupted install lock causes refusal; inspect `PREFIX/bin/.sbar-orbit-install-lock` before retrying. No lock is automatically declared stale.

Filesystem tests cover install, upgrade, rollback, removal, preserved data, refused collisions and failed replacement. The real checkout launcher also returned help through a temporary prefix outside the checkout. These checks launch no browser or agent. Fresh-machine dependency installation and a complete installed native runtime remain unverified.

## Check prerequisites without starting a session

```sh
./bin/sbar-orbit preflight
```

This new checkout command requires Bun, but no broker socket or installed project dependencies to load its checks. It only checks files, executable permissions and module resolution. It does not start a browser, compositor, broker or system service, download anything, or record personal paths. `doctor` remains the separate command for a running broker.

It also asks whether a systemd user manager is actually running for this account, rather than only whether `systemctl` is installed. A container image carrying the binary with nothing behind it used to read as available here while the install that needs it refused seconds later, which is a green check on a machine where the thing cannot work.

Native prerequisites are the one group a fresh machine cannot satisfy from a source release: the private compositor and the pointer helper live in an untracked runtime directory that never leaves the development workstation, so `experiments/fedora-display/bootstrap.sh` is the only path to them. Inspect its pinned package versions before using it.

The JSON report separates browser and native prerequisites, gives a remedy for missing items, and lists what is not verified. Exit status is 0 when browser prerequisites are found, otherwise 1. Inspect `nativePrerequisitesFound` separately if using native apps. This is an availability check, not a successful runtime or resource-acceptance result.

Browser candidates currently match the owned launcher: `/opt/google/chrome/chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`. Native files must exist in this source version's `.runtime/sway`, alongside system Python, Xwayland, grim and wl-clipboard. The existing native bootstrap is `experiments/fedora-display/bootstrap.sh`; inspect its pinned Fedora package versions before using it on another release. Shared-library compatibility, cgroup delegation, private disk-backed storage and real application behavior need separate validation.

On the development workstation the read-only command found both prerequisite groups. Three focused tests cover missing browser/native/common inputs, unsupported OS, executable-check semantics and standalone invocation without ORBIT_SOCKET. No live trial was restarted for this check.

## Load the mint extension by hand

`extension/` holds the browser extension that mints narrow, short lived, origin scoped state for a separate Orbit browser, as decided in [the separate workspace review](separate-workspace-review.md). Since 14 September 2026 it has been built, loaded and run, in an Orbit owned headless Chromium 151 with a private profile: `experiments/extension-gates.ts` runs the build line below, loads the shipped manifest unchanged, and records that the worker registers with its click listener and the `cookies`, `storage` and `runtime` APIs bound, in 113 ms. Gates G12 and G14 in [porting](porting.md) closed on that run; G13 stays open because it is about the person's screen. Loading it into the person's own browser is still the person's step, at a moment they choose, and no agent on this workstation does it for them.

```sh
# 1. Build the service worker. The manifest points at dist/, which the repository does not carry,
#    so an unpacked load before this step fails outright.
bun build extension/src/service-worker.ts --target=browser --format=esm --outdir=extension/dist

# 2. Load it: chrome://extensions, turn on Developer mode, "Load unpacked", pick the extension
#    directory. Chrome assigns an extension ID at this point, and it does not exist before it.
#    Branded Google Chrome has ignored --load-extension since 137, measured here on the way to
#    closing G12: the worker never registered. Unpacked through the page is the only way in there;
#    Chromium still honours the flag.

# 3. Fill in the native messaging host manifest with that ID and an absolute path, then install it.
#    On Linux the browser looks under its user data directory, which is why these are the usual
#    paths; a browser started with --user-data-dir reads <that directory>/NativeMessagingHosts
#    instead, and a manifest under $XDG_CONFIG_HOME alone is "not found". Measured.
install -Dm644 extension/host/com.sbarorbit.mint.json \
  ~/.config/google-chrome/NativeMessagingHosts/com.sbarorbit.mint.json
# Chromium reads its own directory instead:
#   ~/.config/chromium/NativeMessagingHosts/com.sbarorbit.mint.json
```

The shipped `extension/host/com.sbarorbit.mint.json` carries obvious placeholders in `path` and `allowed_origins` rather than a plausible looking extension ID. That is deliberate: an ID that looked real would read as though this had been loaded. Both fields have to be edited before Chrome will connect, `path` must be absolute, and `extension/host/mint_host.py` must stay executable.

To remove it: delete the host manifest from the `NativeMessagingHosts` directory, remove the extension from `chrome://extensions`, and delete `extension/dist`. Nothing else on the machine is touched, because nothing else was written. The host program never writes a grant to disk.

What is verified is the pure logic only, in `tests/extension.test.ts` under `bun test`: envelope parsing in both directions, origin and cookie domain scoping, grant lifetimes and expiry, the refusal codes, and the native messaging framing. No browser API is faked in those tests, and passing them says nothing about whether the extension loads or works.
