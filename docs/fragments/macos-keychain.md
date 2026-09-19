# The Keychain dialog, measured on two real Macs

`docs/support-tiers.md` line 153 records "Not raising a Keychain dialog" as **Reasoned, not
measured**. The reasoning was vendor source and it was sound. This is what a GitHub macOS runner
could add to it, and, more importantly, what it could not.

## What this measures, and what it cannot

A GitHub macOS runner is a virtual Mac with no person at it, no logged in Apple ID, and a Keychain
that is not a person's. It **cannot** show that no modal dialog appears on a person's real account.
Nothing below claims it can.

What it can do is take the mechanism apart, on hosts that are real Macs running real Chrome:

| Question | Answerable on a runner |
|---|---|
| Do both switches reach the browser process the kernel reports | Yes, and they did |
| Does an Orbit launch create or modify `Chrome Safe Storage` | Yes, and it did not |
| Does the same launch WITHOUT the switches behave differently | Yes, and it did, on both hosts |
| Does a modal dialog appear on a person's screen | **No. This is the residual gap** |

## The hosts

Two, because one runner's Keychain policy is one machine's and this is a claim about a policy.

| Runner | macOS | Arch | Chrome |
|---|---|---|---|
| `macos-latest` | 26.6.2, build 25G83 | arm64 | 152.0.7977.83 |
| `macos-15-intel` | 15.7.9, build 24G830 | x64 | 151.0.7922.174 |

Both started with **no `Chrome Safe Storage` item at all** (`security find-generic-password` exit 44)
and a single user keychain, `login.keychain-db`. That is already a difference from a person's Mac and
it is the reason the experiment plants a hostile item of its own.

## Can a runner prompt at all? Asked first, because everything else is read through it

Before a launch means anything, the experiment creates its own throwaway keychain, adds an item with
an **empty trusted application list** (`-T` with nothing after it, so no binary is on its ACL), and
asks for that item's data. Off ACL is exactly the position an Orbit launch is in against the item the
person's own Chrome created.

**Both hosts BLOCKED**, for the full 20 second budget, and returned no secret. A machine that blocks
an off ACL read is a machine exhibiting the behaviour that IS a modal dialog when a person is logged
in at a window server. So the hazard is real on these hosts and not hypothetical, and the arms below
are not measuring against a keychain that waves everything through.

This is the strongest single fact a runner could contribute, and it is worth being precise about it:
it shows the block, not the dialog. A headless runner has no window server session to draw one on.

## Arm A: the switches, in the argv the kernel reports

Not the builder's return value: `ps -o command=` on every process in the session's process group,
after `launchChrome` started the browser through Orbit's own supervisor.

| | `macos-latest` | `macos-15-intel` |
|---|---|---|
| Processes in the group | 11 | 10 |
| `--use-mock-keychain` on the browser process | yes | yes |
| `--password-store=basic` on the browser process | yes | yes |
| Processes carrying the switch | 2 of 11 | 2 of 10 |
| No process carrying a contradicting store | confirmed | confirmed |

**2 of the tree is correct, and it disproved an assertion in the first version of this test.** The test
demanded the switch on every process naming the session profile and failed on both hosts against a
perfectly contained browser: renderers, the GPU process and utilities inherit `--user-data-dir` while
never touching OSCrypt, so they have no reason to carry it. The assertion now names the browser
process, the one without `--type=`, and separately asserts that no process in the tree carries a
contradicting `--password-store`. Run 35434329486 failed on it; run 35434498535 passes 9 of 9 on both hosts.

## Arm B: what a launch did to the item

`Chrome Safe Storage` read as attributes only, never `-g` and never `-w`, so the observation itself
cannot be the thing that raises a dialog.

Each arm starts from a deleted item, verified absent (`find` exit 44) immediately before the launch,
so "this arm created the item" is a fact about the arm and not about which arm ran first.

| | flagged | stripped |
|---|---|---|
| `macos-latest` 26.6.2 arm64, item created by this launch | **no**, find exit 44 | **yes**, find exit 0 |
| `macos-15-intel` 15.7.9 x64, item created by this launch | **no**, find exit 44 | **yes**, find exit 0 |

**This is the negative control and it lands on both hosts.** Strip the two switches and the very next
headless launch creates a `Chrome Safe Storage` item in the login keychain. Keep them and the item
never appears, on either macOS version, in either the shell control or the experiment. Both arms
published a CDP endpoint either way, which is the point: the browser does not fail loudly without the
switches, it quietly reaches for the keychain, and only the item says so.

**The first run of this control proved nothing and is worth recording as a trap.** It ran after the
experiment, which had already created the item in its own stripped arm, so both arms read "present"
and macOS 15.7.9 showed no contrast at all. That looked like a platform difference and was step
ordering. The control now deletes the item before each arm and runs before the experiment.

## Arm C: the hostile item

The closest a runner gets to a person's Mac. A `Chrome Safe Storage` item is planted in a throwaway
keychain with an empty ACL and that keychain is put first in the user search list, so every reader is
off its ACL exactly as Orbit is off the ACL of the item the person's Chrome created. Then both arms
run again.

Both arms, on both hosts, published a CDP endpoint in under one second and **left the planted item's
modification date unchanged**. No arm hung. That is a weaker reading than it looks: with no window
server session, a runner's `SecItemCopyMatching` returns `errSecInteractionNotAllowed` rather than
waiting on a person, so "did not hang" here is not "did not prompt".

## Cleanliness

The after step on both hosts confirms the experiment's own probe item is gone (exit 44) and the user
keychain search list is back to `login.keychain-db` alone. Every keychain item touched was one this
experiment created. No secret is printed at any verbosity, and the one `-w` read in the whole file is
against an item the experiment itself added with a password it generated.

## What tier this supports

**Limited, measured on two GitHub macOS runners.** Not `Measured`. The claim in the tier table is
about a dialog on a person's screen, and the thing observed is the argv, the item, and the block. The
limit belongs printed beside the claim:

> The two switches reach the browser process on macOS 26.6.2 arm64 and 15.7.9 x64, an Orbit launch
> creates no `Chrome Safe Storage` item, and removing them makes the very next launch create one on
> both hosts. That no modal appears on a person's real account is still unobserved: a runner has no
> window server session to draw one on, and its keychain is not a person's.

## What is still not measured

- **The dialog itself.** A throwaway account on a real Mac, with a real Chrome history and a person
  logged in, is what closes this. A runner never can.
- **Anything about a person's existing item.** This experiment never reads one, by design.

## The runs

| Run | What it produced |
|---|---|
| [35434329486](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35434329486) | First real reading. 8 of 9 tests, the darwin argv test failing on its own over strong assumption, and a negative control that proved nothing because it ran after the experiment |
| [35434498535](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/35434498535) | Both corrections, against main at 5576f11. 9 of 9 on both hosts, control landing on both |

## Reproducing

`.github/workflows/verify-macos-keychain.yml`, `workflow_dispatch` or a push to an agent branch that
touches the experiment. Artifacts `verify-macos-keychain-macos-latest` and
`verify-macos-keychain-macos-15-intel` carry `before.log`, `suite.log`, `negative-control.log`,
`experiment.log` and `after.log`.

The experiment drives no session capture, so `ORBIT_CAPTURE_TIMEOUT_MS` is not in its path: it
launches browsers and reads process tables and keychain attributes, and never observes a frame.
