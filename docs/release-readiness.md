# Release readiness work

Goal: one clear installation command per supported operating system, working agent
connections, realistic application tests, and measured resource and recovery behavior.
Unsupported capabilities must remain explicit; no finite test matrix proves every device.

## Acceptance checklist

- [ ] Fresh installation starts a usable broker immediately on Linux, Windows and macOS.
- [ ] Installation offers an explicit, repeatable way to register supported agent hosts,
      preserving unrelated configuration and reporting unsupported hosts.
- [ ] Published commands work from a clean source archive and handle missing prerequisites.
- [ ] Cross-platform CI fails on type errors, failing tests and failed runtime checks.
- [ ] Browser and MCP flows verify navigation, text, capture, pause/resume and cleanup.
- [ ] Native application flows run on supported Linux hosts; platform refusals are tested.
- [ ] Resource use, concurrent sessions and crash recovery have current recorded evidence.
- [ ] Release documentation, support table and package commands agree with verified behavior.

## Current findings

- Existing platform workflows deliberately tolerate failures and several shell commands
  replace a failed command's exit status with a successful echo.
- Windows installation now requests immediate startup and verifies the broker.
  Account-specific task names fix a measured collision with another account's task.
  The installed browser flow passes on Windows and Linux; see
  [installed command acceptance](fragments/installed-command-acceptance.md).
- `--connect auto` now registers detected Claude Code, Codex and Hermes hosts.
  Other settings are preserved, changed files receive private backups, conflicting
  registrations are refused, and repeated installation leaves matching entries alone.
  Real Claude and Hermes CLIs connected on Linux; Codex's CLI read its registration.
  On Windows, 28 targeted tests passed and all three serialized entries negotiated
  MCP and listed 12 tools. The host CLIs themselves were absent on that guest.
  Linux also passed the 28 targeted tests and all three protocol checks. An earlier
  run was stopped under pressure from existing broker sessions, then repeated after
  measured memory use fell from about 8 GiB to 2.8 GiB. macOS remains unmeasured for
  this new registration path.
- Local baseline on 19 September 2026 at runtime revision `8874e63`:
  `ORBIT_TEST_NATIVE=1 bun run verify`: 424 pass, 25 skip, 0 fail,
  449 tests across 88 files in 133.35 seconds. Typecheck also passes.
- Strict three-platform workflow added in `fc5071a`, then published through the
  existing SSH credential. Run `35449764946` at `890e03b` completed with failures
  on all three platforms; all three typechecks passed. These failures are open,
  not accepted as platform support evidence.
- Linux reported two failing tests. The action-document control depended on an
  already installed broker. Setting `ORBIT_SOCKET` to a nonexistent path reproduced
  the failure locally. Giving that test its own broker made all five tests pass
  with the same absent external socket, and typecheck passed. Windows path checks
  now decode JSON before comparing paths; POSIX device and FIFO cases are explicitly
  skipped on Windows. Windows execution of these corrections remains unmeasured.
- Windows reported 46 failures and one error. Many browser tests failed at the
  same socket ACL verification step; other failures include POSIX-only assumptions
  and direct execution of the shell launcher. These still require investigation.
  macOS failure logs remain to be triaged.

Record each platform's revision, command, result and limits. A skipped test is not a pass.

## Windows CI module-path diagnosis

Run `35450156822` reproduced the ACL read failure on an ordinary file and an
AF_UNIX socket. Windows PowerShell reported `CouldNotAutoloadMatchingModule`
for `Microsoft.PowerShell.Security` when it inherited the runner's PowerShell 7
module path. The same executable and paths succeeded after removing only
`PSModulePath` from the child environment. The broker now applies that isolation
to its ACL reader and refuses nonzero exits as well as empty reads. ACL assertions
remain enabled. Remote verification of the correction is pending.

## Windows lease cleanup correction

The Windows 11 ordinary-account guest reproduced two failures in the seven
`egress-sweep` checks: a live AF_UNIX listener was treated as dead because its
`lstat` result could not establish a socket. Cleanup now probes the connection
instead of treating failed inspection as absence. The same guest and tests then
returned seven passes, zero failures. Linux cleanup coverage returned eleven
passes across egress and workspace tests; typecheck passed. This establishes the
cleanup primitive on Windows, not namespace confinement on that platform.
