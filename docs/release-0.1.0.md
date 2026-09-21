# 0.1.0

Published on 21 September 2026 to the npm registry as `latest` and to
[GitHub](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.1.0), tagged at `cfb6144`, where all
nine CI jobs passed. The published tarball was downloaded back and is byte identical to the one built
here, SHA-256 `d802f77380cedcfe4165113e85518b2c8eb5496bd07161f8a76b21f36e33a861` over 160 files.

The first release without an alpha tag. Nothing about the code became stable by renaming it: what
changed is that the installation path, the agent surface and the documentation are now the ones a
person meeting this project for the first time can follow without reading its history.

No persisted schema and no service unit contract changed, so an existing installation upgrades in
place and the migration path from `0.1.0-alpha.8` still applies.

## Install

```sh
bun add -g sbar-orbit
sbar-orbit install --connect auto
```

Or from a source checkout:

```sh
git clone https://github.com/M7MMAD-OMAR/sbar-orbit
cd sbar-orbit
./install.sh --connect auto      # Windows: install.cmd --connect auto
```

## Upgrade from an alpha

An automatic update will not cross this line by itself, and that is deliberate: `sameLine` treats a
prerelease and a release as different lines, so a machine on `alpha.9` is told a newer version exists
and left alone. Crossing it is a decision a person makes.

Close Orbit sessions first, because stopping a broker closes them.

```sh
systemctl --user stop sbar-orbit.service
bun add -g sbar-orbit@0.1.0
sbar-orbit install --managed
"$HOME/.local/bin/sbar-orbit" doctor
```

## What changed

- **The broker died on any HTTP response that set a cookie.** Bun sets `IncomingMessage.url` on a
  client response to the request path, where Node leaves it empty; Playwright reads that field as the
  response URL, so its `response.url || url.toString()` fallback never ran and `new URL("/settings/profile")`
  threw inside a socket handler with nothing above it to catch. The broker exited and took every
  session on it, including other agents', with it. Because documents are fetched one hop at a time to
  check redirects, this fired on the first sign-in page a session reached, which is exactly when a
  session started from a real profile is doing its job. `tests/http-response-url.test.ts` fails against
  the unfixed code.
- **An agent could not discover the real-profile capability.** `session.create` has accepted `cloneOf`
  since that path closed, but the MCP adapter exposed neither `cloneOf`, nor `cloneExtensions`, nor
  `policy`, and offered no way to learn a profile path. An agent reading its own tools could only
  conclude Orbit does not do this, and one did, in writing, to the person who built it. There is now
  `profiles.list`, as `sbar-orbit profiles` and as the `orbit_profiles` tool, reporting
  `canCloneProfile`'s verdict for each of the person's browser profiles: a `cloneOf` path where it is
  allowed, the measured reason where it is not. `orbit_create` carries `cloneOf`, `cloneExtensions` and
  `policy`, and the adapter's instructions forbid answering "cannot" without asking first.
- **A rerun of the installer said "Orbit is not installed".** Connecting an agent host is refused when
  an `orbit` entry already exists with different settings, which is correct and protects the person's
  own configuration. It was counted as an installation failure, so a second run of `install.sh
  --connect auto` reported a broken install under a broker that was running. Host connection is now
  reported separately, with the reason and what to do about it, and the installation is judged on its
  own steps. `tests/install-hosts-refused.test.ts` fails against the unfixed code.
- **Project files for a public repository.** A README that states what Orbit is, how to install it and
  how to use it, with the details moved into `docs/`. A supported-systems table on the front page. A
  code of conduct, an `.editorconfig`, and `repository`, `homepage` and `bugs` in `package.json`, which
  were missing, so the registry page carried no links back.

## What is measured, and what is not

Unchanged by this release, and worth repeating rather than burying: Fedora 44 with wlroots and cgroup
delegation is the one host class where every row is a measurement. Windows 11 and macOS are `Limited`,
with browser sessions and installation measured and the private display, the keyring paths and the
managed update path absent. Real-profile sessions are refused on both, for reasons stated in
`docs/support-tiers.md` rather than discovered at runtime.

Display separation is not a security sandbox. Applications keep the OS user's permissions.
