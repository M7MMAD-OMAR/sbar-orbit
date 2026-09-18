# macOS, measured on a real host

> How to read this: every number here was produced on a GitHub `macos-26-arm64` runner, Apple
> silicon, on 18 September 2026, by the `verify-macos` job in
> `.github/workflows/platform-probes.yml`. That is a real Darwin kernel, a real signed Google Chrome
> and Orbit's own code, so these rows are `Limited` rather than `Reasoned`: one host class, a
> virtual machine, nobody sitting at it, and a Keychain and TCC state that are not a person's. They
> are not `Measured`, which this project reserves for the Fedora 44 host class the suite is
> maintained against.
>
> The earlier macOS evidence, `docs/evidence/platform-probe-macos-2026-09-14.json`, answered gate
> questions with standalone probes and never ran a line of Orbit. This document is the other half:
> Orbit's own broker, budget, launcher and containment, on a Mac.

The tooling is `.github/workflows/platform-probes.yml` (`verify-macos`),
`experiments/macos-reaping.ts`, `experiments/macos-orphan-sweep.ts` and
`experiments/macos-qos-cost.ts`. The adapter this shaped is `src/macos.ts`, `src/macos-budget.ts`,
`src/macos-autostart.ts`, `src/macos-orphans.ts` and `src/native/supervise-darwin.ts`. The sourced
research the design came from, and the adversarial audit of the result, are in
[research/macos/](research/macos/).

## 1. What a Mac does, end to end

Driven through the INSTALLED command, the way the contract in `docs/agent-install.md` instructs, not
through the source tree:

| Step | Result |
|---|---|
| `./install.sh --json` | exit 0 |
| The launch agent | `launchctl print gui/$UID/com.sbar.orbit.broker` exit 0, so launchd holds it |
| `doctor` | exit 0 against the managed socket under `~/Library/Application Support/sbar-orbit` |
| `session create browser` | a session reached `closed` cleanly after its actions, id recorded, backend `browser`, surface 1280x800, egress tier `in-browser` |
| `navigate` and `read` | both applied |
| `session observe --output` | a **17273 byte JPEG** of the rendered page |
| `session stop` | exit 0 |

The frame size is checked against a floor rather than merely for existence, because the Windows port
was once handed a blank 6758 byte JPEG that passed a byte count check while the navigation had
silently never happened.

## 2. Containment, which is the row this platform could most easily lie about

macOS has no `KILL_ON_JOB_CLOSE` and no cgroup. The design is a session leader, a pipe, and a
`killpg` sweep, and every layer of it is userland. So it was measured rather than asserted:

```
experiment: macos-reaping
launchMs:              1445
processesBeforeKill:     10   (Chrome 153.0.8010.48: browser, GPU, network, 5 renderers, helpers)
brokerKilledWith:    SIGKILL   (no cleanup handler runs, by design)
survivorsAfterSweep:      0
clearedAfterMs:         105
```

**Ten processes, the supervisor killed outright, zero survivors after 105 ms.** Repeated in every
run since, 9 to 10 processes and 0 survivors in 60 to 137 ms. For comparison the Windows guest
measured 12 processes and 0 survivors after 236 ms, and the mechanisms are different: there the
kernel does it, here a supervisor does.

### The second layer, and why it is reported as not measured

A supervisor that is itself SIGKILLed runs no sweep, so `src/macos-orphans.ts` exists to reap what is
left when a broker next starts. `experiments/macos-orphan-sweep.ts` was written to prove it: start a
real session, SIGKILL the SUPERVISOR rather than the browser, confirm the tree is genuinely still
running, then call the sweep the way the broker calls it.

On the runner it returned **`not measured`**, and the reason is the interesting part:

```
processesAtLaunch:      10
orphanedProcesses:       0
verdict: "not measured: the tree did not survive the supervisor, so there was no orphan to sweep"
```

**The browser tree did not survive its supervisor's death at all.** Chrome noticed its parent was
gone and exited on its own, so there was no orphan for the second layer to find. That is a better
outcome than the one being tested for, and it is still not evidence that the sweep works: the
experiment refuses to report a pass for a tree that died by itself, because crediting the sweep for
that would be exactly the kind of claim this project does not make.

So the second containment layer is **implemented, unit tested for its refusals, and unproven end to
end**. `tests/macos.test.ts` pins the part that can be tested without an orphan: given a record whose
process group cannot be proved Orbit's, the sweep refuses to signal it, and the test runner surviving
its own group is the direct evidence of that refusal. What remains unproven is the happy path, and it
needs a browser that outlives its supervisor, which this host would not produce.

## 3. The budget, and the word that carries the difference

`bun test` on its own **exited 1** with `RESOURCE_LIMIT_REQUIRED`, exactly as on Linux. The registry
path is therefore doing the job the cgroup does there: a command outside the budget is refused.

What it reports is deliberately not shaped like the Linux answer:

| Field | Linux | macOS |
|---|---|---|
| `enforcement` | `kernel-cgroup` | `advisory` |
| `unbounded` | `[]` | `["cpu", "memory", "swap", "processes", "threads"]` |
| `scope` | `all-orbit-jobs` | `all-orbit-groups` |
| `events` | kernel counters | `null`, because there are no limits to have events |

The numbers are real: the footprint is a live sum of `ri_phys_footprint` across every registered
process group, read from the kernel. The CEILING is not enforced. Nothing stops a browser that
allocates past it; what the ceiling does is refuse the NEXT session. That is a weaker promise than
Linux makes and the field says so rather than printing a 2 GiB figure shaped like `memory.max`.

Research behind this, with primary sources, is summarised in [porting.md section 6](porting.md): the
one kernel object with the right shape is the task coalition, and creating one is gated on
`task_is_in_privileged_coalition()`, spawning into another needs a private Apple entitlement, and
`coalition_ledger()` is root only and caps disk writes rather than CPU or memory.

## 4. Defects a real Mac found that no amount of reading would have

Six from the first run, listed because a port's value is largely in what running it turned up. The
eight an adversarial audit found afterwards are in section 8.

| Found | Cause | Fix |
|---|---|---|
| `tests/browser-crash.test.ts` reported 0 descendants of a live browser | It walks `/proc`, which does not exist on Darwin | `proc_listchildpids` through the same FFI layer the adapter uses |
| The same suite reported every process dead instantly | `alive()` used `Bun.file("/proc/<pid>/stat").exists()` on a platform with no `/proc`, so a live tree read as gone | Signal 0 on both non Linux platforms |
| A whole test file died before its first assertion with `EADDRINUSE` | Fixtures bind `127.0.0.2`; Linux routes all of `127.0.0.0/8`, macOS attaches only `127.0.0.1` to `lo0` | `loopbackAddress` in `tests/platform-support.ts` |
| Two install suites failed on paths that were the same directory | `tmpdir()` is `/var/folders/...` and `/var` is a symlink to `/private/var`, while the installer correctly calls `realpath` | `resolvedTmpdir()` in the FIXTURE, so the product's `realpath` keeps guarding symlinked prefixes |
| `preflight` claimed a supported platform was unsupported | The test used `darwin` as its stand-in for "no adapter exists" | The stand-in is now `freebsd` |
| Three suites asserted a two platform world | `enforcement`, `scope` and the capability notes had no third branch | A `darwin` branch in each, asserting the weaker promise explicitly |

Two more came from the research rather than the run, and both are proven from vendor source:

- **The Keychain dialog.** `keychain_password_mac.mm` looks the cookie key up with
  `FindGenericPassword(service: "Chrome Safe Storage", account: "Chrome")`. Those are compile time
  constants: **a fresh `--user-data-dir` does not produce a fresh item**, so on any Mac where Chrome
  has ever run the item exists and a binary not on its ACL raises a modal dialog on the person's
  screen. `--headless` does not suppress it. Orbit passes `--use-mock-keychain`, whose own header in
  `os_crypt_switches.h` says it exists to prevent "blocking dialogs", with `--password-store=basic`
  behind it.
- **Crashpad escapes the sweep.** `crashpad/util/posix/spawn_subprocess.cc` double forks and calls
  `setsid()`, with a comment saying the grandchild is "expected to outlive the parent process". It
  is in neither the process group nor the session, and is reparented away, so `killpg` misses it and
  a descendant walk misses it. Orbit passes `--disable-crash-reporter`. This is the same process the
  Windows port removes with `--disable-crashpad`, found there by measuring 13 of 14 processes inside
  the job.

## 5. Process group reuse, the one hazard this design creates

A pgid is reused. A sweep that trusts a remembered number can `killpg` a group that now belongs to
the person: their browser, their shell. That would be the worst thing this code could do, and it is
a hazard the Linux design does not have, because `ownsGroup()` there reads the leader's environment
out of `/proc` before signalling.

So a group is never signalled on its number alone. The supervisor records the leader's start time
(`proc_pidinfo(PROC_PIDTBSDINFO)`) and executable at the moment it creates the group, and
`groupIsStillOurs()` checks both before any sweep, before `assertContained()` trusts a group, and
before the budget registry counts an entry. `tests/macos.test.ts` proves the guard REFUSES: a
correct pgid with a start time an hour off is rejected, and so is a correct pgid with the wrong
executable.

## 6. What macOS refuses outright

Not gaps to fill later. Each is a capability the platform does not offer, with the deciding fact:

- **The private display.** There is no second concurrent GUI session for one user, so there is
  nowhere private to put a native application. Acting in place would drive the person's own windows.
- **An origin lease below the browser.** No network namespaces. `pf` is system wide and root only,
  and a per process filter means a Network Extension, an entitlement and a signed installer. macOS
  is `in-browser` by design and the tier table says so.
- **Starting from the person's own profile.** Three independent reasons, in section 5 of
  [support-tiers.md](support-tiers.md), any one of them sufficient.

## 7. The suite on a Mac, and what the timeouts actually were

Five runs, and the numbers moved the way fixing real defects moves numbers:

| Run | Commit | pass | fail | skip | suite time |
|---|---|---|---|---|---|
| 1 | `9086484` | 215 | 12 | 85 | 314 s |
| 2 | `9086484`, the same commit re-run | 213 | 14 | 85 | 313 s |
| 3 | `a10b9cd`, after the fixes in section 4 | 223 | 8 | 85 | 356 s |
| 4 | `0654b13`, after the enumeration fix | 229 | 5 | 86 | 334 s |
| 5 | `3135b16`, after the scheduling class fix | 237 | **0** | 86 | 190 s |
| 6 | `3135b16`, the same commit re-run | 236 | 1 | 86 | 185 s |
| 7 | `4ceef2e`, after the endpoint deadline fix | 238 | **0** | 86 | 227 s |
| 8 | `4ceef2e`, the same commit re-run | 237 | 1 | 86 | 259 s |
| 9 | `ec1a060`, the audit fixes | 235 | 3 | 86 | 311 s |
| 10 | `d8ee400`, the five audit defects fixed | 238 | 4 | 86 | 331 s |
| 11 | `3b4a8ee`, two of my own test assumptions corrected | 241 | 2 | 86 | 223 s |
| 12 | `666f5b0`, the pid against pgid fix | 235 | 8 | 86 | 377 s |

Run 12 is the clearest evidence in the table that these failures are load and not code. It carries
the same product as run 11 plus one corrected test assertion, and it failed eight times instead of
two while taking **377 seconds against 223**. All eight are browser driven timeouts, none is an
assertion about a wrong value, and the suite that produced two failures in 223 seconds produced eight
in 377. A runner that is 69% slower fails more clocks.

**Read the whole column, not the best row.** Three commits were each run twice and each produced one
green and one red: `9086484` gave 12 then 14, `3135b16` gave 0 then 1, `4ceef2e` gave 0 then 1. A
single green run on this host does not mean the suite is green, and this table exists so nobody
quotes run 5 or run 7 on its own.

Runs 10 and 11 are worth separating, because three of their six failures were **not the product**:
they were tests written in the preceding commit asserting things macOS does not do. In order of
discovery: `proc_listpids` returns 0 bytes for a group that does not exist rather than a negative, so
an absent group is EMPTY and not an error; `registerBudgetGroup` checks group leadership before it
checks its path, so driving the new root validation through the front door never reached it; and
`processGroupMembers(process.pid)` asks about the group whose id equals this pid, which exists only
for a group leader, so it measured a group that is not there and read zero.

That last one is worth stating plainly rather than filing quietly: it is the same pid against pgid
confusion the test was written to guard against, committed inside the test. Every other caller in the
tree, in both experiments and in the budget registry, already resolves a real pgid or reads one out of
`owner.json`, so the mistake was confined to the assertion.

What the column does show is a real trend that is not noise: **12 failures down to between 0 and 3
product failures, and every one of those after run 4 is a browser driven timeout rather than a failed
assertion.** Six of the original twelve were assertions about wrong values, and each of those was a
defect that is now fixed.

### The two defects the early timeouts were hiding

The darwin-background scheduling class is **inherited**, and Orbit was applying it twice: once to the
whole command in `scripts/limited.ts`, and again per browser in `launchOnDarwin`. The second
application spawned a `taskpolicy` process per session and changed nothing. Removing it took the
suite from 5 failures in 334 seconds to 0 in 190.

Then run 6 failed once with a message specific enough to act on: **"Owned Chrome did not publish its
local endpoint within 15 seconds and is still running."** A quiet launch on that runner takes about
1.0 s, and the same launch under the suite's own concurrency missed a flat 15 s budget.
`endpointWaitMs()` now scales with the core count the way `src/service.ts` already scales the budget:
a 24 thread host keeps exactly the old 15 s, a three core host gets 20 s, capped at 45 s so a browser
that is genuinely wedged still fails while somebody is watching.

### What the remaining timeouts are, and are not

Runs 7 to 9 failed 0, 1 and 3 times, and never the same test twice: `browser scrolling works`, `the
rail is the only session list`, `a tab that closes itself`, `an unbounded session is left exactly as
it was`. All drive real browsers on a three core machine that also runs the broker, the viewer and
several Chrome trees at once.

The honest statement is that **the cause is not established**. The shape is consistent with
contention rather than with a defect, because the set is unstable across identical code and every one
is a clock expiring rather than a wrong value. That is a hypothesis with evidence behind it, not a
conclusion, and it is the reason this row is not written as "known flaky" and closed.

What it does mean for a person: on a machine with two or three cores, expect a small number of
browser tests to time out under the suite's own load. On the measured Fedora workstation the same
suite runs 305 pass, 0 fail.

### The measurement that was designed to prove me wrong, and did

Before any of that, the hypothesis was that the background class itself was starving sessions.
`experiments/macos-qos-cost.ts` was written to answer that with a number, timing the same work in
both arms, alternating per round. Two runs on the three core runner:

| Run | median inside the class | median outside | ratio |
|---|---|---|---|
| 5 | 1215 ms | 2032 ms | 0.60 |
| 6 | 1760 ms | 1769 ms | 0.99 |

The hypothesis was wrong both times: the class is not what makes sessions miss deadlines, and the
experiment said so in its own verdict line. The two ratios also disagree by a lot, which is the
honest reason this document never claimed the 0.60 meant the efficiency cluster is faster. Three
rounds on a shared runner does not establish why a ratio sits below 1.0. **What both runs establish
is the only thing that was claimed: the class was not the bottleneck.**

### What is still not measured

- **The no prompt guarantee on a person's Mac.** A runner's Keychain and TCC state are not a
  person's. The flags are correct by vendor source; that no dialog appears on a real account with a
  real Chrome history has not been observed. This is the one row a person's machine closes and a
  runner never can.
- **The second containment layer's happy path.** Implemented, unit tested for its refusals, and
  unproven end to end, because the browser tree does not survive its supervisor on this host and so
  no orphan is ever produced to sweep. See section 2.
- **The cause of the browser driven timeouts.** The correlation with suite time is strong, runs 11
  and 12 being the clearest case, but correlation on two points is a hypothesis.

Run 12 re-measured the two things that matter most, and both held: a supervisor SIGKILLed with 10
Chrome processes under it left **0 survivors**, and a bare `bun test` still exited 1 with
`RESOURCE_LIMIT_REQUIRED`.

86 skips is the honest half of the pass count. Most are the private display, the systemd units,
D-Bus, the keyring and btrfs snapshots: Linux capabilities that are refused here rather than broken.
One of them, the supervised file lease suite, was marked Linux only in run 4 because its subject is
the Python subreaper and a POSIX `flock` helper, neither of which the darwin supervisor has.

## 8. What an adversarial audit found

An audit agent was pointed at the macOS adapter with instructions to attack it rather than read it.
It wrote live exploit probes, and eight landed. They are listed separately from section 4 because
they are a different kind of finding: section 4 is a machine refusing to behave as assumed, this is
code that behaved exactly as written and was written wrong.

| Severity | Defect | Why it mattered |
|---|---|---|
| High | The second containment layer was documented in three comments and had **no implementation**: `signalOwnedProcessGroup` had zero callers | A SIGKILLed supervisor orphaned its browser tree permanently, and `cleanWorkspaces()` then deleted the profile directory out from under the browser still running from it |
| High | `processGroupMembers` returned the same value for "empty" and "the kernel declined to answer" | Every caller reads empty as success. The supervisor tests membership before escalating, so **no SIGKILL was ever sent to a tree that had ignored SIGTERM**, and the budget registry reaped live registrations on the same confusion |
| High | `ORBIT_BUDGET_ROOT` was taken verbatim: no absoluteness, `lstat`, owner or mode check | The budget gate passes for any process whose group is listed there, so the whole gate was forgeable by anything that could set the variable or pre-create the path |
| Medium | `pbi_flags` was read at offset 16, which is `pbi_ppid` | It tested bit 0x8000 of the PARENT PID: a coin flip on machine load. A false positive skips the background class, dropping the only enforced half of the macOS budget |
| Medium | A null `leaderStartedAtMs` silently DISABLED the process group reuse check | The one case where ownership cannot be proved was the case where nothing was verified |
| Medium | The viewer opened in the person's own browser **on every Mac** | `listHostBrowsers` scans `.desktop` files, which macOS does not have, so it returned nothing and `openViewer` fell through to `open`. LaunchServices then handed the viewer's access token to the browser the person was already using, in their real profile |
| Medium | `cpuNs` was mach absolute time units, not nanoseconds | About 24x low on Apple silicon. Gates nothing today, so it was renamed rather than converted with an unmeasured timebase |
| Low | `killpg` to one's own group re-entered its own SIGTERM handler | Finite only because signals are not queued during handler execution, which is a delivery coincidence rather than a design |

**One reported defect was not one.** The audit said plist injection succeeded. Five payloads were
tried against the real `brokerAgentPlist`, including one adding `AbandonProcessGroup`, the key whose
absence makes `launchctl bootout` sweep the job's group, and all five were escaped. The audit's own
detector had matched the legitimate `KeepAlive` block that every plist carries. The regression test
that now guards this asserts STRUCTURE, the exact key list and a three element argv, rather than
grepping for dangerous words, and was shown to FAIL against a deliberately broken escaper before
being trusted.

**One was correct and deliberately not fixed.** A TOCTOU window exists in `groupIsStillOurs` between
the check and the signal. Closing it properly needs a kernel handle to a process group, which macOS
does not give unprivileged code, so it is documented here rather than engineered around. The window
is bounded by the two facts already checked, the leader's start time and its executable path.
