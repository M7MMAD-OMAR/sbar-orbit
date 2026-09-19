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

The macOS full suite in that run failed. The earlier run at `3af9051`
passed, but the subsequent run at `0b11302` failed with timeouts in viewer frame
visibility and browser resize. Those intermittent failures remain open until
explained; a successful rerun alone will not establish performance acceptance.

The local native-enabled suite passed with 441 passes, 26 skips and zero failures
across 467 tests in 145.07 seconds on 19 September 2026. The resource wrapper
recorded 147 samples and preserved exit status 0. Minimum host free memory was
5.73 GiB; peak whole-host CPU busy fraction was 0.58. These are whole-machine
observations, not resource use attributable to Orbit or a limit guarantee.

Managed installation plus installed browser acceptance and resource artifacts are
now defined in CI. Their remote results are recorded below. The native host remains
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

## First managed-installation CI results

Run `35451273900` installed and connected all requested hosts on Windows and
macOS, with the managed broker answering doctor, but their installed browser
checks failed afterwards. Windows could not join the shared job object from the
probe process; macOS returned BACKEND_FAILED during session creation. Neither
browser acceptance is closed by the successful installation alone.

Ubuntu exposed an unquoted ExecStart executable when the installation prefix
contains spaces. A regression using the real systemd unit parser failed against
the old builder, then passed for spaces, a literal percent specifier and a dollar
sign after quoting the executable and escaping percent specifiers. The broker
and updater units share this correction, and drift detection decodes the quoted
path. Nineteen service and drift checks passed locally. Remote acceptance of the
correction is pending.

The same installed-command probe passed on the ordinary-account Windows 11 guest
in 5692 ms after the limiter was changed to refuse a failed job assignment before
spawning its child. The CI assignment failure therefore remains specific to the
unexplained runner context, not reproduced by this guest. Assignment errors now
retain the Win32 error number before the membership check overwrites it. This is
diagnostic evidence and stricter refusal, not a claim that the CI failure is fixed.

Run `35451744936` passed the full managed installation and installed-browser flow
on Ubuntu, including a prefix containing spaces and all three requested host
registrations. The captured 1280 by 800 frame was inspected and its random heading
was visible. This is a fresh runner with prerequisites provisioned, not installation
on a physical desktop without Bun.

The Windows CI probe now reports Win32 assignment error 5. A nonempty job can only
accept an already-jobbed process within a compatible hierarchy, as described by
[Microsoft's AssignProcessToJobObject contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).
The acceptance driver previously created separately bounded subprocesses from an
unbounded parent. The next run places the driver itself inside the shared budget
before installation, preserving one ancestor for those subprocesses. Whether this
resolves the runner refusal remains to be measured.

The macOS installed flow also reports its specific failure now: Chrome remains
running but does not publish its endpoint within 20 seconds. Failure diagnostics
now distinguish a supervisor that recorded browser startup from one that has not
written its startup report, without exposing profile paths. Deadlines remain unchanged.

## Current acceptance at c759570

[Run 35452033353](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35452033353)
passed the full bounded suites on Ubuntu and Windows, and generated MCP host
registration checks on all three platforms. Managed installation followed by the
installed browser flow passed on both Ubuntu and Windows. The Windows acceptance
now runs its driver inside the shared resource ancestor; the previous run failed
job assignment with error 5. This result supports the corrected process hierarchy
for this runner, without broadening Windows containment claims.

The macOS managed installation flow still failed, this time while producing a
frame within the default 3000 ms capture budget. Unlike the previous endpoint
startup failure, this run reached frame capture. Neither increasing the timeout
nor a successful rerun alone establishes acceptable performance. The next
investigation must distinguish capture latency from browser startup latency and
retain evidence for the failing operation. The macOS full suite finished with 362 passes, 103 skips and three failures:
MCP multi-client control, viewer report download, and viewer session rail.
The installed command probe now retains per-command timings beside its capture
artifact, including the failing command, without recording session identifiers or
action contents. This supplies stage evidence before changing capture behavior.

## Fresh archive dependency isolation

A local registry archive trial found that Bun resolved dependencies from its global
cache even though the extracted release had no node_modules. The installer then
reported dependencies as already resolved, bypassing its frozen install step.
A regression with dependencies only in a parent directory failed before the fix
and passed afterward. Preflight now requires a local package manifest and a
resolution inside that release's node_modules directory.

The actual extracted registry archive then installed its frozen dependencies,
linked the command and registered all three hosts successfully in isolated
configuration directories. This local trial used --no-service to avoid changing
the workstation's managed installation. Seventeen preflight and installer tests
passed, as did typecheck. CI managed acceptance now builds and extracts the registry
archive outside the checkout, verifies dependencies are initially absent, and
requires the installer to prepare them before running its existing browser flow.
Bun and a browser remain provisioned prerequisites; their installation is not
covered by this trial.

## Scheduling comparison correction

The earlier macOS scheduling experiment ran through limited.ts, which already
backgrounds its descendants. Its nominal foreground arm only omitted an additional
background request and never cleared the inherited class. Its old ratios therefore
do not isolate scheduling cost and cannot rule that cause out.

The revised disposable-CI experiment keeps registered process-group accounting,
resets only its own inherited background class, and reads the actual browser's
kernel flag in both arms. A mismatch fails the experiment. It also measures frame
capture with the existing 3000 ms budget, retains failures and avoids treating a
small sample as a platform-wide conclusion. Apple's
[taskpolicy implementation](https://github.com/apple-oss-distributions/system_cmds/blob/main/taskpolicy/taskpolicy.c)
uses `-B -p PID` to clear this scheduling class. Production scheduling is unchanged.
The corrected experiment's remote measurement remains pending.

The first registry-archive acceptance passed installation and browser use on
Ubuntu and macOS. Windows failed before entering the installer: Bun's implicit
batch-file invocation split the extracted source path at a space. A Windows 11
ordinary-account probe reproduced exit 1 and the split-path error with a real
batch file; invoking that same file through PowerShell with literal arguments
returned exit 0 and preserved an argument containing spaces. CI now uses that
invocation for the Windows installation script. This is a harness correction;
managed Windows installation from the archive still awaits its remote result.


The revised comparison initially refused to run: external `taskpolicy -B -p`
returned success but the inherited internal background flag remained set. Apple's
[kernel implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)
selects internal policy when caller and target are the same process, and external
policy otherwise. The experiment now invokes setpriority for itself through FFI,
then still requires the kernel flag to be cleared before measuring. No production
scheduler or resource boundary is changed.

The local native-enabled full suite at f3e099f passed 443 tests, skipped 26 and
failed none across 469 tests in 91 files, in 131.78 seconds. This includes the
archive contents and local-dependency regression tests added above.
