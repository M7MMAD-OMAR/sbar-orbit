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

The tooling is `.github/workflows/platform-probes.yml` (`verify-macos`) and
`experiments/macos-reaping.ts`. The adapter this shaped is `src/macos.ts`, `src/macos-budget.ts`,
`src/macos-autostart.ts` and `src/native/supervise-darwin.ts`.

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

**Ten processes, the supervisor killed outright, zero survivors after 105 ms.** For comparison the
Windows guest measured 12 processes and 0 survivors after 236 ms, and the mechanisms are different:
there the kernel does it, here a supervisor does.

What this does NOT show, and must not be read as showing: the supervisor itself was alive to run the
sweep. A supervisor that is SIGKILLed runs nothing, and the second layer, the broker's own sweep on
start, is not exercised by this experiment. Two best effort layers are not one kernel guarantee.

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

Nine of these came out of the first run. They are listed because a port's value is largely in what
running it turned up.

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
| 5 | `3135b16`, after the scheduling class fix | 237 | **0** | 86 | **190 s** |
| 6 | `3135b16`, the same commit re-run | 236 | 1 | 86 | 185 s |

Runs 1 and 2 are the same code and disagree by two. Runs 5 and 6 are the same code and disagree by
one. That pattern is the most useful thing in the table and it cuts both ways: it is why the five
timeouts were not all blamed on one cause, and it is why **run 5's zero is not treated as proof.**

### The defect the timeouts were mostly hiding

The darwin-background scheduling class is **inherited**, and Orbit was applying it twice: once to the
whole command in `scripts/limited.ts`, and again per browser in `launchOnDarwin`. The second
application spawned a `taskpolicy` process per session and changed nothing, because the browser had
already inherited the class from the broker that started it.

`inheritedBackgroundClass()` now asks the kernel, reading `PROC_FLAG_DARWINBG` out of
`proc_bsdinfo`. The suite went from 5 failures in 334 seconds to 0 in 190, a 1.76x speedup, and four
of the five timeouts went with it.

### The one that was left, and what it actually said

Run 6 failed once, and the message was specific rather than a bare timeout: **"Owned Chrome did not
publish its local endpoint within 15 seconds and is still running."** That is a real deadline, not
mystery flakiness. A quiet launch on that runner takes about 1.0 s; the same launch under the suite's
own concurrency missed a flat 15 s budget.

The deadline was fixed rather than the test retried. `endpointWaitMs()` now scales with the core
count the way `src/service.ts` already scales the budget: a 24 thread host keeps exactly the old
15 s, a three core host gets 20 s, and it tops out at 45 s so a browser that is genuinely wedged
still fails while somebody is watching. The two CDP deadlines further along already allowed 20 s
each, so the most expensive step in the sequence had been the one with the tightest budget.

Writing the test for that rule found a second defect before it shipped: `Math.max(1, NaN)` is NaN,
not 1, so a platform reporting a non number would have produced a NaN deadline, and `Date.now() +
NaN` is NaN, which no comparison is ever true against. The launch loop would have exited on its first
pass and reported every browser as never having started.

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
  real Chrome history has not been observed.
- **The broker's own start-up sweep.** The reaping experiment kills the supervisor, not the
  supervisor and the broker together, so the second containment layer is unexercised.
- **A repeated green run after the deadline fix.** Runs 5 and 6 bracket the fix, not follow it.

86 skips is the honest half of the pass count. Most are the private display, the systemd units,
D-Bus, the keyring and btrfs snapshots: Linux capabilities that are refused here rather than broken.
One of them, the supervised file lease suite, was marked Linux only in run 4 because its subject is
the Python subreaper and a POSIX `flock` helper, neither of which the darwin supervisor has.
