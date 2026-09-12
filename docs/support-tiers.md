# Support tiers

What Orbit is known to do, on which host class, on what evidence, and as of when.

This file exists so that a person installing Orbit on a machine this project has never touched can
tell, before they file anything, whether they have found a bug or have simply become the first person
to run it there. Those are different reports and they go to different forms.

**Orbit is measured on exactly one host class: Fedora 44, wlroots, cgroup delegation.** There is no
macOS, Windows or non Fedora Linux machine in this project's reach. Every row below that names another
platform is reasoning about vendor documentation, not a test.

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
| Private display, real desktop applications | Limited: four GNOME and KDE applications launched and a file was saved. No session bus, so portal backed file dialogs are the next gate, G10 | `experiments/native-editor.ts`, `experiments/multi-application.ts` | 11 September 2026 |
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

No host in reach. Every row is `Reasoned` unless a primary source refuses it.

| Capability | Tier | What would move it | Gate |
|---|---|---|---|
| Owned headless browser, fresh profile | Reasoned | `bun run verify` on that host | |
| Private display | Reasoned | Whether the bundled `libwlroots-0.19.so` loads on that glibc, then the compositor smoke and frame capture checks | G2, G5 |
| Real sessions, profile clone | Reasoned, and only where reflink and a secret service both answer | The reflink probe and the keyring item check, both of which `doctor --report` already prints | |
| Origin lease below the browser | Reasoned | The `confinedEgress` probe, then `experiments/confined-egress.ts`. Unprivileged user namespaces are present, absent, or administratively disabled, and only asking tells the three apart | G29 |
| Everything inside a rootless container | Reasoned | Whether a user namespace nests, and whether `systemd-run --user --scope` registers on the host manager | G6, G7 |

## Linux, musl, or no desktop stack

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser | Reasoned | Nothing in the browser path needs a desktop session |
| Private display | Refused for musl | The bundled runtime is glibc linked |
| Real sessions, profile clone | Refused without reflink | A 5.3 GiB profile copy without reflink is a real multi gigabyte copy, which is a disk filling surprise rather than a feature |

## Windows 10 1809 and later

Gated as a whole platform. Nothing may be claimed until a Windows host runs the probes in
[porting.md section 7](porting.md).

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser, fresh profile | Reasoned | |
| Broker transport | Reasoned | A named pipe is the design. Loopback TCP is refused: it is reachable by every process on the machine, so the broker refuses to start rather than listen weakly. G15 |
| Real sessions, profile clone | **Refused** | App Bound Encryption returns `kNotUsingDefaultUserDataDir` for any non default user data directory, and returns before the policy branch, so `ApplicationBoundEncryptionEnabled=0` does not help either |
| Native applications with both separate input and real sessions | **Refused** | A `CreateDesktop` desktop cannot reach the person's running applications, and `SendInput` on the person's desktop drives their windows |
| A second concurrent interactive session for one user | **Refused** | Not a supported configuration on Windows 11 Pro or Home. Wrapper unlocks are refused on the license, not on feasibility |
| Origin lease below the browser | Reasoned, with no equivalent designed | There is no `--unshare-net`. What exists is a network compartment or a Windows Filtering Platform filter, one of which needs a driver. G28 |
| A headed browser on the person's desktop as a fallback | **Refused** | There is no such path, at any tier, for any error |

## macOS 13 and later

Prototype and measure on hardware. The no prompt guarantee is unproven, and the profile clone is not
on the list of things to build.

| Capability | Tier | The deciding fact |
|---|---|---|
| Owned headless browser, fresh profile | Reasoned | |
| Real sessions, profile clone | Reasoned, and every failure mode is a dialog on the person's screen | The Keychain ACL is keyed to the saving application's code signature. G19 to G22 |
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
