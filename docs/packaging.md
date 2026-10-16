# Packaging and installation

Orbit is desktop-only. Package creation, release publication, installation and
native application acceptance are separate steps. An archive or healthy broker
does not prove that an application can be controlled.

## Prepare one reviewed source tree

Install frozen dependencies with `bun install --frozen-lockfile --ignore-scripts`.
Review the public paths, version metadata, license notices and current capability
limits. Stage every intended addition, modification and deletion. Both archives
must describe the same reviewed revision with no unreviewed working-tree changes.
Never replace an existing version or published archive.

Run one bounded command at a time:

```sh
bun run scripts/limited.ts bun run scripts/public-audit.ts
bun run scripts/limited.ts bun run typecheck
bun run verify
bun run verify tests/packaging.test.ts tests/agent-contract.test.ts tests/service-paths.test.ts tests/macos-service-simulation.test.ts
bun run scripts/limited.ts bun run scripts/package.ts
bun run scripts/limited.ts bun run scripts/registry-package.ts output/packages
```

`scripts/package.ts` builds the source archive in `output/packages` from Git index
bytes and executable modes. It adds a SHA-256 source manifest and an archive
checksum. An extracted source archive can instead be repackaged from its verified
manifest. Private paths, credentials, dependency directories and generated output
are excluded by the public source policy.

`scripts/registry-package.ts` selects tracked public paths, reads their current
working-tree bytes, applies Bun's package file selection and restores the exact
tracked `bun.lock`. It refuses symlinks and an existing output archive. Untracked
files do not ship. Publish this completed `.tgz`, not an implicit repack of the
working directory. Source and registry packaging use different byte sources, so
check index and working-tree agreement before building them.

## Verify an extracted source archive

```sh
bun run scripts/limited.ts bun run scripts/verify-source.ts /path/to/extracted-source
```

Verify the archive digest against the chosen release channel separately. The
manifest check establishes content consistency, not publisher authentication or
application runtime acceptance. The former browser-based package smoke experiment
is not a current desktop release gate and must not be used as desktop evidence.

## Install the selected source

Use the extracted source or the intended checkout:

```sh
./install.sh --dry-run --json
./install.sh --connect auto --json
```

Windows uses `install.cmd` for installation contracts, but native Windows desktop
control is not implemented. Native macOS desktop control is also not implemented.
The authoritative report fields, exit codes, remediation rules and host-registration
contract are in [agent installation](agent-install.md).

The installer checks prerequisites, prepares dependencies, links the command,
configures the supported service and requested host connections, and checks broker
health. It never grants native application support merely because installation
succeeded. A running host must reload its MCP configuration after registration.
Service activation can affect existing sessions; package publication itself does
not restart the broker.

## Native prerequisites and measured limits

The private desktop currently requires Linux and the supported private compositor
runtime. The Fedora bootstrap lives in the repository under
`experiments/fedora-display/bootstrap.sh`; registry-format packages do not carry
that experimental bootstrap or runtime binaries. `--native` cannot build a runtime
from a package that omits it. Missing dependencies and unsupported environments
must return the installer's explicit remedy, not browser fallback.

Run `ORBIT_TEST_NATIVE=1 bun run verify` only where the required native runtime is
available. Keep skipped tests and unsupported systems visible as not measured.
The existing-owner handoff remains under the
[compositor incident release hold](native-handoff-incident.md). New private launches
are not access to existing signed-in sessions and private HOME is not a universal
filesystem sandbox. See [desktop capabilities](desktop-only.md).

## Publish and deploy

Publish source and registry-format artifacts with their checksums against the same
reviewed commit and new version. Verify downloaded artifact identity after publication.
GitHub and the package registry are separate destinations. Historical artifacts and
reports describe their original source revisions, not the current checkout.

The [website deployment](../website/README.md) is a separate Cloudflare operation.
A Git push does not deploy the website, activate the installed broker or remove a
native capability hold. Retain Apache-2.0, NOTICE and dependency license obligations.
