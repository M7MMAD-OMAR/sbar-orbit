# Release readiness work

Goal: one clear installation command per supported operating system, working agent
connections, realistic application tests, and measured resource and recovery behavior.
Unsupported capabilities must remain explicit; no finite test matrix proves every device.

## Acceptance checklist

State, 20 September 2026 (alpha.8). Each closed box names the evidence and prints its limit beside it:
a skipped test is not a pass, and a limit is never omitted. What is not closed is listed under
[the roadmap's what remains](roadmap.md).

- [x] Fresh installation starts a usable broker immediately on Linux, Windows and macOS.
      On a GitHub Ubuntu 24.04 runner the one command install returned `installed: true`, the service
      stayed up and `doctor` answered; on the Windows 11 guest the install ran without `--no-service`,
      registered an account-specific logon task and received a broker response before another logon,
      and after a real reboot the automatically started broker completed the installed-command browser
      check with no manual start; on the macOS runner `./install.sh --json` exited 0, the LaunchAgent
      answered `launchctl print` and `doctor` exited 0. Run 35484602666 repeated fresh registry-archive
      installation with a managed browser on all three hosts. Limit: every host had Bun and a browser
      already provisioned, and the Windows and macOS hosts are a borrowed guest and a hosted runner
      with no person at them.
- [x] Installation offers an explicit, repeatable way to register supported agent hosts,
      preserving unrelated configuration and reporting unsupported hosts.
      Real Claude and Hermes CLIs connected on Linux, Codex's CLI read its registration, and all three
      serialized entries negotiated MCP and listed 12 tools on Linux and Windows.
- [x] Published commands work from a clean source archive and handle missing prerequisites.
      An extracted registry archive with no `node_modules` installed its frozen dependencies, linked
      the command and registered all three hosts in isolated configuration directories on Linux; the
      same archive extracted into a Windows path containing spaces installed frozen dependencies and
      configured all three hosts through one `install.cmd --no-service --connect claude,codex,hermes`
      command whose lock matched the source; registry-archive acceptance passed installation and
      browser use on Ubuntu and macOS. Preflight refuses a missing or too-old runtime with a named
      remedy, and Windows now requires Bun 1.4.2. Limit: Bun and a browser remain provisioned
      prerequisites and their installation is not covered by this evidence.
- [x] Cross-platform CI fails on type errors, failing tests and failed runtime checks.
      Run 35484602666 passed all nine jobs at `6a802f5` on 20 September 2026, after earlier runs
      recorded real failures that specific corrections closed. Note: the `verify` workflow is currently
      `disabled_manually` after repeated failed runs generated unwanted notifications; focused manual
      platform runs exist, and no push or run has been authorized since.
- [x] Browser and MCP flows verify navigation, text, capture, pause/resume and cleanup.
      On the Windows guest the whole action surface ran through the broker's RPC (navigate, read, fill,
      click, scroll, tabs, resize, observe, journal, pause, resume, stop); the installed command drove a
      browser session on Linux and Ubuntu that navigated, read a heading and captured a decodable
      1280 by 800 frame; and a three-adapter MCP concurrency probe ran on Linux and Windows. Limit:
      pause and resume are proven at the protocol and installed-command level, and the takeover path is
      now measured end to end through the viewer's own channel with a scripted participant, not against
      a person at the keyboard, which is item 1 under what remains.
- [x] Native application flows run on supported Linux hosts; platform refusals are tested.
      A purpose-built Fedora 44 machine launched a Wayland and an Xwayland application, typed into and
      clicked both, and read both typed strings off the pixels; nineteen applications across GTK4,
      GTK3, LibreOffice, Qt 6 and Xwayland map; `tests/owned-group.test.ts` passed 5 of 5 there; and
      the platform refusals (session-0 browser, a second concurrent interactive session, profile
      clone) are recorded with their sources. Limit: that machine has no physical GPU and its
      compositor rasterises in software, and the other Linux families are container limited.
- [x] Resource use, concurrent sessions and crash recovery have current recorded evidence.
      The newest rows are 19 September 2026: process containment including the Chrome crash-handler
      escape, resource accounting, and crash recovery on Windows and macOS, both at 0 survivors after a
      kill with no cleanup handler. Concurrency (three browsers and two displays on one broker, 20 of
      20 rounds) and the measured one-core share date to 11 September 2026 and were not re-measured at
      alpha.8. A managed broker did abort on this host class on 20 September 2026 and its systemd
      restart swept 259 leftovers and answered; the abort itself has no identified cause, and the
      session loss is documented restart behaviour rather than a recovery failure.
- [x] Release documentation, support table and package commands agree with verified behavior.
      The 20 September 2026 pass moved the suite figures, the alpha number and the managed-update
      platform limit in [PROJECT.md](../PROJECT.md), [the readme](../README.md),
      [support tiers](support-tiers.md) and [validation](validation.md) onto alpha.8 evidence, and added
      a what remains list to [the roadmap](roadmap.md).

## Alpha.8 release, 20 September 2026

Linux managed updates now have an isolated systemd gate: actual registry alpha.6 installation and
migration to the candidate archive, idle upgrade, private-browser busy refusal, broken-startup
rollback with a healthy version response, retained state, timer enable/disable and explicit rollback.
The successor alpha.9 and alpha.10 archives are controlled local fixtures, not published releases.

Local Fedora native verification: **457 passed, 27 skipped, 0 failed**, 484 tests in 97 files,
143.85 seconds. Typecheck passed. Regressions were observed failing before the fixes for stable
launcher indirection, update admission, invalid version paths, timer enable failure, release-channel
selection, archive identity ordering and disabling updates during preparation.

[Run 35484602666](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35484602666) passed all nine
jobs at `6a802f5`: suites, installed browser flows and generated host registrations on all three hosts.
Ubuntu passed 434 tests with 50 skips; Windows passed 367 with 117 skips; macOS passed 377 with
107 skips. Every suite had zero failures and discovered 484 tests. Typechecks passed on all hosts.

The exact candidate registry archive also passed the isolated Linux upgrade gate. Its SHA-256 is
`c484215612b60275bc6d889fb5930d52b4a6e9bdcdc54b6a59c4781a1c5637e1`.
The source archive at that revision has SHA-256
`e943fe45ccdd2b87e4b8ec0caf04e2adff52793ae726ff42dd16633b372372d2`.

Publication completed on 20 September 2026. The npm registry exposes alpha.8 as `latest`, and
[GitHub](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.1.0-alpha.8) carries the matching
registry archive, source archive and checksums. The annotated tag points to tested revision `6a802f5`.
The public registry download matches the tested archive SHA-256 above. Installing the published
package back on a disposable Fedora systemd host passed managed adoption, broker health, private
browser creation/capture and timer enable/disable.

The initial publication failure was a credential-selection error: the CLI used a different configured
credential instead of the existing project publishing credential. The existing credential was valid;
no token rotation or new security key was needed. CLI authentication was corrected before publishing.
See [the alpha.8 guide](release-alpha8.md) for installation, migration and platform limits.

## Managed broker abort, 20 September 2026

The managed broker on this workstation aborted with **SIGABRT** at 08:12:33, after 4h46m of uptime
with 4.3G of peak memory, and systemd restarted it two seconds later. Live browser sessions were open
at the time, evidenced by the roughly twenty `chrome` processes and one `python3` systemd killed with
the cgroup as the unit went down. Their sessions died with it, which is what a broker restart does by
design rather than a second defect. The recovery behaved as documented: the new broker swept 259
leftovers and answered, and fresh sessions worked afterwards.

Nothing recovered says why. No cgroup ceiling was hit (`memory.events` all zero; `pids.events` shows
one `max` event with no timestamp, which cannot be attributed to this), the kernel logged no OOM, and
the broker printed no panic, assertion or abort message, even though its stderr does reach the journal
where its ordinary JSON diagnostics appear. A core was captured and is **truncated at 1 GiB with no
usable frames**, so the cause is not recoverable from it. Two full bounded suites and a trial had run
in the hour before, alongside other agents' sessions on the same shared slice; no evidence links that
load to the abort and none rules it out.

This is an unidentified failure with retained evidence, not a fixed one. No test asserts on a managed
broker's lifetime, and none sends SIGABRT or names that socket, so the suite is not the mechanism as
far as its own code shows. The raw facts are kept in the gitignored
`docs/evidence/broker-abort-2026-09-20.json`.

## Workspace sweep could not reclaim spaces holding restore points, 20 September 2026

`sbar-orbit clean` removed 141 of 192 workspaces and refused 21 of them with `EROFS: read-only file
system`, leaving 107 GB of a 108 GB cache in place. The refused ones all held a restore point: a point
is a **read-only btrfs snapshot**, and unlinking anything inside one answers `EROFS` whatever the
permissions on the path say, so the plain `rm` in the sweep could never remove them. `src/restore.ts`
has cleared the `ro` property before deleting a point since it was written, and the sweep simply never
asked it to. `btrfs subvolume delete` is not the answer either: it needs privileges this leaves alone,
while clearing the property succeeds unprivileged.

`cleanWorkspaces` now clears the `ro` property on the subvolumes under each `restore-*` directory
before removing the workspace. Re-running it: **refused 0**, 20 removed, and the cache fell from 107 GB
to 77 GB, with the remaining 30 kept because a live or recent broker owns them. The regression is
`tests/workspace-storage.test.ts`, which held an **empty** snapshot at first and passed without the
fix, because an empty read-only snapshot has nothing inside it to unlink; with one file in the profile
before the point is taken, the test fails against the unfixed code and passes with it.

## A Windows flake at a fixed revision, 20 September 2026

Run 35505751527, the push-triggered run at `56fd4a9`, failed `suite (windows-latest)` on a different
test than the stack overflow: `stopping a session removes its profile and its restore store from the
workspace` in `tests/adversarial/reaping-and-secrets.test.ts`, at line 164, 4984 ms in. The test stops a
session, then polls the workspace for up to 100 rounds of 30 ms, about 3 s, for the `profile-` and
`restore-` directories to go, and asserts none is left. It found `profile-DWueMm` still there. The
other eight jobs passed.

Run 35506009515, dispatched on the **same revision** `56fd4a9`, passed all nine jobs. The bun version
is pinned per platform in the workflow (1.4.2 on Windows, 1.3.14 on Linux), and all three Windows runs
used 1.4.2, so a version change is not the variable here: the removal was slower than the test's own
3 s budget once, on the slowest runner.

That budget was **not** widened. The suite's job is to fail when a profile is not removed, and
loosening a timer because a slower host beat it, without measuring how long the removal actually takes
on that host, is retrying a failure into silence. It is retained as an observation. The shape that
would fix it properly is the one the Ubuntu tab-closing test already uses, waiting on the system's own
signal rather than on a fixed timer, and that needs `session stop` to answer after the workspace is
gone, which is a change to the stop path rather than to the test.

## 0.1.0-alpha.9 published, 20 September 2026

`0.1.0-alpha.9` was published to the npm registry as `latest` on 20 September 2026, with an annotated tag
`v0.1.0-alpha.9` at `ed355d8`, the revision run 35506995596 verified: all nine jobs, 491 tests across 98
files on each platform, Ubuntu 440 pass and 51 skip, Windows 373 and 118, macOS 383 and 108, every one
at 0 fail. It is a fix release, so no migration evidence beyond alpha.8's is needed and the update path
is unchanged.

The source archive is SHA-256 `e0295494ec0200f3e24f5788d67c6122a54de9ffea59abc424c71ec5f32f5959`, 473
files. The registry archive is SHA-256
`dec1006fd42a20e0bb70552998e96496ddbc2e68ad48c0368ab7a9c28e80d67a`, 144 files and 779707 bytes. It was
downloaded again from the registry after publication and is byte identical to the built one, same digest
and same file list, so nothing was repacked on the way in. `verify-source` accepted all 473 files of the
extracted archive with `verified: true`; from there `bun install --frozen-lockfile --ignore-scripts`
installed 100 packages in 104 ms and the launcher ran `--help`, `preflight` and `install --dry-run
--json` with `installed: true`. From the registry, `bun add -g sbar-orbit@0.1.0-alpha.9` into a
temporary `BUN_INSTALL` resolved 95 packages in 27.84 s and the installed command answered.

Two things about this release are limits rather than results.

**The package smoke test was not run.** Three attempts were refused by the shared resource budget before
the browser could launch, with 85, 85 and 117 free tasks of 1536 against the roughly 140 a session needs,
because another agent held six sessions in the same slice at the time. The steps before the launch did
run on the exact archive: extraction, manifest verification, the frozen dependency install and the broker
start. The frame capture and the packaged Canvas viewer are **not measured**, and not measured is not a
pass.

**A defect in the registry path was found after the artifact was frozen, and is not fixed in it.** From
a real global registry install, `preflight` reports the three runtime dependencies as missing, so the
install report says `browserSessions: false`. The dependencies are installed: bun's global layout places
them at the root of the global `node_modules` (94 entries, siblings of `sbar-orbit`), and the command runs
from there. `src/preflight.ts:28` resolves them against `<source root>/node_modules` and does not walk up
the way Bun's own resolution does. A published version cannot be replaced, so this is recorded for the
next release rather than repaired in this one. The native half of that report is separate and correct:
the native runtime is not shipped in the registry package, and `install --native` answers
`native-bootstrap-absent` by design.

## The nine jobs again at the process-tree guard, 20 September 2026

The push of `78e8a7b` triggered run 35505546868, and all nine jobs passed with **491 tests across 98
files** discovered on each platform: **Ubuntu 24.04 440 pass, 51 skip; Windows 373 pass, 118 skip;
macOS 383 pass, 108 skip**, every one of them with 0 fail, plus installed-browser and host
registration on all three. The Windows job that failed at `f77b22d` passed here, on the same
assertions, with the guarded walk. These figures replace the `9f48b96` numbers in
[support tiers](support-tiers.md).

## The Windows runner's stack overflow, 20 September 2026

The push of `f77b22d`, a documentation-only change, triggered run 35505288681, and `suite
(windows-latest)` failed one test: `abrupt broker death reaps its browser tree and a fresh broker
rejects stale sessions` in `tests/browser-crash.test.ts`, 11803 ms in, with `RangeError: Maximum call
stack size exceeded` raised at that file's own line 56. The other eight jobs passed, and the same test
code had passed on the same platform eleven minutes earlier, in run 35505029561.

The cause is in the test rather than in the runner. `windowsDescendants` reads one `Win32_Process`
snapshot and walked it recursively with no visited set, while the cross-platform `descendants` returns
for win32 before its own `seen` guard runs, at line 23 against lines 24 to 26 of the same file. A
snapshot can hold a cycle, because a pid is recycled while the snapshot is taken or because a process
names itself as its parent, and the walk followed the cycle until the stack ended. `src/process-tree.ts`
now holds the walk, iterative and visiting each pid once, and `tests/process-tree.test.ts` covers a
cycle, a self-parent, a root named inside its own subtree, and a blank line from a trailing newline.

Those five tests were run against the old recursive walk before the fix: three of them failed with the
same `RangeError`, in 10.20 ms, 14.87 ms and 5.03 ms. The defect is therefore reproducible on Linux in
milliseconds, and catching it no longer depends on a Windows runner landing on a recycled pid.

This is the first of the intermittent failures to be explained rather than retained. It is one test, on
one platform, in one run: it does not explain the earlier Windows first-capture delay, and it does not
touch the two local contention failures on this workstation.

## All nine jobs at 0.1.0, and the Windows job that needed a rerun, 21 September 2026

[Run 35556878848](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35556878848) passed **all
nine jobs** at `cfb6144`, the revision `v0.1.0` names. Ubuntu and macOS passed on the first attempt;
`suite (windows-latest)` failed once and passed on a rerun of that job alone, with no change to the
code in between.

What it failed on is worth naming rather than hiding behind the word flake, because it sits on the
guarantee this project is judged by. `tests/person-browser.test.ts`, the test that proves an owned
browser is Orbit's own and the person's is left alone, ended with one pid of the stand-in browser's 14
missing after Orbit closed its own. The close path cannot explain it: Orbit closes a Windows job
object handle, the kernel terminates that job's members, and a process outside the job is not
reachable from it. The same test, the same binary and the same commit then passed on the rerun, and
Windows had passed it in the three runs before this one.

So it is recorded as unexplained and NOT as fixed. Two failures on this platform in consecutive runs,
each a different test, each passing afterwards, is a pattern about the runner rather than a finding
about the code, and it stays an open observation beside the 20-second deadline flake from `339dd74`.
Windows remains `Limited`, which is what that tier is for.

## A test that read the real home, 21 September 2026

[Run 35556260365](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35556260365) at `c7e7de5`
failed `suite` on all three platforms, and the six other jobs passed. One cause on Ubuntu and macOS,
two on Windows.

The shared one is a test defect in `tests/install-hosts-refused.test.ts`, written the same day. It
seeded a fake `.claude.json` in a temporary directory and exported it as `process.env.HOME`. On POSIX
`homedir()` reads the password database and not the environment, so the installer resolved the
runner's real home instead: with no `orbit` entry there to collide with, the host step reported
`skipped` rather than `failed` and the assertion fell over. It passed locally for the worst reason,
which is that this workstation's own `~/.claude.json` does hold an orbit entry, so the test was
reading the developer's real configuration and calling that a pass. `runInstall` now takes an explicit
`home`, the test passes it, and the test is verified twice: once here and once under a `HOME` with no
entry in it, which is the runner's condition. Reverting the product fix still fails it.

The second Windows failure is the retained timing flake, not a new one. `abrupt broker death reaps its
browser tree and a fresh broker rejects stale sessions` hit its 20-second ceiling at 20003.16 ms, which
is a deadline and not the `RangeError` the cycle fix closed above. It is the same observation kept at
`339dd74`, unwidened.

## All nine CI jobs at the workspace-sweep fix, 20 September 2026

[Run 35505029561](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35505029561) passed all nine
jobs at `9f48b96`, the revision of the workspace-sweep fix, dispatched by hand after that revision was
pushed. Each platform ran the full bounded suite and discovered **486 tests in 97 files**, with zero
failures: **Ubuntu 24.04 435 pass, 51 skip, 162.68 s; Windows 368 pass, 118 skip, 181.45 s; macOS 378
pass, 108 skip, 223.44 s**. The installed-browser and generated-host-registration jobs passed on all
three platforms as well. Skips are platform capabilities, not passes.

That run is also what settles how the two local failures on this workstation read. The same revision
failed one browser-driven test locally twice, a different test each time, while another agent held five
sessions on the shared slice, and both of those tests passed alone here and on the runners. Contention
is the shape of it, not a named cause, and neither local failure is treated as fixed.

The `verify` workflow was `disabled_manually` before this run, because repeated failures had generated
unwanted notifications, and a disabled workflow cannot be dispatched. It is **enabled again** as of
this run. `platform-probes` and `macos-cold-start` remain manual.

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
(Superseded on 20 September 2026: the user authorised the push, the workflow is enabled again, and
run 35505029561 passed all nine jobs; see the section above.)

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
