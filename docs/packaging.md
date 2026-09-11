# Source releases

The first public version is `0.1.0-alpha.1`. It is a source archive requiring Bun, Linux cgroup delegation and Chrome/Chromium. Native runtime dependencies are separate. It is not a standalone installer.

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
sha256sum -c sbar-orbit-0.1.0-alpha.1-source.tar.gz.sha256
tar -xzf sbar-orbit-0.1.0-alpha.1-source.tar.gz
cd sbar-orbit-0.1.0-alpha.1-source
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

No GitHub remote, hosted release, global service or system installer is created by these commands. Removing an extracted program directory does not remove account snapshots, nor any workspace a killed broker left behind; `sbar-orbit clean` does the latter.

## Activate a local source installation

The current checkout adds a launcher-link manager. It is not included in the older `0.1.0-alpha.1` archive. Keep the source in a stable directory, verify the release digest, and prepare dependencies with `bun install --frozen-lockfile --ignore-scripts` first. Use only trusted source: package-name checks recognize Orbit but do not authenticate a release.

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

The JSON report separates browser and native prerequisites, gives a remedy for missing items, and lists what is not verified. Exit status is 0 when browser prerequisites are found, otherwise 1. Inspect `nativePrerequisitesFound` separately if using native apps. This is an availability check, not a successful runtime or resource-acceptance result.

Browser candidates currently match the owned launcher: `/opt/google/chrome/chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`. Native files must exist in this source version's `.runtime/sway`, alongside system Python, Xwayland, grim and wl-clipboard. The existing native bootstrap is `experiments/fedora-display/bootstrap.sh`; inspect its pinned Fedora package versions before using it on another release. Shared-library compatibility, cgroup delegation, private disk-backed storage and real application behavior need separate validation.

On the development workstation the read-only command found both prerequisite groups. Three focused tests cover missing browser/native/common inputs, unsupported OS, executable-check semantics and standalone invocation without ORBIT_SOCKET. No live trial was restarted for this check.
