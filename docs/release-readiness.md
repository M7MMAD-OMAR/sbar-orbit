# Release readiness work

Goal: one clear installation command per supported operating system, working agent
connections, realistic application tests, and measured resource and recovery behavior.
Unsupported capabilities must remain explicit; no finite test matrix proves every device.

## Acceptance checklist

- [ ] Fresh installation starts a usable broker immediately on Linux, Windows and macOS.
- [x] Installation offers an explicit, repeatable way to register supported agent hosts,
      preserving unrelated configuration and reporting unsupported hosts.
- [ ] Published commands work from a clean source archive and handle missing prerequisites.
- [x] Cross-platform CI fails on type errors, failing tests and failed runtime checks.
- [ ] Browser and MCP flows verify navigation, text, capture, pause/resume and cleanup.
- [ ] Native application flows run on supported Linux hosts; platform refusals are tested.
- [ ] Resource use, concurrent sessions and crash recovery have current recorded evidence.
- [ ] Release documentation, support table and package commands agree with verified behavior.

## Latest verified state

At `e7576a6`, [run 35450920294](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35450920294)
passed the full bounded suite on Ubuntu (418 pass, 49 skip, zero fail) and Windows
(356 pass, 111 skip, zero fail). The same run passed the
installation and generated MCP registration probe on all three platforms. That
probe configures Claude Code, Codex and Hermes, then negotiates each actual entry;
it does not claim the native host CLI exists when it is absent.

The macOS full suite in that run is still pending. The earlier run at `3af9051`
passed, but the subsequent run at `0b11302` failed with timeouts in viewer frame
visibility and browser resize. Those intermittent failures remain open until
explained; a successful rerun alone will not establish performance acceptance.

The local native-enabled suite passed with 441 passes, 26 skips and zero failures
across 467 tests in 145.07 seconds on 19 September 2026. The resource wrapper
recorded 147 samples and preserved exit status 0. Minimum host free memory was
5.73 GiB; peak whole-host CPU busy fraction was 0.58. These are whole-machine
observations, not resource use attributable to Orbit or a limit guarantee.

Managed installation plus installed browser acceptance and resource artifacts are
now defined in CI. Their first remote results are pending. The native host remains
Fedora; the Windows guest and CI runners do not establish physical-device support.

## Investigation history

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
  measured memory use fell from about 8 GiB to 2.8 GiB. the later three-platform CI probe now covers
  this registration path on macOS too.
- Local baseline on 19 September 2026 at runtime revision `8874e63`:
  `ORBIT_TEST_NATIVE=1 bun run verify`: 424 pass, 25 skip, 0 fail,
  449 tests across 88 files in 133.35 seconds. Typecheck also passes.
- Strict three-platform workflow added in `fc5071a`, then published through the
  existing SSH credential. Run `35449764946` at `890e03b` completed with failures
  on all three platforms; all three typechecks passed. These initial failures were investigated below; their original result is
  retained as the baseline, not support evidence.
- Linux reported two failing tests. The action-document control depended on an
  already installed broker. Setting `ORBIT_SOCKET` to a nonexistent path reproduced
  the failure locally. Giving that test its own broker made all five tests pass
  with the same absent external socket, and typecheck passed. Windows path checks
  now decode JSON before comparing paths; POSIX device and FIFO cases are explicitly
  skipped on Windows. The later Windows full suite verified these corrections.
- Windows reported 46 failures and one error. Many browser tests failed at the
  same socket ACL verification step; other failures include POSIX-only assumptions
  and direct execution of the shell launcher. The later Windows full suite passed after the
  corrections. macOS timeout failures remain open as described above.

Record each platform's revision, command, result and limits. A skipped test is not a pass.

## Windows CI module-path diagnosis

Run `35450156822` reproduced the ACL read failure on an ordinary file and an
AF_UNIX socket. Windows PowerShell reported `CouldNotAutoloadMatchingModule`
for `Microsoft.PowerShell.Security` when it inherited the runner's PowerShell 7
module path. The same executable and paths succeeded after removing only
`PSModulePath` from the child environment. The broker now applies that isolation
to its ACL reader and refuses nonzero exits as well as empty reads. ACL assertions
remain enabled. The Windows full suite in run `35450920294` passed with the correction.

## Windows lease cleanup correction

The Windows 11 ordinary-account guest reproduced two failures in the seven
`egress-sweep` checks: a live AF_UNIX listener was treated as dead because its
`lstat` result could not establish a socket. Cleanup now probes the connection
instead of treating failed inspection as absence. The same guest and tests then
returned seven passes, zero failures. Linux cleanup coverage returned eleven
passes across egress and workspace tests; typecheck passed. This establishes the
cleanup primitive on Windows, not namespace confinement on that platform.
