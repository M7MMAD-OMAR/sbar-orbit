# Portability verification ledger

Evidence snapshot: 6 October 2026. The final tested source is `d97e5dd3e9e90179da8be7122c90ce6da18bd031`, with nine successful jobs in run 37404223107. Later changes to this ledger are documentation only; they do not claim a newer runtime was tested. No local build, test, installer, browser, compositor or service operation was run to prepare it.

## Acceptance scope

The requested outcome is an external person installing Orbit with different usernames, paths, applications and operating systems, then using it efficiently and reliably without disrupting their own desktop. This remains the acceptance scope. Passing a fixture, installing successfully, or using a disposable CI browser does not establish support for every application or device.

This is a progress ledger, not final acceptance. The definitions in [support tiers](support-tiers.md) apply: Measured and Limited require executed evidence, Failed preserves an observed failure, Reasoned describes an untested platform argument, and Refused describes a documented unsupported capability. `not measured` is an evidence status, never a pass. A prepared patch cannot raise a tier before its tests run.

## Authoritative remote runs

| Revision and run | Observed result | Scope and limit |
| --- | --- | --- |
| `ea4a017f208a1ea121faabec31ead73301dec6f7`, [run 37402711193](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193) | Failed overall, eight of nine jobs succeeded. Ubuntu suite: 648 pass, 94 skip, zero fail. macOS suite: 448 pass, 294 skip, zero fail. Windows suite: 436 pass, 305 skip, one fail. | All suites reported 742 tests across 161 files. Skipped coverage remains unmeasured. All six installed-browser and registered-hosts jobs succeeded. |
| Same revision, [Windows suite job](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/job/112073251126) | Failed: `Linux browser profiles follow another user's XDG config location`, `tests/browser-discovery.test.ts:24`. | A fixture expecting POSIX paths received Windows separators. Preserve this failure even though the subsequent fix passed. |
| `4cae2fcf651e39f517e9ae9549e5ef0dbe3f16ca`, [run 37403100980](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403100980) | All three Windows jobs passed. Suite: 437 pass, 305 skip, zero fail, with the original assertion retained. | This run validates the Windows correction. It does not rerun Linux or macOS and does not cover subsequent incident, registry, Zen or service patches. |
| `7c6f25d`, [native synthetic run 37403797681](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797681) | Passed: the old `2116c4b` plugin fixture produced the expected null-device subprocess SIGSEGV and nonzero unittest result; the corrected fixture passed. | Limited: synthetic inventory regression only. This does not measure a real compositor, Chrome claim, cursor or focus. |
| `7c6f25d`, [portability regression run 37403797696](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797696) | Failed overall. Registry baseline: three failures; correction: three passes. Zen baseline: one expected failure, alias fixture passed. The driver then rejected different assertion wording before the corrected Zen test ran. | Registry regression is Limited at this revision. Corrected Zen behavior was not measured in this attempt. Preserve this failed workflow alongside the later corrected driver run. |
| `741478b47fe53aa444fdc763b119ae8cfef396fe`, [corrected portability run 37403909570](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403909570) | Passed: registry three old assertion failures and three corrected passes; Zen one old ambiguity failure with alias passing, then two corrected passes. | Limited to injected registry and deployment fixtures on Ubuntu. Actual application behavior remains unmeasured. |
| `d97e5dd3e9e90179da8be7122c90ce6da18bd031`, [service and package run 37404043928](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404043928) | Passed: each of three intended old-source assertion failures became one corrected pass. Bounded typecheck passed; 36 contract tests across six files passed. | Old service lacked XDG data defaults and invalid-path refusal; the old package omitted the referenced skill from a real archive. Setup failure was not accepted as red. Focused contracts are not complete platform acceptance. |
| Same final source, [all-platform run 37404223107](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107) | Passed, nine of nine jobs. Ubuntu: 662 pass, 94 skip, zero fail. Windows: 445 pass, 311 skip, zero fail. macOS: 456 pass, 300 skip, zero fail. | Each suite ran 756 tests in 163 files. All six installed-browser and registered-hosts jobs passed. Native installation skipped and actual host CLIs absent. The exact tested source is recorded above. |

The workflow is [.github/workflows/verify.yml](../.github/workflows/verify.yml). It records suite resource samples and installed acceptance artifacts. The read-only inspection commands are `gh run view 37402711193 --repo M7MMAD-OMAR/sbar-orbit --log` and the same command for `37403100980`; artifact inspection uses `gh run download` for the named run and artifact.

## Requirement ledger

| Requirement | Evidence and authoritative command | Supported conclusion and remaining gate |
| --- | --- | --- |
| Fresh external installation, including paths with spaces | [installed-ci-acceptance.ts](../experiments/installed-ci-acceptance.ts), `bun run scripts/limited.ts bun experiments/installed-ci-acceptance.ts`, installed artifacts below. It packages the checkout, extracts into a fresh temporary path with spaces, checks that dependencies were not preinstalled, and runs the installer and installed launcher. | Limited: disposable Linux, macOS and Windows CI installations passed. The archive is built from the checkout, not downloaded from a published release. Runners already provide Bun and browser prerequisites. Native installation is skipped. A published package on a fresh external machine remains a separate gate. |
| Different HOME, XDG configuration, unit directory and Bun locations | [unit-directory.test.ts](../tests/unit-directory.test.ts), [broker-environment.test.ts](../tests/broker-environment.test.ts), [unit-drift.test.ts](../tests/unit-drift.test.ts), and [installer contract](agent-install.md). Earlier focused unit-path tests passed before the desktop incident. | Limited for those earlier explicit path fixtures. Final service environment and drift contracts passed in focused run 37404043928 and the Ubuntu suite in run 37404223107. Test operator broker.env overrides against recorded installer defaults, malformed unit snapshots, spaces and percent signs. Do not infer all user layouts from one workstation. |
| Application and profile discovery with foreign names and layouts | [browser-discovery.test.ts](../tests/browser-discovery.test.ts), [codex-owner-launch.test.ts](../tests/codex-owner-launch.test.ts), [native-zen-launch.test.ts](../tests/native-zen-launch.test.ts). Windows POSIX fixture failure and correction are preserved above. | Limited to the executed fixtures at the listed revisions. Registry identity has red and green fixture evidence in run 37403797696. Corrected Zen ambiguity handling has old/new fixture evidence in run 37403909570; the failed earlier driver remains preserved. Real alternate installations, custom profiles, renamed launchers and arbitrary applications remain unmeasured unless named evidence covers them. |
| Cross-platform browser sessions | Installed launcher smoke in the three installed artifacts: create session, navigate to a local random heading, observe and capture, pause refusal, resume and stop. | Limited: fresh disposable browser sessions on Linux, macOS and Windows. This does not cover every browser, extension, authenticated profile, CPU architecture or operating system version. Platform profile restrictions remain as documented in [support tiers](support-tiers.md). |
| Cross-platform native applications | [support tiers](support-tiers.md), [porting](porting.md), and the native validation gates in [validation](validation.md). CI installer reports explicitly record native as skipped. | not measured by these runs. Fedora native evidence is historically limited to named experiments. Windows private native display is unsupported; macOS private native display is Refused at the documented tier. Do not equate cross-platform browser installation with native support. |
| Registration with external agent hosts | [registered-hosts.ts](../experiments/registered-hosts.ts), `bun run scripts/limited.ts bun experiments/registered-hosts.ts`. Each platform configures isolated Claude, Codex and Hermes locations and negotiates 15 tools through each generated MCP entry. | Limited: generated registrations and MCP negotiation passed on all three platforms. Actual Claude, Codex and Hermes CLI probes each reported `not measured: CLI absent`. Require actual installed host CLI validation before claiming those integrations are measured end to end. |
| Owner desktop safety | Incident artifacts `coredump-info.txt` and `hyprland-crash.txt` under `.private/incident-2026-10-06/` in the integration repository. Crash frame: `CExtDataDeviceProtocol::dataDeviceForClient.cold`, followed by the plugin claim path. Incident fix source commit `42012b9b5e526a6194b1be3f20b9ac56095bf72e`, integrated as `69e1df2abcdce38bc6203dd2010a3356e49d62a1`. | Failed: the person's Hyprland desktop crashed. Static inspection supports an invalid or empty device inventory entry; its origin is unknown. The release hold blocks owner handoff operations. The synthetic inventory regression has red and green remote evidence in run 37403797681. Full native checks remain not measured. Historical headless successes do not prove owner desktop safety. |
| Native claim, input, focus, cursor, clipboard and cleanup | [native-plugin-owner.test.ts](../tests/native-plugin-owner.test.ts), [native_data_control_test.py](../tests/native_data_control_test.py), [native-existing.test.ts](../tests/native-existing.test.ts), [native-target-view.test.ts](../tests/native-target-view.test.ts), future isolated Fedora `ORBIT_TEST_NATIVE=1 bun run verify`. | Limited for the synthetic inventory regression in run 37403797681; the full native cycle is not measured after the incident fix. The C++ inventory harness is synthetic and cannot establish full compositor behavior or ABI safety. Require failing baseline evidence, repaired tests, absent/invalid protocol cases and a complete real claim/input/cleanup cycle on a disposable Fedora display before reconsidering the hold. |
| Efficient resource use and reliability | `bun experiments/verify-with-resources.ts`, resource artifacts below, and [validation](validation.md). | Limited to recorded whole-runner CPU and memory samples during the suite. These samples are not Orbit-attributed usage. CPU throttling, guest steal time, long-session reliability and arbitrary application workload efficiency are not measured by this evidence. |
| Service startup, restart, configuration precedence and update lifecycle | [service implementation](../src/service.ts), [unit drift tests](../tests/unit-drift.test.ts), [broker environment tests](../tests/broker-environment.test.ts), [CLI contract](cli.md). Installer artifacts report the service installation step done. | Installation state only in the installed CI jobs. Selected environment propagation, strict installed-default decoding and broker.env override handling passed the final focused and Ubuntu suite fixtures. A real disposable systemd startup, broker/updater parity, intact-unit drift check after overrides, restart and cleanup are unfinished gates. |
| A complete portable current release | Exact-revision workflow run plus published package acceptance and the outstanding gates below. | not measured. No combination of the earlier partial results closes the original external-user goal. |

## Artifact catalog

All links refer to artifacts from the named run, not a claim about a newer revision.

| Run | Artifact | Link |
| --- | --- | --- |
| 37402711193 | installed-acceptance-ubuntu-24.04 | [installer report and browser smoke](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11385587614) |
| 37402711193 | installed-acceptance-macos-latest | [installer report and browser smoke](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11385637572) |
| 37402711193 | installed-acceptance-windows-latest | [installer report and browser smoke](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11386091119) |
| 37402711193 | verification-resources-ubuntu-24.04 | [resource samples](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11385917281) |
| 37402711193 | verification-resources-macos-latest | [resource samples](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11386146587) |
| 37402711193 | verification-resources-windows-latest | [resource samples](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37402711193/artifacts/11385872695) |
| 37403100980 | installed-acceptance-windows-latest | [corrected Windows installed acceptance](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403100980/artifacts/11386211621) |
| 37403100980 | verification-resources-windows-latest | [corrected Windows resource samples](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403100980/artifacts/11386426824) |
| 37403797681 | synthetic-native-data-control-red-green | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797681/artifacts/11385434328) |
| 37403797696 | failed portability driver | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797696/artifacts/11385698921) |
| 37403909570 | corrected registry and Zen red/green | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403909570/artifacts/11385444483) |
| 37404043928 | service/package red/green, typecheck and contracts | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404043928/artifacts/11385599599) |
| 37404223107 | installed-acceptance-ubuntu-24.04 | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11385814504) |
| 37404223107 | installed-acceptance-windows-latest | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11386163922) |
| 37404223107 | installed-acceptance-macos-latest | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11386552616) |
| 37404223107 | verification-resources-ubuntu-24.04 | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11386364246) |
| 37404223107 | verification-resources-windows-latest | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11386840160) |
| 37404223107 | verification-resources-macos-latest | [source-bound evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37404223107/artifacts/11386379204) |

Each inspected installer report says `installed: true`, dependencies done, hosts configured, and native skipped. Its `verified` field explicitly limits the result to installation steps. Preflight capability booleans are probes, not the later smoke measurement and not a general support verdict. Registered-host output is in the job logs; the CLI-absent limits must remain beside the MCP result.

## Unfinished acceptance gates

1. The complete three-platform workflow passed at the exact combined source `d97e5dd` in run 37404223107. Preserve its skipped tests and the earlier failures. This closes that CI gate, not full external-user acceptance.
2. The final service snapshot parser and operator broker.env override regression passed remotely. Still exercise broker and updater units on a disposable systemd host with foreign HOME/XDG/Bun paths. Installation alone does not close this gate.
3. Validate actual Claude, Codex and Hermes CLIs using the installed launcher and isolated host configuration. Existing generated-entry negotiation is useful but narrower evidence.
4. Download and install the actual published release on fresh external host classes, including paths with spaces and alternate browser/application layouts. Keep platform restrictions visible.
5. Investigate the invalid native inventory entry and validate the exact Fedora compositor/plugin ABI. Run new tests against the unfixed source to establish that they catch the defect, then against the fix. Full native claim, cursor, focus, clipboard and cleanup must run on a disposable display. The owner desktop hold remains in force; this ledger authorizes no local runtime or handoff bypass.
6. Measure Orbit-attributed resource use, realistic application workloads and sustained lifecycle behavior before claiming high efficiency or reliability across arbitrary devices.
7. Keep the isolated, uncommitted native application-opening feature separate from this evidence. It has not been accepted or measured by these CI runs.

Future CI commands come from the workflow: frozen Bun dependency installation, `bun run typecheck`, `bun experiments/verify-with-resources.ts`, and the two bounded installed/registration commands listed above. The installed acceptance program requires `GITHUB_ACTIONS=true` and a disposable runner. Full Fedora validation is blocked: the separate native preparation task stopped with `This content was flagged for possible cybersecurity risk`, with no tool or operation identity in the rejection metadata. Its uncommitted Docker/probe prototypes were not executed, and no Fedora workflow was written. No alternate agent or execution path is authorized to bypass that rejection. Actual Fedora claim/cursor remains `not measured`, and the owner handoff hold remains. A separately reviewed disposable native environment would be required after the external blocking condition is resolved. These are reproduction requirements, not commands executed while preparing this ledger.

## Official main verification after native opening integration

This section supersedes the earlier snapshot's current-source and uncommitted-feature
statements while preserving every earlier failed baseline and corrected regression.
PR #3 was merged at `c9960faba29f9a7a66650befdfe1c99fcff298c3`. The 12-path native
opening feature was then integrated into official `main` as
`e5e9a8db5c2394627d3101b48da89e4c94bfaf4c`. That is the exact tested source of
[official run 37409928412](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412),
which completed successfully with all nine jobs passing. Later documentation-only
commits do not claim that a new runtime source was tested.

| Runner and runtime | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64, Bun 1.3.14 | 666 | 94 | 0 | 760 tests in 164 files | 300.41 seconds |
| Windows x64, Bun 1.4.2 | 448 | 312 | 0 | 760 tests in 164 files | 228.46 seconds |
| macOS arm64, Bun 1.3.14 | 459 | 301 | 0 | 760 tests in 164 files | 228.90 seconds |

All six installed-browser and registered-hosts jobs passed. Each of the nine
generated Claude, Codex and Hermes entries negotiated 16 MCP tools, compared with
15 at the earlier revisions. Actual Claude, Codex and Hermes CLIs were absent on
all three runners; all nine real CLI probes remain `not measured`. The three
installed acceptance reports say `installed: true`, with dependencies, service,
connector, verify and hosts done, and native skipped. Their scope remains a fresh
checkout-built registry archive on runners with provisioned Bun/browser
prerequisites, not acceptance of a published release on every external device.

The coordinator also recorded bounded local typecheck success and four passing
pure `native-open.test.ts` tests, zero failures, 15 assertions and 1074 milliseconds
on the merged source. In the official remote suites, that file passed all four
fixtures on Ubuntu; Windows and macOS each passed three and skipped the Linux
worker fixture. The fixtures cover literal argv/workspace handling, delivery
deduplication, retry after approval denial, fake-worker protected controls, and
retaining approval denial after worker cleanup failure. They do not measure real
native application opening or a real compositor.

| Official run artifact | Link |
| --- | --- |
| installed-acceptance-ubuntu-24.04 | [installer and browser evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11388918382) |
| installed-acceptance-windows-latest | [installer and browser evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11388194493) |
| installed-acceptance-macos-latest | [installer and browser evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11389013041) |
| verification-resources-ubuntu-24.04 | [runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11389315256) |
| verification-resources-windows-latest | [runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11388492919) |
| verification-resources-macos-latest | [runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412/artifacts/11388592734) |

Resource evidence covers whole-runner CPU/memory, not Orbit-attributed usage.
Throttling, guest steal, native performance, sustained reliability and arbitrary
application workloads remain unmeasured. Skipped tests remain skipped, never passes.

Older official run 37409577640 at `c9960fa` was superseded, and same-source run
37409910488 was cancelled. Supersession or cancellation is not a source failure.
Actual native claim, cursor, focus, input and cleanup remain `not measured`; the
owner handoff release hold remains active. The native preparation task's content
rejection and its lack of a specific tool/operation identity remain recorded above.
No rejected Fedora prototype was executed by this verification task.

## Official source review correction and preserved Windows startup failure

The three P2 findings after the successful `e5e9a8d` run were real coverage gaps:
relative executable binding before helper execution, official Chrome ELF profile
pinning and SingletonLock checks, and placement of the profile switch before the
caller's argument terminator. A successful `e5e9a8d` suite did not cover those
three cases and is retained as limited earlier evidence.

The independent source correction `d78a66a` was integrated into official `main` as
`66e15949ffad5b9f498d49b900dcd166629e6912`. The same three pure Python assertions
failed against the old `e5e9a8d` source and passed against the correction. Their
names are `relative_executable_is_resolved_before_approval`,
`official_chrome_elf_pins_directory_and_checks_lock`, and
`browser_profile_switch_precedes_argument_terminator`. The coordinator additionally
recorded four passing bounded pure Bun tests, zero failures, 15 assertions and
1072 milliseconds on merged `main`. No owner IPC or real application was used by
those regressions.

[Official run 37411189838](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838)
tested that exact source. Attempt 1 finished with eight successful jobs and one
failed job. All three suites passed:

| Runner and runtime | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64, Bun 1.3.14 | 666 | 94 | 0 | 760 tests in 164 files | 343.15 seconds |
| Windows x64, Bun 1.4.2 | 448 | 312 | 0 | 760 tests in 164 files | 292.15 seconds |
| macOS arm64, Bun 1.3.14 | 459 | 301 | 0 | 760 tests in 164 files | 221.21 seconds |

Ubuntu's native opening Bun fixture runs the complete 11-method Python suite,
including the three added cases, and checks its zero exit status and `OK` result.
Windows and macOS skip that Linux fixture, with three other opening tests passing.
These remain fake-worker and argument/approval fixtures, not real opening evidence.

The failed Windows installed-browser job passed installation, dependencies,
service, installer verification and host registration. The later browser `session
create` operation failed with `BACKEND_FAILED`: the owned Chrome process was still
running but had not published its local endpoint within 15 seconds. The retained
stage timing was 15502 milliseconds; `doctor` had passed in 424 milliseconds. No
browser frame was produced. Installer stderr was empty, which is not a measurement
of owned Chrome stderr.

One authorized targeted rerun of that Windows installed-browser job used the
identical SHA, timeout and source. [Attempt 2](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/attempts/2)
passed; only this job was executed again. The other eight job results were carried
forward from attempt 1. The rerun created a session in 8527 milliseconds, captured
a nonempty 18264-byte JPEG, passed navigation/read/pause-refusal/resume checks, and
received a successful stop response in 568 milliseconds. The latest job summary
is nine successful jobs, but the first attempt's failure is preserved rather than
being replaced by a claim of repeatable startup success.

Startup root cause remains unknown. The failed job did not preserve owned-browser
stderr, job accounting, membership or post-stop process-handle liveness. Source
inspection identifies an attempted startup cleanup path through the per-session
Windows job object, but it does not prove zero survivors in the failed run. The
successful rerun's stop response also does not prove that absence. Suite resource
artifacts come from separate job runners and cannot establish CPU pressure on the
failed installed-browser runner. No timeout was expanded and no environment or
source cause is asserted from the rerun result.

A separate source review found that Windows stop can resolve after a four-second
child-exit race without confirmed exit, and `CloseHandle` success is not checked.
That is a cleanup-contract concern requiring its own source correction and
validation; it is not evidence that this run left survivors. It remains separate
from the unresolved readiness failure.

| Artifact | Link |
| --- | --- |
| Windows installed acceptance, failed attempt 1 | [installer report and failed stage timing](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11388783960) |
| Windows installed acceptance, successful attempt 2 | [installer, browser frame and stage timings](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11389785674) |
| Ubuntu installed acceptance | [installer and browser evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11389725434) |
| macOS installed acceptance | [installer and browser evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11388808867) |
| Windows suite resources | [whole-runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11389795855) |
| Ubuntu suite resources | [whole-runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11389467195) |
| macOS suite resources | [whole-runner resource evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838/artifacts/11389621340) |

All nine generated host entries negotiated 16 MCP tools. Actual Claude, Codex and
Hermes CLIs were absent on all runners, and native installer steps were skipped.
Actual native claim, cursor, focus, input, cleanup and performance remain
`not measured`. The owner handoff release hold and the earlier rejected native
preparation limitation remain. Later documentation-only commits do not claim a
new tested runtime source.

## Cleanup correction CI failure and preserved listener regression

The cleanup-contract correction was integrated into official `main` as
`0d86bd1e259d84014d459a2f2d5b162b888627af`. The coordinator recorded eight pure
cleanup and retention regressions failing against the previous source and passing
against the correction, with 26 assertions. These fixtures do not measure real
Windows process survivors or native cleanup.

[Official run 37412634848](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848)
tested that exact SHA and finished with eight successful jobs and one failed job
on its first attempt. This source remains CI-failed. No unchanged-source rerun was
used to replace the failed result.

| Runner | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64 | 673 | 94 | 1 | 768 tests in 166 files | 270.93 seconds |
| Windows x64 | 456 | 312 | 0 | 768 tests in 166 files | 291.40 seconds |
| macOS arm64 | 467 | 301 | 0 | 768 tests in 166 files | 221.85 seconds |

All eight added cleanup and retention fixtures passed on all three platforms.
Ubuntu failed the existing `automatic Chrome exit still notifies listeners when
temporary removal fails` regression at `tests/chrome-temporary-storage.test.ts:87`:
expected two notifications, received three. Its temporary-directory removal EACCES
is intentional test input. The automatic close first notifies an existing listener;
a later explicit close retries failed cleanup; registering a late listener should
produce only one additional notification. Source inspection shows that the new
retryable cleanup still emits every existing listener in its `finally` block on
each retry. This repeats a previous listener and breaks the existing exactly-once
notification contract. The independent source reviewer owns the correction. The
assertion has not been weakened. A later corrected SHA and fresh run are needed.

All six installed-browser and generated-host registration jobs passed. The Windows
installed-browser acceptance passed on its first attempt: doctor 457 milliseconds,
session creation 6128 milliseconds, stop response 552 milliseconds, and a nonempty
18348-byte JPEG. Navigation, read, pause refusal, resume and observe checks passed.
The paused action returned the expected exit code 1. Summed stage timings were
10249 milliseconds. This success does not explain the prior run's readiness
failure, whose root cause remains unknown, and does not prove zero survivors after
a startup failure. The new startup-failure diagnostic branch was not exercised by
this successful Windows smoke.

All installers reported installation, dependencies, service, verification and host
registration complete; native installation was skipped. All nine generated
Claude, Codex and Hermes entries negotiated 16 MCP tools. Actual host CLIs were
absent on all three runners. Skips remain skips, never passes. Whole-runner resource
artifacts do not measure Orbit-attributed CPU or memory, sustained reliability,
native performance or arbitrary application workloads.

| Artifact | Link |
| --- | --- |
| installed-acceptance-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11390185554) |
| installed-acceptance-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11389518878) |
| verification-resources-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11389499511) |
| verification-resources-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11389409905) |
| installed-acceptance-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11389134426) |
| verification-resources-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37412634848/artifacts/11389129978) |

Actual native opening, claim, cursor, focus, input, cleanup and performance remain
`not measured`. The owner handoff release hold remains active. The earlier rejected
native preparation path was not retried. This appended snapshot preserves all
previous successes, failures and limitations; it supersedes earlier statements of
the current CI status only for this exact source SHA.

## Notification correction verified, Windows abrupt broker death failed

The exactly-once close-notification correction was integrated into official `main`
as `5c1193d830a11b3b63ad0483288363d0f764ec3d`. The coordinator recorded ten pure
regressions passing, zero failures and 37 assertions, retaining cleanup retries and
the original EACCES fixture assertion. Later documentation-only commits do not
change the runtime source tested below.

[Official run 37413339959](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959)
tested that exact source and finished with eight successful jobs and one failed job
on its first attempt. The current source remains CI-failed. No unchanged-source
rerun was dispatched.

| Runner | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64 | 676 | 94 | 0 | 770 tests in 167 files | 345.54 seconds |
| Windows x64 | 457 | 312 | 1 | 770 tests in 167 files | 233.79 seconds |
| macOS arm64 | 469 | 301 | 0 | 770 tests in 167 files | 229.19 seconds |

The original Ubuntu `automatic Chrome exit still notifies listeners when temporary
removal fails` test passed in 1243.31 milliseconds. This verifies the correction
against the real intentional EACCES fixture that failed on `0d86`; that earlier
failed run remains preserved above. Windows and macOS skip this fixture. Pure
notification regressions and the cleanup mocks do not replace real process cleanup
evidence.

Windows failed the existing `abrupt broker death reaps its browser tree and a fresh
broker rejects stale sessions` test at `tests/browser-crash.test.ts:90`. Its
survivor assertion expected an empty list and received PID `7528`; the test duration
was 13076.12 milliseconds. The assertion is preserved and has not been weakened.
The preceding `0d86` Windows suite passed this test, which is separate evidence,
not a reason to erase the new failure or assume its cause.

The retained log reports the PID check, but no executable identity, creation time,
owned job membership or accounting at assertion time. The reviewer reports that
the test snapshots the parent process tree, then checks PID liveness with signal
zero. A live owned survivor versus PID reuse remains unknown from these artifacts.
Abrupt broker termination bypasses graceful confirmed-stop cleanup. No source cause
is asserted solely from this result. The new failure remains separate from the
older installed-browser startup readiness failure, whose root cause is still
unknown. A source investigation and justified fresh validation are required.

All six installed-browser and generated-host registration jobs passed on their
first attempt. Windows installed-browser acceptance recorded doctor 346
milliseconds, session creation 7431 milliseconds, stop response 440 milliseconds,
and a nonempty 18043-byte JPEG. Navigation, read, pause refusal, resume and observe
checks passed; the paused action returned expected exit code 1. Summed stage
timings were 10373 milliseconds. A successful graceful stop response does not
prove zero survivors after abrupt broker death or a failed startup. The new startup
failure diagnostic branch was not exercised by this successful smoke.

All installers completed dependencies, service, verification and host registration;
native installation was skipped. All nine generated Claude, Codex and Hermes
entries negotiated 16 MCP tools. Actual host CLIs were absent. Skipped tests remain
skipped. Resource artifacts describe whole-runner CPU and memory, not usage
attributed to Orbit, job membership or process identity.

| Artifact | Link |
| --- | --- |
| verification-resources-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11390680789) |
| installed-acceptance-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11390675135) |
| installed-acceptance-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11390665360) |
| installed-acceptance-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11390405777) |
| verification-resources-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11390147013) |
| verification-resources-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37413339959/artifacts/11389754968) |

Actual native opening, claim, cursor, focus, input, cleanup and performance remain
`not measured`. The owner handoff release hold and rejected native preparation
limitation remain active. All previous failed attempts, successful limited checks,
skips and unknown measurements are preserved. This appended snapshot supersedes
current-source status statements only for the exact `5c1193d` runtime source.

## Stable Windows crash diagnostics and unresolved termination measurement

The crash diagnostic correction was integrated into official `main` as
`dcf8279a5e3ffd573687778d1db860ad1755b185`. The coordinator recorded typecheck
success and 17 pure tests passing, zero failures, 55 assertions and 1453
milliseconds. It adds stable owned-process handles with creation identity and exit
measurement, plus opt-in private job membership records. The original empty
survivor assertion remains and a stronger handle-based assertion was added. These
pure checks are not measurements of real Windows cleanup.

[Official run 37414331502](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502)
tested that exact source and finished with eight successful jobs and one failed job
on its first attempt. Current source remains CI-failed; no unchanged-source rerun
was dispatched.

| Runner | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64 | 683 | 94 | 0 | 777 tests in 168 files | 299.64 seconds |
| Windows x64 | 464 | 312 | 1 | 777 tests in 168 files | 240.30 seconds |
| macOS arm64 | 476 | 301 | 0 | 777 tests in 168 files | 257.10 seconds |

Ubuntu again passed the original intentional EACCES close-notification regression,
in 926.93 milliseconds. The notification fix remains supported by this new run;
all historical failures remain recorded above.

Windows failed `abrupt broker death reaps its browser tree and a fresh broker
rejects stale sessions` at `tests/browser-crash.test.ts:136`, in 10116.11
milliseconds. This time the stronger witness assertion failed; the original PID
survivor check reported an empty list. The diagnostic before termination identified
broker PID 5740 and ten stable `chrome.exe` process handles with creation ticks and
parent IDs. The private owned job record listed the same ten members, rooted at
PID 7440. This gives direct ownership evidence for these new witnesses; it does
not retroactively establish the identity of PID 7528 from the earlier `5c` run.

The later witness record reported three processes exited with nonzero exit times,
and seven still classified alive with exit code 0 and exit time 0: 7440, 8228,
3720, 884, 4148, 3740 and 8020. The before and after diagnostic log timestamps are
approximately 67 milliseconds apart. The exit observations occurred during that
short interval, so this record does not establish eventual survivors after the
bounded cleanup period. The mismatch between the empty PID list and unsignaled
stable witnesses requires source and measurement-timing investigation. A zero exit
code alone does not establish process exit. No runtime root cause, eventual
absence of survivors or release success is asserted from this snapshot. The older
startup readiness failure remains a separate unresolved event.

All six installed-browser and generated-host registration jobs passed on their
first attempt. Windows installed-browser acceptance recorded doctor 367
milliseconds, session creation 11900 milliseconds, stop response 511 milliseconds,
and a nonempty 17935-byte JPEG. Navigation, read, pause refusal, resume and observe
checks passed; the paused action returned expected exit code 1. Summed stage
timings were 15427 milliseconds. This successful graceful acceptance does not
resolve the abrupt-death measurement or the earlier startup failure.

All installers completed dependencies, service, verification and host registration;
native installation was skipped. Nine generated Claude, Codex and Hermes entries
negotiated 16 MCP tools; actual host CLIs were absent. Whole-runner CPU/memory
artifacts do not substitute for process identity or exit observations. Skipped
tests remain skipped.

| Artifact | Link |
| --- | --- |
| installed-acceptance-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390916259) |
| verification-resources-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390906640) |
| installed-acceptance-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390746920) |
| installed-acceptance-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390667077) |
| verification-resources-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390428009) |
| verification-resources-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37414331502/artifacts/11390203122) |

The full Windows job log retains the before/after stable witness and private job
records. Actual native opening, claim, cursor, focus, input, cleanup and performance
remain `not measured`. Owner handoff release hold and rejected native preparation
limitations remain active. This appended snapshot preserves earlier failures,
skips, successes and unknowns; its current-source status applies only to `dcf8279`.

## Corrected exit measurement and fresh Windows owned-tree cleanup evidence

The polling correction was integrated into official `main` as
`1e9e88e37d299fe6ea3aed6c51e4fa6142cdcb81`. It retains the existing 150 polls,
30-millisecond spacing, 20-second test deadline and both strict empty-survivor
assertions. The loop now waits for both the PID check and stable process witnesses
to confirm exit. Runtime Windows job cleanup source did not change. The coordinator
recorded typecheck success and 21 pure tests passing, zero failures, 64 assertions
and 1156 milliseconds. The previous loop failed two added measurement regressions.

[Official run 37415015766](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766)
tested that exact source and finished with nine successful jobs on its first
attempt. No unchanged-source rerun was dispatched. Earlier failed runs remain
preserved and are not replaced by this result.

| Runner | Pass | Skip | Fail | Test scope | Duration |
| --- | ---: | ---: | ---: | --- | --- |
| Ubuntu 24.04 x64 | 687 | 94 | 0 | 781 tests in 169 files | 339.67 seconds |
| Windows x64 | 469 | 312 | 0 | 781 tests in 169 files | 241.93 seconds |
| macOS arm64 | 480 | 301 | 0 | 781 tests in 169 files | 207.54 seconds |

Ubuntu passed the original intentional EACCES close-notification fixture in
1256.31 milliseconds. Windows passed `abrupt broker death reaps its browser tree
and a fresh broker rejects stale sessions` in 11043.78 milliseconds.

The Windows crash diagnostic identified broker PID 7232, Chrome root PID 1420 and
ten stable `chrome.exe` witnesses with creation ticks and parent IDs before broker
termination. The private owned job record listed exactly the same ten process IDs:
1324, 1420, 1568, 6492, 8676, 8924, 9232, 9308, 9668 and 9732. No captured witness
was outside the recorded job. The post-termination record retained every creation
identity and reported every witness exited, with exit code 0 and a nonzero exit
FILETIME. The original PID survivor list was empty. Reported reaping time was 31
milliseconds over two polls.

This is real Windows evidence that this measured owned ten-process tree exited
after abrupt broker termination on this runner and exact source. It is bounded by
the captured tree and this single run. It does not explain whether PID 7528 from
the earlier `5c` failure was a live owned process or a reused PID, nor resolve the
older startup readiness timeout. The `dcf` diagnostic failure remains preserved as
a premature stable-witness measurement; no eventual survivor outcome was measured
there. No broader repeatability, arbitrary browser tree or startup-failure cleanup
claim follows from the new successful case.

All six installed-browser and generated-host registration jobs passed on their
first attempt. Windows installed-browser acceptance recorded doctor 528
milliseconds, session creation 6059 milliseconds, stop response 781 milliseconds,
and a nonempty 18101-byte JPEG. Navigation, read, pause refusal, resume and observe
checks passed; the paused action returned expected exit code 1. Summed stage
timings were 11151 milliseconds. This acceptance is separate from the stable
abrupt-death exit evidence above.

All installers completed dependencies, service, verification and host registration;
native installation was skipped. All nine generated Claude, Codex and Hermes
entries negotiated 16 MCP tools. Actual host CLIs were absent. Whole-runner CPU and
memory resources do not establish usage attributed to Orbit, CPU throttling, guest
steal, sustained reliability or arbitrary application workload performance.
Skipped tests remain skipped.

| Artifact | Link |
| --- | --- |
| installed-acceptance-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11390917418) |
| installed-acceptance-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11390783114) |
| verification-resources-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11390273781) |
| verification-resources-ubuntu-24.04 | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11390129517) |
| verification-resources-macos-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11389979212) |
| installed-acceptance-windows-latest | [retained run evidence](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766/artifacts/11389938921) |

The full Windows suite log retains the stable pre/post process and private job
records. The independent reviewer checked their identity, membership intersection
and exit fields. Actual native opening, claim, cursor, focus, input, cleanup and
performance remain `not measured`; owner handoff release hold and rejected native
preparation limitations remain active. This append preserves all earlier failures,
skips and unknowns. Current-source CI success applies only to the exact `1e9e88e`
runtime source and does not close the native release gate.
