# 0.1.0-alpha.9

This is an experimental alpha, not the stable 1.0 release. It is a fix release. No persisted schema and
no service unit contract changed, so the installation and update path in
[0.1.0-alpha.8](release-alpha8.md) applies unchanged, first migration from an earlier release included.
macOS and Windows still keep browser support only; managed update activation and scheduling still refuse
there until their service integration is implemented and measured.

## Install on Linux

```sh
bun add -g sbar-orbit@0.1.0-alpha.9
sbar-orbit install --managed
"$HOME/.local/bin/sbar-orbit" update status
"$HOME/.local/bin/sbar-orbit" update on
```

## Migrate an earlier installation

Same steps as alpha.8, with the new version. Close all Orbit sessions first, because stopping a broker
closes them and earlier brokers do not implement the update admission protocol.

```sh
systemctl --user stop sbar-orbit.service
bun add -g sbar-orbit@0.1.0-alpha.9
sbar-orbit install --managed
"$HOME/.local/bin/sbar-orbit" doctor
"$HOME/.local/bin/sbar-orbit" update on
```

## What changed

- **`sbar-orbit clean` could not reclaim a workspace holding a restore point.** A restore point is a
  read-only btrfs snapshot, and unlinking inside one answers `EROFS` whatever the path's own
  permissions are. The sweep refused 21 of 192 workspaces on the development host and left 107 GB of a
  108 GB cache in place. It now clears the `ro` property on the subvolumes under each `restore-*`
  directory first, which succeeds without privilege. `tests/workspace-storage.test.ts` holds the
  regression, and it fails against the unfixed code.
- **The Windows process table walk could not survive a cycle.** `windowsDescendants` recursed over one
  `Win32_Process` snapshot with no visited set, and a snapshot can hold a cycle when a pid is recycled,
  so the walk ended the stack instead of returning. It failed `tests/browser-crash.test.ts` on the
  Windows runner with `RangeError: Maximum call stack size exceeded`. The walk now lives in
  `src/process-tree.ts`, is iterative, and visits each pid once. Three of the five new tests in
  `tests/process-tree.test.ts` reproduce the old failure on Linux in 10.20 ms, 14.87 ms and 5.03 ms.
- **The focus monitor misread its own footprint.** Its owned set was read from one cgroup instead of the
  whole subtree, and an empty `cgroup.procs` parsed to `{0}`, which is also the value meaning "no active
  window". A run with no Orbit window therefore reported owning focus. Both are fixed, and the ten
  minute measurement now reads 1197 focus reads with zero focus steals and zero errors.
- **The handoff harness can measure the mechanism without a person.** It attaches to a running broker
  instead of starting one, so a takeover trial can run beside a managed installation, stops its own
  session, counts the input a pause refuses, and drives the participant's side through `session.control`
  with `--auto-participant`. It measures the mechanism and never claims a person.

## Evidence and limits

`v0.1.0-alpha.9` is tagged at `ed355d8`, the revision the cross platform gate ran on. Run 35506995596
passed all nine jobs there with **491 tests across 98 files** discovered on each platform and zero
failures: **Ubuntu 24.04 440 pass, 51 skip; Windows 373 pass, 118 skip; macOS 383 pass, 108 skip**, plus
installed-browser and generated host registration on all three.

The two archives are `sbar-orbit-0.1.0-alpha.9-source.tar.gz` (SHA-256
`e0295494ec0200f3e24f5788d67c6122a54de9ffea59abc424c71ec5f32f5959`, 473 files) and the registry package
`sbar-orbit-0.1.0-alpha.9.tgz` (SHA-256
`dec1006fd42a20e0bb70552998e96496ddbc2e68ad48c0368ab7a9c28e80d67a`, 144 files, 779707 bytes). The
published tarball was downloaded again from the registry and is byte identical to the built one, same
SHA-256 and same file list.

From the extracted source archive: `verify-source` reports `verified: true` for all 473 files,
`bun install --frozen-lockfile --ignore-scripts` installs 100 packages in 104 ms, and the launcher runs
`--help`, `preflight` and `install --dry-run --json` with `installed: true` from the extracted
directory. From the registry, `bun add -g sbar-orbit@0.1.0-alpha.9` into a temporary `BUN_INSTALL`
resolved 95 packages in 27.84 s and the installed command ran.

**The package smoke test did not finish.** It was refused at the browser launch by the shared resource
budget, which another agent's six sessions held at the time: 85 free of 1536 tasks against the roughly
140 a browser session needs. Everything before the launch did run on the exact archive, extraction,
manifest verification, the frozen dependency install and the broker start. The frame capture and the
packaged Canvas viewer are consequently **not measured** for this release, and `not measured` is not a
pass.

**One defect in the registry path is recorded rather than fixed.** From the global registry install,
`preflight` reports the three runtime dependencies as missing, so `browserPrerequisitesFound` is false
and the install report says `browserSessions: false`. The dependencies ARE installed: bun's global
layout puts them at the root of the global `node_modules` (94 entries, siblings of `sbar-orbit`), and
the command runs from there. `src/preflight.ts:28` resolves them against `<source root>/node_modules`
and does not walk up, while Bun's runtime resolution does. `nativePrerequisitesFound: false` is
expected from a registry package instead, because the native runtime is not shipped and
`install --native` reports `native-bootstrap-absent` by design. The dependency part is a real defect,
found by the install-back after the artifact was frozen. It is not fixed in this release.

This is not evidence for macOS or Windows managed updates, for arbitrary distributions, for hardware, or
for a future release that changes persisted schemas or service unit contracts. The local suite also
carried two contention shaped failures and one Windows timing flake on 20 September 2026; all three are
retained in [validation](validation.md) rather than explained away.