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

## Alpha.8 candidate, 20 September 2026

Linux managed updates now have an isolated systemd gate: actual registry alpha.6 installation and
migration to the candidate archive, idle upgrade, private-browser busy refusal, broken-startup
rollback with a healthy version response, retained state, timer enable/disable and explicit rollback.
The successor alpha.9 and alpha.10 archives are controlled local fixtures, not published releases.

Local Fedora native verification: **457 passed, 27 skipped, 0 failed**, 484 tests in 97 files,
143.85 seconds. Typecheck passed. Regressions were observed failing before the fixes for stable
launcher indirection, update admission, invalid version paths, timer enable failure, release-channel
selection, archive identity ordering and disabling updates during preparation.

Publication is pending. The installed npm credential returns HTTP 401 from both Bun and the registry
identity endpoint. No package publication is claimed until authentication and registry readback succeed.
See [the alpha.8 guide](release-alpha8.md) for installation, migration and platform limits.

## Previous cross-platform verified state

On 20 September 2026, [run 35482866635](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35482866635)
passed all nine jobs at runtime revision `1399122`: the full bounded suite, fresh
registry-archive installation with a managed browser, and generated MCP host
registration on Ubuntu, Windows and macOS. Typechecks passed on all three hosts.

| Host | Runtime | Passed | Skipped | Failed | Suite duration |
| --- | --- | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 runner | Bun 1.3.14 | 425 | 50 | 0 | 174.48 s |
| Windows runner | Bun 1.4.2 | 361 | 114 | 0 | 166.71 s |
| macOS arm64 runner | Bun 1.3.14 | 371 | 104 | 0 | 202.16 s |
| Local Fedora, native enabled | Bun 1.3.14 | 448 | 27 | 0 | 150.91 s |

Every suite discovered 475 tests in 94 files. Skips represent platform or host
requirements, not passing capabilities. The Windows VM is shut down after checking
that it had no active browser sessions or verification processes. GitHub automatic
verification remains disabled; these were explicitly dispatched checks.

This establishes current passing scenarios, not every physical device or an
installation without Bun, a browser or required OS facilities. Earlier isolated
Linux installer failures and a Windows cold-capture timeout remain unexplained;
subsequent passing runs do not identify their causes. Their diagnostics remain in
place. No failing functional test was deleted or given a longer deadline.

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

## Viewer test setup cleanup

The private viewer test helper did not close its Sessions owner or remove its
workspace when setup rejected before returning the page. A real browser trial
with an invalid viewport reproduced a remaining workspace before the fix. The
helper now closes its owner and removes the workspace on setup failure, as well
as on ordinary teardown. The regression and the full viewer-layout test both
passed locally afterward, and typecheck passed. This fixes a demonstrated cleanup
defect; it does not establish the cause of every macOS timeout.

GitHub verify is temporarily disabled at the user's request after repeated failed
runs generated unwanted notifications. Run 35476489102 was cancelled. No new
pushes or CI runs are authorized until the outstanding failures are addressed and
verified. Disabling the workflow is operational containment, not a passing gate.

Local verification after the viewer cleanup change first returned 442 passes,
26 skips and two installer-contract failures. Those two tests passed in isolation.
Their assertions discarded installer stderr, so they now retain failure output.
The subsequent native-enabled full suite returned 444 passes, 26 skips and zero
failures across 470 tests in 92 files, in 160.74 seconds. Typecheck also passed.
The intermittent installer failure has not been explained by that successful
rerun and remains open. These changes remain local; verify stays disabled.

The installer contract checks also passed together with the preceding update and
advisor suites: 35 passes, zero failures. This did not reproduce the intermittent
full-suite failure. On the ordinary-account Windows 11 guest, the updated preflight
and failed-viewer-setup tests passed all seven checks with Bun 1.4.2. Only those
changed files were transferred into the existing test checkout; this is targeted
Windows evidence, not a full-suite result at the current revision. The guest's
one-time test login was disarmed and its stored automatic-login password removed.
No GitHub workflow was started and no commits were pushed for these checks.

## Local Windows admission and command fixes

A clean Git bundle of 1dce7bd was installed into a fresh ordinary-account Windows
11 directory, with the same Bun 1.3.14 as CI. Both frozen dependency installs and
root typecheck passed. The documented `bun run verify` command then refused shared
job assignment with Win32 error 5 while the managed broker was already running.
Direct limited.ts invocation entered the suite; `bun run --shell system verify`
also entered it with the same account, runtime and existing broker. The root
bunfig now selects the system shell and is included in the release archive.
This retains limited.ts and the shared job enforcement.

The direct full-suite trial returned 318 passes, 116 skips and 36 failures.
Windows admission was stuck near the memory ceiling because it subtracted the
lifetime peak rather than current job commit. A real 256 MiB child-allocation
regression failed before the fix: releasing the child recovered zero reported
bytes. It passed after admission switched to JobObjectMemoryUsageInformation.
Current and peak commit are now distinct status fields, and failed kernel reads
report unavailable instead of zero. The hard memory and process limits did not
change. This is local Windows 11 evidence, not a new GitHub CI result.

With live accounting and the system shell, the full Windows trial progressed to
349 passes, 116 skips and six failures in 165.36 seconds. One was the newly added
bunfig not yet staged in the trial checkout; the package check passed after staging.
Another was a file-symlink fixture requiring a Windows privilege that the ordinary
account does not have. That fixture is now a separate non-Windows test; invalid
path rejection still runs on Windows. MCP and CLI diagnostics were retained, and
a subsequent full trial exposed the original runtime error: JavaScriptCore
MemoryExhaustion, exit 9. A smaller passing run does not close that full-suite
failure. Lower-memory verification is being measured without widening the job.

The final verification command keeps both the waiting budget launcher and the
Bun test runner in `--smol` mode. Test assertions, browser settings, timeouts and
kernel limits are unchanged. This reduced the full Windows trial with the old
managed broker present to 353 passes, 117 skips and two MCP failures. That remains
a failed pressure scenario, not a passing gate.

The old VM broker had no sessions and its two processes used about 357 MiB of
private commit. After checking its session list was empty, its scheduled task was
stopped for a clean CI-like baseline. Windows typecheck and the full suite then
passed: 355 passes, 117 skips, zero failures across 472 tests in 93 files, in
153.29 seconds. The prior managed task was restarted in a finally block. The
measurement used Bun 1.3.14 on the ordinary account, at 1dce7bd plus these local
fixes. This does not establish capacity for the full suite plus another running
broker under the same 2 GiB pool. The tests started their own required brokers.

The Linux native-enabled full suite before the final lower-memory runner change
passed 445 tests, skipped 27 and failed none in 154.82 seconds. The final command
also passed the targeted packaging, resources, adapter and action-document checks:
15 passes, one platform skip, zero failures. GitHub verify remains disabled and
no commits or CI runs were sent during these local trials. macOS remains unverified
at these changes, and the earlier intermittent installer-contract failure remains
unexplained rather than declared fixed by successful reruns.

The final Linux native-enabled full suite using the lower-memory command also
passed: 445 passes, 27 skips, zero failures across 472 tests in 93 files, in
150.82 seconds. The restored Windows managed broker answered session list with
an empty successful result after the isolated trial.

## Windows runtime and registry artifact correction

The smaller three-adapter experiment reproduced the Windows 2 GiB pressure failure
with Bun 1.3.14 against the current private broker, independently of the full test
runner. Bun 1.4.2 completed the same scenario. The final trial kept three generated
MCP interpreter entries connected, navigated a private local browser, read its
heading through another adapter, captured its frame, closed the first adapter and
stopped the browser through a remaining connection. Peak job commit was about
1.44 GiB. This is MCP protocol evidence, not three native host applications running.
The same scenario passed on Linux with Bun 1.3.14. Raw reports are retained locally, under the gitignored
`docs/evidence/mcp-concurrency-*-2026-09-20.json` paths.

Windows now requires Bun 1.4.2 or newer in preflight. The refusal regression failed
before that check existed and passed afterward. Only the Windows CI runtime pins
changed; the workflow remains disabled. This is a minimum verified baseline, not
proof of every later runtime release or every machine.

Bun 1.4.2's full Windows suite first passed every runtime test and failed packaging:
its packer unconditionally excludes root lockfiles. The registry producer now uses
Bun's selected files, then adds the exact source lock into the final archive.
Artifact tests still reject untracked payload files, require every platform's
entry point and compare the archived lock byte for byte. The managed-install CI
harness builds this artifact too. Maintainers publish the completed archive rather
than packing the directory implicitly during publication.

Final ordinary-account Windows verification with the prior managed broker still
running returned 356 passes, 117 skips and zero failures across 473 tests in
93 files, in 144.50 seconds, on Bun 1.4.2. This supersedes the two-failure pressure
result above for that runtime and scenario. The focused installer, prerequisite
and packaging checks also passed all 26 tests on Linux and Windows.

A freshly extracted registry archive, in a Windows path containing spaces and
without node_modules, then installed frozen dependencies and configured all three
hosts through one `install.cmd --no-service --connect claude,codex,hermes` command.
Its lock matched the source. All configuration and prefix paths were temporary;
the existing managed service was not changed by that installation trial. The
concurrency probe's temporary stop of the idle VM service was reversed afterward.
No source changes were pushed and no GitHub workflow was enabled or started.
macOS verification and the unexplained earlier Linux installer failure remain open.

## Bounded installer follow-up, 20 September 2026

At `ba97d6b`, `bun run verify tests/viewer-settings.test.ts
tests/agent-contract.test.ts --rerun-each 10` completed with 60 passes, zero
failures and 1060 assertions in 39.37 seconds. The local log is
`/tmp/orbit-installer-repeat.log`. This checks repeated settings and installation
contracts but did not reproduce the earlier failure. Inspection of the user
journal covering that original run found no actionable cause. Successful reruns
do not close that defect; retained subprocess stderr is needed if it recurs.

The closing audit still cannot establish current macOS behavior: the available
local VM inventory contains Windows only, the repository has no registered
self-hosted runner, and GitHub verify remains `disabled_manually`. No new remote
run or push was made. A real macOS execution of the current revision is required
before claiming a passing cross-platform release. Existing installation trials
also do not prove automatic provisioning on every blank machine or integration
inside every native host application.

## Portable simulation and macOS scheduling correction, 20 September 2026

`bun run verify:platform-contracts` provides a documented local entry point even
without a Mac. The service simulation drives real production functions and real
temporary files while simulating only launchctl responses. It covers first and
repeated installation, bootstrap refusal, status, removal and foreign-file
preservation. It exposed a real ordering defect: removal attempted to stop a
service before checking file ownership. The strengthened test failed before the
fix and passed after ownership validation moved ahead of bootout.

Cold-order comparisons now run each initial order on a separate fresh Mac rather
than always charging cold startup to the background arm. The diagnostic runs are
[35482307360](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35482307360)
and [35482468017](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35482468017).
The utility-clamped, non-background control completed all three sessions in each
order; one background arm timed out capturing its first frame after fonts loaded.
On the foreground-first host, median total work was 1281 ms for the utility
control and 8337 ms for background. These are small host-specific samples, not
universal speedup claims. Bun 1.4.2 alone did not repair macOS startup failures,
so the production macOS verification pin stays at 1.3.14.

Active work now uses `taskpolicy -c utility`. The LaunchAgent uses Standard process
type, retains Nice 10 and does not independently force low-priority I/O. A stricter
inherited background policy is preserved. Shared accounting, admission, ownership
and cleanup remain in place; the macOS budget is still advisory, not a kernel
CPU or memory ceiling. The plist contract failed against the former policy and
passed after the change. Production verification subsequently passed on two fresh
macOS runners: [35482684889](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35482684889)
and the final three-platform run above. The first installed-browser trial created
a session in 3186 ms and captured in 319 ms through the actual installed command;
the retrieved JPEG visibly contained the fixture heading.

The discarded background-policy comparison remains available in the manually
triggered `macos-cold-start` workflow. It is a diagnostic experiment, not a release
gate requiring the discarded policy to satisfy interactive deadlines. All
functional suites, installer checks and host-entry checks remain strict gates.
Focused manual runs can select one platform without cancelling a different one.
See [platform testing](platform-testing.md) for commands and evidence limits.
