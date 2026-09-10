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
