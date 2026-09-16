# Support tiers

What Orbit is known to do, on which host class, on what evidence, and as of when.

This file exists so that a person installing Orbit on a machine this project has never touched can
tell, before they file anything, whether they have found a bug or have simply become the first person
to run it there. Those are different reports and they go to different forms.

**Orbit is measured on exactly one host class: Fedora 44, wlroots, cgroup delegation.** There is no
macOS, Windows or non Fedora Linux machine in this project's reach. Every row below that names another
platform is reasoning about vendor documentation, not a test, except the Linux rows marked `Limited`,
which since 14 September 2026 come from containers of those families run on the measured host.

Run `sbar-orbit doctor --report` before reading further. It is local, it needs no broker, and the
`tier.assigned` it prints is the row that applies to you. It is safe to paste into a public issue, and
you should still read it first.

## The vocabulary

Five tiers, because the evidence has five states and collapsing them prints a pass over a recorded
failure. The definitions are in [porting.md section 2](porting.md) and are repeated here because this
is the file the tracker is judged against.

| Tier | Exact promise |
|---|---|
| **Measured** | A named test in [validation.md](validation.md) ran on a host of this class and passed, and the command that reproduces it is in this repository |
| **Limited** | It ran here and passed inside a stated limit: a fixture rather than the real thing, or a subset of the capability. The limit is printed beside the tier, never omitted |
| **Failed** | It ran here and did not pass. The result is preserved, not retried into silence |
| **Reasoned** | The platform documents the primitive. No host of this class is in this project's reach and no test has run on one. Installing here produces a test report, not a bug report |
| **Refused** | A primary source says it cannot work. Orbit throws `UNSUPPORTED` rather than degrading, and the tracker does not accept a bug for it |

`Measured` is never awarded by a probe. The most a capability probe can say is that your host is the
same class as the one the measurements were taken on, which is a reason to expect a test report rather
than a bug report. `bun run verify` is how a host earns anything stronger.

A `Measured` row resting on one external host prints `Measured, 1 host, issue #N` in its evidence
column. That is the evidence column doing its job, not a sixth tier.

## Fedora 44, wlroots, cgroup delegation

The only class with rows that are not reasoning. Measured on `0.1.0-alpha.1` and on the commits that became `0.1.0-alpha.2`; each row carries its own date.

| Capability | Tier | Evidence | Date |
|---|---|---|---|
| Owned headless browser, fresh profile | Measured | `bun run verify`, browser lifecycle tests, and a 600 second viewer run at 5.006 FPS with maximum sampled frame age 284 ms | 12 September 2026 |
| Private display, real desktop applications | Limited: nineteen applications across GTK4, GTK3, LibreOffice, Qt 6 and Xwayland launched and mapped, a file was saved, and the GTK file chooser opened and worked with no session bus at all, which closed G10. Still one host | `experiments/native-editor.ts --dialog`, `experiments/application-coverage.ts`, `experiments/multi-application.ts` | 14 September 2026 |
| Viewer and pause | Measured | `experiments/viewer-timing.ts 600`, 2077 submissions, 3005 frames | 11 September 2026 |
| Human takeover and resume | Failed | [validation.md](validation.md) records the manual resume workflow as not completed, and further interactive trials as on hold. G27 | 10 September 2026 |
| One core budget, participant acceptance | Failed | The participant stopped the trial at about 123 seconds over CPU cost. A scheduling defect was found and fixed; no second trial has run | 10 September 2026 |
| One core budget, measured share | Measured | 10.4% of one core with a session open and idle, 58.0% working with a viewer at the 1 FPS default | 11 September 2026 |
| Process containment | Measured | 117 sampled tree audits found no escapes, and `tests/chrome-containment.test.ts` | 11 September 2026 |
| Several agents at once | Measured | Three browsers and two displays on one broker, 20 of 20 rounds, 93.2% of one core. Nine at once: five complete, four refused with a retryable `DEADLINE_EXCEEDED` | 11 September 2026 |
| Real sessions, profile clone | Limited: the clone and decrypt path is measured, and the capability is not shippable at this evidence. 167 of 167 cookies cloned, 142 of 142 decrypted | `ORBIT_REAL_PROFILE=1 bun run scripts/limited.ts bun run experiments/real-profile-clone.ts` | 11 September 2026 |
| A secret service that holds exactly one item | Measured | 1 item enumerated against the filtering proxy's 25, same 142 of 142 decrypted, `systemd1` blocked, and the browser asked exactly once. G8 closed | 11 September 2026 |
| Origin lease inside the browser | Measured | Eleven of eleven page initiated routes off the leased origin blocked, with positive controls for a service worker and a WebSocket, and a server side redirect held a hop at a time | 11 September 2026 |
| Origin lease below the browser | Measured | A confined browser with its proxy setting removed reaches nothing; unconfined it reaches everything. CDP crossed the namespace, https tunnelled for the leased authority only, no sockets or helpers left behind | 12 September 2026 |
| Advisor decided consults | Measured | Every failure path denies and names itself: crash, hang past budget, non zero exit, unparsable output, non object, an answer that is neither allow nor deny, a missing command and an empty command | 11 September 2026 |
| An immune set nothing clears | Measured | Against the most permissive policy the parser produces, the immune action was refused, the advisor never saw it, and the session was contained for the rest of its life | 11 September 2026 |
| Restore points, and restore | Limited: a restore is permitted only where a snapshot could undo the action, which on a browser session means a session that has not browsed. Snapshots measured at 0.00 B exclusive | `bun test tests/restore.test.ts`, `tests/session.test.ts` | 12 September 2026 |
| Flatpak or Snap browser as the launch path | Refused | A sandboxed browser's own runtime is not the one Orbit launches, and the branding to keyring item link cannot be established across packagings. See [porting.md section 4](porting.md) | 11 September 2026 |

## Linux, another glibc distribution

No real host in reach. Since 14 September 2026 four families run as containers on the measured host,
`experiments/linux-families/run.sh`, which is enough to say whether the compositor loads and starts
and nothing about a screen, a GPU or a systemd user session. Those rows are `Limited` and say so; the
rest stay `Reasoned`.

| Capability | Tier | Evidence, or what would move it | Gate |
|---|---|---|---|
| Owned headless browser, fresh profile | Measured, 1 host: Ubuntu 24.04.5 on a GitHub runner, `bun run verify` inside `sbarorbit.slice`, 234 pass, 0 fail, 22 native tests skipped, about 120 s, four runs on the day | `verify-ubuntu-24.04-2026-09-14.log` attached to the `v0.1.0-alpha.5` release; the tab closing test failed twice in four runs there on a timer that a slower host beat, and closes on the test's own signal now | |
| One command install, the service, and a session through it | Measured, 1 host: Ubuntu 24.04.5 on a GitHub runner with a systemd user session, `./install.sh --json` installed and started the service, `doctor` answered, and a browser session navigated, read and captured a frame. Found and fixed there: the launcher's PATH dependence, which a systemd service does not have | `install-ubuntu-24.04-2026-09-14.log`, `session-ubuntu-24.04-2026-09-14.log` and the frame, attached to the `v0.1.0-alpha.5` release | gate 3, browser half |
| Private display, bundled compositor | Limited on Arch and openSUSE Tumbleweed: `dlopen` loads, `ldd -r` clean, smoke probe and frame pass in a container. Refused on Debian 13 and Ubuntu 24.04: `libdisplay-info.so.3` on both, `liblcms2.so.2` and older libinput, libwayland and pixman symbols on Ubuntu | `experiments/linux-families/run.sh`, 14 September 2026 | G2 |
| Private display, the family's own sway from a private prefix | Limited on all four: Debian sway 1.10.1, Ubuntu sway 1.9 (needs `--unsupported-gpu` beside a proprietary NVIDIA module, recorded), Arch sway 1.12, Tumbleweed sway 1.12, each passing the smoke probe with the Fedora built pointer helper | `experiments/linux-families/run.sh`, 14 September 2026 | G5 |
| Compositor with no logind session | Limited: started in 51 ms on all four with nothing open under `/run/systemd`, `/run/seatd`, `/run/user` or `/run/dbus` | Same run | G1 |
| Real sessions, profile clone | Reasoned, and only where reflink and a secret service both answer | The reflink probe and the keyring item check, both of which `doctor --report` already prints | |
| Origin lease below the browser | Limited: `bwrap` and `socat` packaged on all four, the probe passes, and the network namespace confined a fetch to the socat relay alone. The pid half of Orbit's shape is a container limit, and a real host's AppArmor `userns` policy is unmeasured | Same run; then the `confinedEgress` probe and `experiments/confined-egress.ts` on a real host | G29 |
| Everything inside a rootless container | Limited, on a Toolbx container of the measured host: the compositor inside publishes a Wayland socket the host's helper binds, Xwayland refuses to start inside on the ownership of the shared `/tmp/.X11-unix` so X11 is refused with no display number ever allocated, and `systemd-run --user --scope` from inside lands in `sbarorbit.slice` with `cpu.stat` readable | `experiments/toolbox-gates.sh`, 14 September 2026 | G6, G7 |

## Linux, musl, or no desktop stack

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser | Reasoned | Nothing in the browser path needs a desktop session |
| Private display | Refused for musl | The bundled runtime is glibc linked |
| Real sessions, profile clone | Refused without reflink | A 5.3 GiB profile copy without reflink is a real multi gigabyte copy, which is a disk filling surprise rather than a feature |

## Windows 10 1809 and later

Gated as a whole platform. Two hosts have now answered. Since 14 September 2026 a Windows Server 2025
runner (10.0.26100) has run `experiments/platform-probe/`, report
`platform-probe-windows-2026-09-14.json` attached to the `v0.1.0-alpha.5` release. Since 16 September
2026 a **Windows 11 25H2 guest** (build 26200, 8 vCPU, Edge 151, Bun 1.4.2) under libvirt on the
measured host has run the probes in `experiments/windows-vm/`, recorded in
[windows-measured.md](windows-measured.md) with raw numbers in
`evidence/windows-vm-2026-09-16.json`. Both are `Limited`: borrowed or virtual machines with no
person at them, and one of the two has no Chrome, only Edge.

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser, fresh profile | Limited | Chrome resolved through `App Paths`, launched headless under a job object, rendered a page to PNG on the runner. On the guest, Edge 151 answered CDP from inside a job object. No broker ran on either yet |
| The source tree itself | Limited | On the guest: `bun install --frozen-lockfile` exit 0 with 100 packages, `bun run typecheck` exit 0, and `bun test` 123 pass, 107 fail, 18 skip. The remaining failures were four named causes, not an unknown: the cgroup budget, `/usr/bin/python3` helpers, symlinks needing elevation, and systemd probes. The first of those is closed: `requireResourceBudget()` branches to the job object, an unmanaged broker binds on the guest and answers `doctor`, and a session refuses at the Chrome launcher instead |
| A broker as a Windows service, in session 0 | **Refused** | Measured on the guest: a Chromium family browser launched from session 0 as SYSTEM exits at once and never publishes `DevToolsActivePort`, with or without `--headless` and with or without `--no-sandbox`. The same launch in the interactive session answered CDP. So the broker runs in the person's session, there is no analogue of `loginctl enable-linger`, and autostart is a per user mechanism |
| Broker transport | Limited, and simpler than planned | Measured on the guest: **`Bun.serve({unix})` serves an AF_UNIX socket on a Windows FILESYSTEM path**, the same call `src/ipc.ts` already makes, and a POST through `fetch(..., {unix})` returned the handler's body. `Bun.serve` still refuses a pipe NAME (Bun issue 15350 reproduces on 1.4.2) and `node:net` still serves one with explicit framing. Loopback TCP stays refused |
| Broker socket access control | Limited | The socket file under `%LOCALAPPDATA%` inherits `SYSTEM`, `BUILTIN\Administrators` and the owning user, with **no Everyone and no Anonymous**, unlike a named pipe's default. Narrowed to one user ACE, `D:PAI(A;OICI;FA;;;<user>)`, from Bun with `Set-Acl` and no native code, and the server kept serving across the change |
| Broker peer identity | **Refused** | Windows AF_UNIX carries no ancillary data, therefore no `SO_PEERCRED`. The directory ACL is the whole access control. A kernel provided peer identity needs `ImpersonateNamedPipeClient`, which needs a process owning the pipe handle, which is native code this repository does not have |
| Process containment, job objects | Limited | Chrome's ten processes stayed inside a `KILL_ON_JOB_CLOSE` job on the runner. On the guest, `KILL_ON_JOB_CLOSE` plus a 2 GiB `JOB_MEMORY` plus `ACTIVE_PROCESS` 512 plus a 25.00% hard CPU cap were all accepted with no DFSS refusal, and closing the last job handle left **zero** survivors in three runs. G16 |
| Containment, completeness of the session tree | Limited, with a known race | Measured on the guest: `AssignProcessToJobObject` landed 76 ms after spawn, and in that window Chrome's `--type=crashpad-handler` was outside the job, 13 of 14. A second run leaked in neither arm, so the escape is intermittent rather than closed. `PROC_THREAD_ATTRIBUTE_JOB_LIST` is the only spawn that removes the window and needs native `CreateProcessW`. Until then the job's PID list is walked on every budget sample |
| Resource accounting | Limited, weaker than Linux | No job information class reports current committed memory outside a limit violation notification. `PeakJobMemoryUsed` is a high water mark: measured 302.6 MiB peak against 286.9 MiB live, which had to be summed per process. `resourceStatus()` publishes `swap: "not bounded"` |
| One core budget, commit ceiling | Limited | On the runner, byte identical PNG in the same 8.4 s capped and uncapped. On the guest, four cap settings (none, 25%, 50%, 100%) twice each gave 1198 to 1522 ms with no trend and one identical PNG hash at every cap. A first run showing a 7.5x slowdown under the cap did **not** reproduce and was a cold start. G17 |
| Real sessions, profile clone | **Refused** | App Bound Encryption returns `kNotUsingDefaultUserDataDir` for any non default user data directory, and returns before the policy branch, so `ApplicationBoundEncryptionEnabled=0` does not help either |
| Native applications with both separate input and real sessions | **Refused** | A `CreateDesktop` desktop cannot reach the person's running applications, and `SendInput` on the person's desktop drives their windows |
| A second concurrent interactive session for one user | **Refused** | Not a supported configuration on Windows 11 Pro or Home. Wrapper unlocks are refused on the license, not on feasibility |
| Origin lease below the browser | Limited, and narrower than a namespace | A firewall rule scoped to the program path blocked the internet and left loopback for headless Chrome on the runner, with no driver; it holds every `chrome.exe` on the machine rather than one session, so it is not the per session boundary. Not re run on the guest. G28 |
| A headed browser on the person's desktop as a fallback | **Refused** | There is no such path, at any tier, for any error |

## macOS 13 and later

Prototype and measure on hardware. Since 14 September 2026 a macOS 26.6.2 runner (virtual Apple M1,
Chrome 152) has run `experiments/platform-probe/`, report
`platform-probe-macos-2026-09-14.json` attached to the `v0.1.0-alpha.5` release; those rows are `Limited`, and a runner's Keychain
and TCC state is not a person's Mac, so the no prompt guarantee stays unproven.

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser, fresh profile | Limited | Chrome's bundle verified with `codesign --strict`, Team ID read at runtime, launched headless against a fresh profile and wrote a `v10` cookie. No broker ran there yet |
| Resource accounting | Limited | `proc_pid_rusage` reachable from `bun:ffi` with no helper; `ri_phys_footprint` 88.9 MiB against `ps` 115.4 MiB. G24 |
| Session job, `launchctl` | Limited | `bootstrap gui/501` accepted a job in a real gui session and `bootout` left no survivors of its group. A Keystone agent was not present to test. G25 |
| Profile clone on APFS | Limited | `cp -c` shared blocks with no growth in used space, `cp -Rpc` returned 0. G22 |
| Real sessions, profile clone | Reasoned, and every failure mode is a dialog on the person's screen | The Keychain ACL is keyed to the saving application's code signature. On the runner a `ditto` copy of Chrome decrypted with no hang and a `gui` job read the profile `allowed`, which is consistent with the design and not proof on a person's Mac. G19 to G22 |
| Reading `Chrome Safe Storage` from any helper binary | **Refused** | Chromium's own design document states macOS raises a dialog when a different application requests the item, and that dialog takes focus on the person's screen |
| Native applications with both separate input and real sessions | **Refused** | No second concurrent GUI session for one user, and acting in place drives the person's own windows |
| A second Aqua session for an already logged in user | **Refused** | No documented Apple API creates one. Fast User Switching gives a different user a different Keychain |
| Screen Recording, Accessibility, Input Monitoring, Automation | **Refused** | Each is a dialog, and each of the four is a route Orbit does not need |
| Downloading a browser or a helper | **Refused** | First launch of a quarantined binary prompts |
| Any macOS version below 13 | **Refused** | TCC behaviour there is unmodelled, so it is refused rather than reasoned |
| Origin lease below the browser | Reasoned, with no equivalent designed | No network namespaces. `pf` is system wide and root only, and a per process filter means a Network Extension, which means an entitlement and a signed installer. G30 |

## Which report to file

| What you have | Where it goes | What it must carry |
|---|---|---|
| A `Measured` row that did not hold on a Fedora 44 wlroots host | Bug report | `sbar-orbit doctor --report`, the command you ran, and what happened instead |
| A `Reasoned` row that you tried on your own host class | Platform test report | The same report, plus which gate you closed or failed, and the output you read it from |
| A `Refused` row | Nowhere | The refusal carries a primary source in this file. If you believe that source is wrong, the report is about the source, not about Orbit |
| A `Failed` row | Nowhere new | It is already recorded. A second data point on the same failure is welcome as a platform test report |

A platform test report that closes a gate moves a row from `Reasoned` to `Measured, 1 host, issue #N`
in this file, with the date and the Orbit version it was run against. Nothing moves without that.
