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

The source packager reads staged Git blobs. Stage and review all release paths
before packaging. Verify the source manifest after extraction, install frozen
dependencies into an owned temporary directory and run the extracted CLI.
Check the installable package's version, lockfile and checksum separately.

Commit and push the verified source, check the provider run for that exact commit,
then add an annotated version tag. Publish a GitHub release with both artifacts,
SHA-256 files and the versioned notes. Verify that GitHub reports it as the latest
release and that downloaded asset bytes match the local checksums. Registry
publication, if performed, also needs a downloaded archive identity check.
Never replace an existing tag or versioned artifact. Publishing does not activate
the owner's running service or plugin; that requires its own safe update boundary.
