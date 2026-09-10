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

## Use

```sh
sha256sum -c sbar-orbit-0.1.0-alpha.1-source.tar.gz.sha256
tar -xzf sbar-orbit-0.1.0-alpha.1-source.tar.gz
cd sbar-orbit-0.1.0-alpha.1-source
bun install --frozen-lockfile --ignore-scripts
./bin/sbar-orbit serve
```

The smoke test extracts the exact archive, verifies its manifest, installs frozen dependencies, starts the broker outside its directory, captures a browser frame, opens the packaged Canvas viewer and stops its processes. Temporary installed dependencies are removed afterward. Browser profiles remain retained on disk.

## Release discipline

- Use `MAJOR.MINOR.PATCH-alpha.N` for experimental releases and an annotated `v` tag at the tested commit.
- Keep the version, MCP metadata and changelog aligned.
- Scan the index, committed history and extracted archive for secrets and local identifiers.
- Never overwrite an already published artifact. Keep its digest with its release assets.
- The Apache-2.0 license and NOTICE cover project source; dependencies retain their own licenses.

No GitHub remote, hosted release, global service or system installer is created by these commands. Removing an extracted program directory does not remove account snapshots or retained browser workspaces.

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

Removal deletes only the recognized launcher link. Source versions, dependencies, accounts and retained browser workspaces stay in place. It refuses ordinary files, unrelated links and symlinked prefix/bin directories. A missing or invalid source makes a link unrecognizable; inspect it manually instead of forcing removal. A concurrent or interrupted install lock causes refusal; inspect `PREFIX/bin/.sbar-orbit-install-lock` before retrying. No lock is automatically declared stale.

Filesystem tests cover install, upgrade, rollback, removal, preserved data, refused collisions and failed replacement. The real checkout launcher also returned help through a temporary prefix outside the checkout. These checks launch no browser or agent. Fresh-machine dependency installation and a complete installed native runtime remain unverified.
