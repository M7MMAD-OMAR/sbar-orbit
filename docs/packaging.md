# Packaging

Orbit packages the native application broker, CLI, MCP adapter, panel and owner
compositor integration. Bun dependencies are the MCP SDK and Zod. No browser
automation library, browser binary, extension, browser viewer or private compositor
runtime belongs to the product.

Use `bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, and
`bun run verify`. The supported suite uses native logic and protocol fixtures,
never browser sessions or substitute desktops. The former `--native` bootstrap
is unavailable. Native opening uses the configured original owner compositor.

A source release and installation are not runtime acceptance. Managed activation
requires an idle broker. Preserve unrelated settings and work. See
[installation](agent-install.md) and [the contract](desktop-only.md).

## Publishing a release

A push to main is not a published release. Update `package.json`, the changelog
and versioned release notes together. The MCP adapter imports the package version.
Run the normal verification suite and the publication checks:

```sh
bun run verify tests/packaging.test.ts tests/public-audit.test.ts
bun run scripts/limited.ts bun scripts/package.ts
bun run scripts/limited.ts bun scripts/registry-package.ts output/packages
```

By default, the source packager reads staged Git blobs; the registry packager
selects tracked paths but reads current working-tree bytes. Stage and review all
release paths before using those legacy defaults. For publication from a shared
checkout, prefer the immutable commit mode below instead. Verify the source manifest after extraction, install frozen
dependencies into an owned temporary directory and run the extracted CLI.
Check the installable package's version, lockfile and checksum separately.

Commit and push the verified source, check the provider run for that exact commit,
then add an annotated version tag. Publish a GitHub release with both artifacts,
SHA-256 files and the versioned notes. Verify that GitHub reports it as the latest
release and that downloaded asset bytes match the local checksums. Registry
publication, if performed, also needs a downloaded archive identity check.
## Immutable commit and hosted build

Both packagers accept `--ref FULL40HEXCOMMIT`. This selects the exact committed
file list, regular blob contents, executable modes and package version. Dirty
tracked/index files and untracked changes cannot enter either artifact. Branches,
short IDs, tag objects, unknown objects and public symlink/gitlink inputs are refused.
Git replacement objects and lazy fetching are disabled. The source manifest
records `sourceCommit`; the registry archive carries `SOURCE-COMMIT.json`. These
are origin records, not cryptographic signatures or runtime acceptance.

```sh
bun run scripts/limited.ts bun scripts/package.ts --ref FULL40HEXCOMMIT
bun run scripts/limited.ts bun scripts/registry-package.ts output/packages --ref FULL40HEXCOMMIT
```

Ref archives deliberately require Linux/GNU tar: sorted ustar entries, fixed
mtime/ownership/modes and gzip without filename/timestamp metadata. Other hosts
fail clearly rather than claiming deterministic output. Defaults retain their
previous portability. Never package a dirty shared checkout with the registry
default while another task is editing runtime modules.

[The build-only hosted workflow](../.github/workflows/package-release.yml) accepts
a complete lowercase `source_ref` and matching root-package `version`. Dispatch the
workflow from reviewed main; it checks out the supplied source commit separately
from the workflow commit. It publishes no release, tag, registry package or website
and receives no publishing/Cloudflare secrets. Official checkout/setup/upload
actions are pinned to resolved commit IDs; Bun is pinned to 1.3.14.

Before setup/install/build, the runner checks available memory, CPU/load, memory
pressure and disk. The serial pipeline then runs inside a kernel-enforced hosted
`sbarorbit.slice`: 1536 MiB memory, 150% CPU, 256 tasks and zero swap. Missing
systemd/cgroup enforcement or failed resource gates abort with no unbounded
fallback. Hosted CI configures only its ephemeral resource controls and, if absent,
a real runner user manager/user bus. It does not install an Orbit broker/plugin or
start a compositor/application. No owner machine is built on or restarted.

Wayland compiler headers, LuaJIT library/interpreter, pkg-config and GCC fixture
prerequisites are installed only on the hosted runner, inside the same bounded
cgroup, with no package upgrade operation or desktop packages. The runner runtime
directory must belong to its actual UID and contain real systemd/private and bus
sockets; user-manager and bus connectivity are checked. The real XDG/DBus session
is forwarded to the bounded build while HOME remains the owned private fixture
directory. No fake sockets or skipped prerequisite assertions are accepted.

The exact source undergoes frozen dependency installation, root typecheck, the
full default verification suite, focused packaging checks and bilingual website
typecheck/tests/build. Both immutable archives are extracted into owned temporary
roots. Source-manifest content/modes, both source-commit records, package version
and lockfiles are checked. Each archive gets frozen dependency installation plus
launcher help, explicit preflight-contract and installer `--dry-run --no-service`
smokes. Hosted absence of native prerequisites may return preflight exit 1, but
only with matching valid JSON; module/parser failures are not ignored. These
smokes establish no desktop/native acceptance or real installation.

On complete success, download these separately named workflow artifacts:

- `release-VERSION-FULL40HEXCOMMIT`: exactly the two versioned archives, each
  SHA-256 file, and aggregate `release-verification.json`.
- `orbit-site-VERSION`: a canonical archive containing `dist/`, its SHA-256 file
  and `site-verification.json` binding the version, source commit and archive hash.
  The output walk is bounded and refuses symlinks. No deployment is performed.

```sh
gh workflow run package-release.yml --ref main -f source_ref=FULL40HEXCOMMIT -f version=0.4.2
gh run watch RUN_ID --exit-status
gh run download RUN_ID -n release-0.4.2-FULL40HEXCOMMIT -D OWNED_RELEASE_DIRECTORY
gh run download RUN_ID -n orbit-site-0.4.2 -D OWNED_SITE_DIRECTORY
```

Verify the run, source SHA, both receipts and downloaded byte digests before
publication. Only then may the separately authorized lead publish the 4 release
assets/npm version and deploy the prebuilt site after its exact links are live.
Do not replace failed verification with a tag or reuse a site artifact from another
source commit. A source/registry archive is not a Windows `.exe` installer.

Never replace an existing tag or versioned artifact. Publishing does not activate
the owner's running service or plugin; that requires its own safe update boundary.
