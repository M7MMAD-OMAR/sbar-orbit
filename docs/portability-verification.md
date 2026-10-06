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
