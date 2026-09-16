# Windows, measured on a live guest

> How to read this: every number here was produced on a Windows 11 25H2 guest running under
> libvirt on the owner's workstation, on 16 September 2026, driven entirely through
> qemu-guest-agent with no screen, no network into the guest and no RDP. That is a real Windows
> kernel with a real Chromium family browser, so these rows are `Limited` rather than `Reasoned`:
> one guest, one browser, virtual hardware. They are not `Measured`, which this project reserves
> for a host class the suite has run on.

The raw numbers are in `docs/evidence/windows-vm-2026-09-16.json`, which is untracked by this
project's convention that raw reports are attached to a release rather than committed. Every figure
below is also stated here, so this document stands on its own.
The tooling that produced them is in `experiments/windows-vm/`, and the containment layer the
findings shaped is `src/windows-job.ts`.

This document records what changed in [the porting plan](porting.md) because a live host answered.
Three of its findings were not in that plan at all, and one of them invalidates a section of it.

## 1. The finding that has no entry in the porting plan: session 0

**A Chromium family browser will not run in Windows session 0.**

qemu-guest-agent executes as `NT AUTHORITY\SYSTEM` in session 0. Launched there, Edge 151 exits
immediately, leaves nothing in the profile but a `Crashpad` directory, and never writes
`DevToolsActivePort`. `--headless` does not help. `--no-sandbox` does not help. Both arms were run.

The same binary, the same arguments, handed to the interactive session through a scheduled task with
`/RU <user> /IT`, answered CDP on the first attempt: `Edg/151.0.4129.72`,
`HeadlessChrome/151.0.0.0`, twelve `msedge.exe`.

| | session 0, as SYSTEM | session 1, as the person |
|---|---|---|
| `--headless` | exited, no port | CDP answered |
| `--headless --no-sandbox` | exited, no port | not needed |

**What this costs the design.** The porting plan's Windows section describes a broker and says
nothing about which session it lives in. It cannot be a Windows service. It has to run inside the
logged in user's session, which means:

- There is no Windows analogue of `loginctl enable-linger`. No logged in user, no Orbit.
- Autostart is a per user mechanism, Run key or a logon scheduled task, not a service.
- The broker dying with the session log off is correct behaviour, not a bug to work around.

Nothing about this is exotic; it is simply the fact a documentation-only port could not see, because
Microsoft documents session 0 isolation for services and says nothing about Chromium.

## 2. The finding that invalidates a section: the transport does not need a rewrite

The porting plan, section 5, says the Windows RPC layer is a rework rather than a branch, because
`Bun.serve({unix})` cannot serve a pipe name and the broker must therefore move to `node:net` plus
explicit framing. G15 measured the pipe half on a GitHub runner and confirmed it.

Both halves were re-measured here, and the second half changes the answer:

| Call | Result on Bun 1.4.2, Windows 11 |
|---|---|
| `Bun.serve({ unix: "\\\\.\\pipe\\name" })` | refused, `ENOENT`. Bun issue 15350 still reproduces |
| `Bun.serve({ unix: "C:\\...\\broker.sock" })` | **served.** A POST through `fetch(..., {unix})` returned the handler's body |
| `node:net` on a pipe name, 32 bit length prefix | round trip completed |

`Bun.serve({unix})` on a Windows **filesystem path** is the same call `src/ipc.ts` makes today.
Windows has had AF_UNIX on a filesystem path since 1803. The transport ports as it stands. What
needs a Windows answer is not the serving, it is the two things the socket file brings with it.

### What the socket file's ACL actually is

Measured under `%LOCALAPPDATA%`, which is where a Windows broker's socket would live:

```
inherited: O:<user>G:<user>D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;<user>)
tightened: O:<user>G:<user>D:PAI(A;OICI;FA;;;<user>)
```

Three inherited ACEs: SYSTEM, `BUILTIN\Administrators`, and the owning user. **No Everyone, no
Anonymous.** Narrowing it to a single user ACE was done from Bun with `Set-Acl` and no native code,
and the server kept serving across the change.

Compare the named pipe the plan chose instead, whose documented default SD grants read to Everyone
and to the anonymous account, and which libuv creates with a NULL security attribute and offers no
way to change. On the evidence, **the AF_UNIX socket is the better default and the reachable one**,
and the pipe's one advantage is the one thing the socket cannot do at all.

### What the socket still cannot do

Windows AF_UNIX carries no ancillary data, therefore no `SO_PEERCRED`, therefore no peer identity.
Microsoft's own position is that the filesystem ACL is the access control. So a Windows broker's
authentication is: the socket sits under a directory only the user may open, and nothing else. A
named pipe with `ImpersonateNamedPipeClient` is the only route to a kernel-provided peer identity,
and reaching it needs a process that owns the pipe handle, which is native code this repository
does not have.

**Verdict, changed from the plan: serve on AF_UNIX at a filesystem path under `%LOCALAPPDATA%`, with
an explicitly tightened DACL, and state plainly that peer identity is not verified. Revisit the pipe
only when a native component exists for another reason.**

### Two smaller things that will break a naive port

- `statSync` on the socket path throws `EACCES` while the server is listening. `claimSocket()` in
  `src/service.ts` decides a leftover path's fate with `stat().isSocket()`, and that test cannot be
  ported as written.
- Bun removes the socket file when the server stops, and rebinding over a leftover path succeeded.
  The stale socket doctor path is therefore less load bearing here than on macOS.

## 3. The containment layer works, with one race

`src/windows-job.ts` is the measured shape. Every claim in it has a number behind it.

| Property | Result |
|---|---|
| `SetInformationJobObject` with `KILL_ON_JOB_CLOSE`, `JOB_MEMORY` 2 GiB, `ACTIVE_PROCESS` 512 | accepted |
| Hard CPU cap, `CpuRate` 2500 = 25.00% of the machine | accepted, no DFSS refusal |
| Browser starts inside the job and CDP answers | yes |
| Survivors after closing the last job handle | **0**, three runs |
| Live memory | had to be summed per process: peak 302.6 MiB against a live 286.9 MiB |

### The assign race, stated honestly

`AssignProcessToJobObject` landed 76 ms after `CreateProcess` returned. In that window Chrome had
already started `--type=crashpad-handler`, and that handler was outside the job: 14 `msedge.exe` on
the machine, 13 in the job's PID list, one escaped.

A second run with and without `--disable-crashpad` leaked nothing in **either** arm. So the honest
statement is not "`--disable-crashpad` fixes it". It is:

> Spawn-then-assign leaves a window in which Chrome's own helpers escape the job, intermittently.
> It fired once and did not fire twice. The only spawn that removes the window is
> `PROC_THREAD_ATTRIBUTE_JOB_LIST` on `CreateProcessW`, which is native code this repository does
> not have. Until then, the job's process list must be walked on every budget sample, and a process
> outside it is `RESOURCE_BOUNDARY_LOST`.

`--disable-crashpad` is kept because a crash handler outside the budget is worth nothing to Orbit,
not because it is proven to close the race.

### Accounting, and the thing Windows will not give you

`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` gives CPU time, page faults and process counts. It does not
give current memory. `PeakJobMemoryUsed` is a high water mark, and there is no job information class
that reports current committed memory outside a limit violation notification. Measured side by side:
peak 302.6 MiB, live summed `PrivateMemorySize64` 286.9 MiB.

So `resourceStatus()` on Windows publishes a weaker contract than on Linux, and says so:
`{ cpuCycleSharePercent, commitLimitBytes, activeProcessLimit, swap: "not bounded" }`, with the
live memory figure summed per process rather than read from one counter.

One more thing the plan got right and is worth restating with the number under it: `CpuRate` is a
share of the **whole machine**, not of a core. On this 8 vCPU guest, 2500 is 25% of all eight.

## 4. G17 re-measured, and a first result withdrawn

G17 asks whether a 2 GiB commit ceiling and a hard CPU cap leave headless Chrome able to render.

The first run said capped 10272 ms against uncapped 1378 ms, a 7.5x gap, with byte identical output.
That looked like a real finding. It was not. Four cap settings, twice each, against the identical
render:

| Cap | Wall time, two runs | PNG |
|---|---|---|
| none | 1201, 1198 ms | 85947 bytes |
| 25% | 1522, 1361 ms | 85947 bytes |
| 50% | 1393, 1400 ms | 85947 bytes |
| 100% | 1513, 1285 ms | 85947 bytes |

No trend by cap. Both screenshots hash to
`dc476e12064ab16c62cada62c837c1cdd9b39dc638b14372d95ed74e13c31126`. The 10 second figure was a cold
start, and reporting it as a cap effect would have been exactly the failure this project's own rule
names: a measurement taken once, believed because it was dramatic.

**G17 on this guest: the cap does not distort the render and does not measurably slow it.** One
page, one size, one guest. A heavy page is still the next question.

## 5. What this does not say

- **No Chrome.** Only Edge is installed on this guest. Every browser result is Chromium family via
  Edge 151, and Chrome's App Paths key is absent rather than disproven. `msedge.exe` **is**
  registered under App Paths, which the research brief had listed as unconfirmed.
- **No hybrid cores.** Eight uniform vCPUs, so the P and E core question is untouched.
- **No real profile**, so nothing about App Bound Encryption was exercised.
- **No egress confinement**: G28's program scoped firewall rule was not re-run here.
- **No broker has ever started.** Section 6 records that the tree builds, typechecks and passes half
  its suite on the guest, but `serve` still refuses before it binds, because
  `requireResourceBudget()` reads a cgroup that does not exist there. No Orbit session has run on
  Windows. **Superseded by section 7**: the budget is now a named job object, the broker starts and
  answers `doctor`, and `launchChrome()` drives a headless browser end to end. A session created
  through the `session.create` RPC still does not complete.

## 6. The source tree on Windows, and what the suite says there

The sections above measured the primitives underneath the broker. This one runs the actual
repository. All 333 tracked files were pushed to the guest, unpacked, installed and tested.

### It builds

| Step | Result |
|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | exit 0, 100 packages, 36.9 s, Playwright present |
| `bun run typecheck` | **exit 0** |

The whole tree typechecks on Windows with no changes. That is a better starting point than the
porting plan assumed.

### The suite, before any portability work

`bun test` on the guest: **109 pass, 121 fail, 18 skip**, across 248 tests in 61 files, in 13.7 s.

Seventeen files were already clean, including `policy`, `extension`, `viewport`, `cpu-sample`,
`viewer-polling` and `native-renderer`. The failures were not spread evenly, and most of them were
not about Windows at all.

### What the failures actually were

The single largest cause was the **test harness**, not the product: 54 failures came from tests
calling `mkdtemp("/tmp/orbit-...")` directly rather than `mkdtemp(join(tmpdir(), ...))`. `/tmp` does
not exist on Windows, so those tests died before they exercised one line of Orbit. That is a harness
assumption masquerading as a portability finding, and it hid the real ones underneath it.

`scripts/portable-tmp.py` rewrote 51 call sites across 24 test files, adding the `tmpdir` and `join`
imports each file needed. `src/fedora.ts` was deliberately left alone: the private display is Linux
only and where it puts its runtime directory is a measured decision, not an accident.

### The one real product bug the guest exposed

`createWorkspaceDirectory()` refused on Windows with "Workspace storage must be a private directory
owned by this user". The check was:

```ts
info.uid !== process.getuid?.() || (info.mode & 0o077)
```

Neither half means anything on Windows. `process.getuid` is undefined there, and `mode` is
synthesised from the read only attribute rather than read from an ACL, so `mode & 0o077` tests
nothing and the comparison refuses every Windows host for a permission it does not have. The POSIX
half is now gated on the platform, and `workspaceRoot()` returns `%LOCALAPPDATA%\sbar-orbit\workspaces`
there, which is per user and non roaming so a multi gigabyte profile is never synced to a domain
share.

Verified on the guest after the fix:

```
root:    %LOCALAPPDATA%\sbar-orbit\workspaces
created: %LOCALAPPDATA%\sbar-orbit\workspaces\winprobe-1uMRtq
OK
```

The account name is substituted above, the way `doctor --report` substitutes it, because a profile
directory basename can be a person's name.

### The suite after both fixes

**123 pass, 107 fail, 18 skip.** Hardcoded `/tmp` failures: **0**. The Linux suite is unchanged at
248 pass, 0 fail, so nothing was traded away for it. (These counts are as of this section.
**Re-measured at HEAD in section 9: 151 pass, 88 fail.**)

What is left is no longer noise. Every remaining cause is a real platform question:

| Cause | Count | What it means |
|---|---|---|
| `RESOURCE_LIMIT_REQUIRED` | 24 | `requireResourceBudget()` reads a cgroup. Windows has a job object instead, which `src/windows-job.ts` now wraps, and the two have to be joined |
| `uv_spawn '/usr/bin/python3'` | 15 | `supervise.py`, `one_secret.py` and the settings helper. The supervisor is replaced by `KILL_ON_JOB_CLOSE` on Windows, and the other two are Linux only features |
| `EPERM: symlink` | 21 | Creating a symlink on Windows needs Developer Mode or elevation. `src/update.ts` versions and `bin/sbar-orbit` both use them, and a junction or a copy is the Windows answer |
| `uv_spawn '/usr/bin/systemctl'`, `findmnt` | 4 | systemd and filesystem probes, Linux only by definition |

That is the honest state: the tree builds and typechecks on Windows, half the suite passes, and the
remaining half is a list of four named jobs rather than an unknown.

### The broker now starts, measured the same day

The sentence that stood here said no broker had been started on the guest, because
`requireResourceBudget()` read a cgroup and refused before `serve` could bind. That is no longer
true. `requireResourceBudget()` branches on the platform instead of being removed, so Linux still
refuses anything outside its slice, and Windows joins the named job object that
`src/windows-job.ts` wraps.

Run on the guest on 16 September 2026, in the interactive session, against the same tree:

| What was asked | What happened |
|---|---|
| `requireResourceBudget()` | passed, `enforcement: "job-object"`, 2 GiB commit ceiling, 1536 active processes, `unbounded: ["swap", "threads"]` |
| `budgetHeadroom()` | 1 of 1536 tasks used, 82.1 MiB of the 2 GiB peak, read from the job rather than from what the broker believes it started |
| `startBroker()` | **bound**, at `%LOCALAPPDATA%\Temp\orbit-broker-<random>\broker.sock`, an AF_UNIX socket on a Windows filesystem path |
| `doctor` over that socket | answered, `platform: "win32"`, `backend: "browser"`, `sessions: 0`, with the job object's counters in `resources` |
| `session.create` with `backend: "browser"` | refused, `Owned Chrome launcher currently requires Linux with Chrome or Chromium` |

So the first Orbit broker on Windows exists and serves. The request travelled through the socket,
the session dispatcher, the budget and the headroom check, and stopped at the one place left:
`launchChrome()` in `src/chrome.ts`, which is Linux only by an explicit test on the platform and by
what it spawns, `native/supervise.py`, plus a DBUS suppression with no Windows analogue.
`windowsChromeArguments()` in `src/windows-job.ts` is where the replacement starts.

`cpuCores: 2` in those limits is computed by `src/service.ts` from the guest's 8 vCPU, and on
Windows it is advisory: the CPU share is set per session rather than on the shared pool, so nothing
capped this broker.

This is `Limited`, not `Measured`. One guest, virtual hardware, Edge only, no person at it. Three
things named earlier in this document are still exactly as they were:

- `serve --managed-socket` has never run. `serviceSocketPath()` throws `CONFIG_REQUIRED` without
  `XDG_RUNTIME_DIR`, which does not exist on Windows, so a managed broker there needs a socket path
  of its own. The unmanaged path above is the one that ran.
- The other three suite failure causes are untouched: the `/usr/bin/python3` helpers, `EPERM` on
  `symlink`, and the systemd probes.
- No browser session has run on Windows, and no page has been rendered through a broker there.

The Linux gate was re-run against the same tree before and after this, `bun run verify`: 249 pass,
14 skip, 0 fail. Nothing was traded away for the Windows branch, and nothing in that suite exercises
it either, because there is no Windows CI here.

## 7. The broker runs, and so does a browser

Section 6 ended with `serve` refusing before it could bind, because `requireResourceBudget()` reads a
cgroup. That is now joined to a job object, and both halves were run on the guest.

### The shared budget, as a named job object

Linux's budget is one cgroup slice every Orbit process on the machine lives in. An unnamed job object
cannot express that: a second process has no way to refer to it. A NAMED one can, and this was the
thing to measure before writing any of it.

Measured: a second Bun process holding only the name `Local\sbar-orbit-budget` opened the same job,
read back its ceilings (1536 processes, 2048 MiB), assigned itself, and the pool then counted both
processes. That is the same shape as the slice, so `src/windows-job.ts` grew `joinSharedBudget()` and
`sharedBudgetUsage()`, and `requireResourceBudget()` calls them on win32.

What it returns on the guest:

```
enforcement: "job-object"
cpuCores: 2, memoryBytes: 2147483648, tasks: 1536
unbounded: ["swap", "threads"]
```

The contract now carries `enforcement` and `unbounded` on every platform, because Linux and Windows
do not promise the same thing and printing a Windows number in a Linux shape is how a weaker
guarantee gets read as the stronger one. Three differences, each stated rather than smoothed over:

- **No swap bound.** Windows has no per job swap limit at all.
- **`tasks` is a PROCESS ceiling**, not a thread ceiling. Job objects do not cap threads, so the
  field means something different here and says so.
- **No `KILL_ON_JOB_CLOSE` on the shared pool.** A budget must outlive whoever declared it. A per
  session job still sets it, which is what actually reaps a browser tree.

### A latent FFI bug the guest found

`AssignProcessToJobObject` kept returning error 6, `ERROR_INVALID_HANDLE`, for a process assigning
itself. The cause was not Windows: `GetCurrentProcess()` returns the pseudo handle `(HANDLE)-1`,
which arrives through bun:ffi as `18446744073709552000` rather than `2^64-1`, because that value has
no exact double. The corrupted handle then fails in the kernel.

`asHandle()` now refuses any handle that would not fit a safe integer instead of passing it on, and
nothing in the file uses a pseudo handle: `OpenProcess` on our own pid returns a small integer that
round trips cleanly. With that, self assignment succeeded and the pool counted both processes.

This would have been invisible without a real Windows host. Every earlier measurement went through
C# and PowerShell; the shipped code is bun:ffi, and an FFI binding that has never run is a guess.

### The broker started

`startBroker()` on the guest bound an AF_UNIX socket under `%LOCALAPPDATA%\Temp`, answered `doctor`
over it with its full capability list, and stopped cleanly. That is the first time an Orbit broker
has run on Windows.

### A browser session launched

`launchChrome()` was split into a platform owned process without changing the Linux path: Linux keeps
the Python subreaper and the `/proc/<pid>/cgroup` comparison, Windows gets a per session job object
whose `close()` is the kill and whose `assertContained()` walks the job's live process list rather
than trusting one check at launch.

Every stage was measured separately so a failure could be attributed, and all of them passed:

| Stage | Result on the guest |
|---|---|
| Browser discovery | found Edge through the install roots |
| Launch | correct argv, no `--no-sandbox`, no `--password-store`, `--disable-crashpad` present |
| `DevToolsActivePort` | published |
| `http://127.0.0.1:<port>/json/version` | 200 |
| Raw WebSocket to the endpoint | open |
| Playwright `connectOverCDP` | connected, 1 context |
| `launchChrome()` itself | returned, navigated, read a title, closed |

The Windows command line deliberately drops three Linux switches: `--no-sandbox` is a Linux
workaround and dropping the sandbox on Windows is a straight regression, `--password-store` selects a
Linux keyring backend that does not exist there, and `--disable-dev-shm-usage` is about `/dev/shm`.

### A whole session, through the broker's own RPC

The session that would not complete was a fault in the probe, not in Orbit, and saying so matters
because the opposite conclusion was the tempting one. Two probe bugs hid a working system:

- The probe sent `id`. The API takes `sessionId`, so every call after create was correctly refused
  with `INVALID_REQUEST`.
- It then sent `session.act` with no `requestId`. That field is not optional: it is how a retried
  action is kept from running twice.

With both fixed, one more refusal came back, and it was Orbit enforcing its own contract rather than
Windows failing: `file://` is rejected, because only HTTP and HTTPS navigation is supported. Serving
the fixture over loopback is what a real session does anyway.

Every call then succeeded on the guest:

| Call | Result |
|---|---|
| `doctor` | ok, 20ms |
| `session.create` (backend `browser`) | ok, 1610ms |
| `session.act` navigate | ok, 747ms |
| `session.act` read `#h` | ok, `{"text":"through the broker"}` |
| `session.observe` | ok, a 16228 character frame |
| `session.stop` | ok, 215ms |

The observed frame was carried back off the guest and decoded on the host: a 1280x800 baseline JPEG
showing the fixture's heading and paragraph. The browser really rendered, and Orbit really captured
it. **An Orbit browser session works on Windows, end to end, through the same RPC an agent uses.**

### The frame's shape, which was not a defect

`session.observe` was reported here as returning `title: undefined` and no tab count. It does not.
The frame is `{ mimeType, image, capturedAt, width, height, presence }` and the title, the location,
the page count and the tab list are all inside `presence`, which is where `session.presence` reads
them from too. A probe looking for them at the top level finds nothing. Nothing was chased and
nothing was changed; the earlier note was reading the wrong level.

## 8. Every action, and one failure in about ninety sessions

Section 7 ran one session through the RPC. This ran the whole surface, repeatedly, because a single
green pass is not evidence about a system that had just been described as hanging.

### The whole action surface

One session, driven entirely through the broker's RPC against a fixture served over loopback from the
probe's own process, so nothing here depends on the guest reaching the internet:

| Call | Result on the guest |
|---|---|
| `session.create` | running, in 1.6 to 3.2 s |
| `navigate`, `read`, `fill`, `click`, `scroll` | each ok, 17 to 290 ms |
| `open-tab`, then `session.presence` | two tabs, the second active, title and location correct |
| `select-tab`, `close-tab`, `resize` | ok, and the surface came back 1024x768 |
| `session.observe` | an 11.8 KB JPEG, with `presence` inside the frame |
| `session.journal` | 10 entries, `tainted: true`, which a read is supposed to set |
| `session.pause`, `session.resume`, `session.stop` | ok, and `session.list` then showed `closed` |

A whole session costs 2.2 to 5.3 s on the guest, wall clock, including the browser launch.

### Five failures in about a hundred sessions, and what they were

**Five sessions of roughly a hundred failed.** They are recorded here rather than averaged away,
because the number is the useful part and so is the shape.

| What was reported | Count | What it was |
|---|---|---|
| `Target page, context or browser has been closed` | 3 | the browser died, at `connectOverCDP`, inside a `goto`, and at an `open-tab`. Unattributed |
| `Browser operation timed out` after 5310 ms | 1 | the context's own 5 s locator timeout. Contention, not a missing element |
| `did not publish its local endpoint` after 15.7 s | 1 | the browser never came up inside the launch deadline |

Every one of them came from the same harness shape: one guest process per session, started by a
scheduled task, back to back, so the previous run's browser tree was still being reaped while the
next one launched, on 2 vCPU. The two timeouts are that contention stated plainly. The three closed
browsers are not explained.

What is known about those three, and it is less than a cause:

- It is not the browser or the containment. The identical workload run directly against
  `launchChrome()`, one layer below the broker, passed **34 of 34** times.
- It is not the shared budget. The named job object's peak sat at 1489 MB of its 2048 MB ceiling and
  did not move across runs, and a browser tree is charged to its own per session job, not to that pool.
- Neither 40 sessions inside one broker nor 12 cold brokers inside one process produced any failure
  at all.

### The bug the failures exposed, which was not about Windows

The launch timeout printed this:

```
Owned Chrome exited with code () => child.exitCode before publishing its endpoint
```

`exitCode` is a function on that interface. Comparing the function to `null` is always false, so the
branch that says "did not publish, still running" was unreachable, and interpolating the function
printed its source. Every launch timeout on **every** platform has been reporting a function body as
an exit code. It is read once and used now, and the still running case says how long it waited.

The rest of what changed is attribution, not behaviour. Playwright's own message names no cause, so
`launchChrome()` wraps the handshake failure with the browser's exit code and its last stderr lines,
reads the job object's own counters into that line when the kernel was what reaped the tree, and
writes one record to the broker's journal at the moment an owned browser exits while its session is
still open.

### The launcher, so Orbit can be started at all

`bin/sbar-orbit` is a bash script, so until now there was no way to START Orbit on Windows: the
broker was reachable only by importing `startBroker` from another Bun process. `bin/sbar-orbit.cmd`
is the same dispatcher for `cmd.exe`. It resolves Bun by location rather than from the caller's PATH,
for the reason the bash launcher already gives, and it refuses by name the subcommands that cannot
work here rather than letting them fail further down: `install` and `update` because they link
versions with symlinks, which need Developer Mode or elevation; `service` and `autostart` because a
browser does not run in session 0 and there is no analogue of `loginctl enable-linger`; `panel`,
`settings` and `config` because they are GTK and Python.

`serviceSocketPath()` used to throw `CONFIG_REQUIRED` on Windows, because it wanted `XDG_RUNTIME_DIR`.
The managed socket now goes to `%LOCALAPPDATA%\sbar-orbit\broker.sock`, the same per user,
non roaming root `workspaceRoot()` already uses. One difference is stated rather than hidden: a
runtime directory is cleared at logout and `%LOCALAPPDATA%` is not, so a socket file can outlive the
broker that bound it, which is what `claimSocket()` already probes for.

### Two things `doctor` was saying that were not true

On a guest where Edge launched, answered CDP and rendered a page, `doctor --report` said
`browserBackendSupported: false` and `browsers: []`. That is the one line a person on a fresh Windows
machine reads to decide whether Orbit can work at all, and it said no.

The cause was two resolvers for one question: `chrome.ts` probed the install roots and the registry,
and `platform.ts` returned `[]` for anything that was not Linux. There is one resolver now,
`windowsBrowserInstalls()` in `runtime-paths.ts`, which is where it belongs rather than in the
launcher, because `doctor` must answer without loading a browser automation library.

Reporting the installs correctly made a second thing necessary. `canCloneProfile()` had been refusing
on Windows for the wrong reason: the install list was empty, so the lookup failed. Starting a session
from the person's own profile is refused on Windows as a platform now, with the reason
`docs/support-tiers.md` already carries, because App Bound Encryption returns
`kNotUsingDefaultUserDataDir` for any non default user data directory and returns before the policy
branch. A clone would open signed out, which is worse than a refusal because it looks like it worked.

### An agent host drove it, through the launcher

The last thing to check was the shape a person actually gets: not a probe importing `startBroker`,
but the commands and the connector. Run on the guest, in the interactive session:

| Step | Result |
|---|---|
| `sbar-orbit.cmd serve --managed-socket` | bound `%LOCALAPPDATA%\sbar-orbit\broker.sock` |
| `sbar-orbit.cmd doctor` | answered, `browserBackendSupported: true`, Edge listed, job object limits |
| `sbar-orbit.cmd status` | `Orbit idle`, naming the managed socket |
| `sbar-orbit.cmd connector-config` | `{"command": "...\bin\sbar-orbit.cmd", "args": ["mcp"], "env": {"ORBIT_SOCKET": "...\broker.sock"}}` |
| `sbar-orbit.cmd doctor --report` | the capability report, with the home directory redacted to `~` |
| `cmd.exe /c sbar-orbit.cmd mcp` | initialize, 12 tools listed |
| `sbar-orbit.cmd mcp` spawned verbatim, no shell | initialize answered, so the configuration is startable as written by a host that spawns the way Bun does |
| `connector-config --no-launcher`, then that configuration spawned verbatim | emitted `bun.exe` plus `src\\mcp.ts`, and it answered initialize, so the escape hatch for a host that cannot spawn a `.cmd` is measured rather than assumed |
| `orbit_create`, `orbit_act` navigate, `orbit_act` read, `orbit_observe`, `orbit_status`, `orbit_stop` | every one `isError: false`, the read returned the fixture's heading, observe returned the title, location and tab list |

That is the whole path an agent host takes on Windows, with nothing imported by hand.

### What is still not done

The suite still reports 107 failures on the guest, against four named causes from section 6. The
first of those, the cgroup budget, is closed. The other three are not, and were not re-measured here:
the `/usr/bin/python3` helpers, `EPERM` on `symlink` in `src/update.ts` and `bin/sbar-orbit`, and the
systemd probes. (**Superseded by section 9**, which re-ran the suite: 151 pass, 88 fail, and the
symlink cause turned out to be a design that does not port rather than a call to swap.)

No installation has been run on Windows, and `install` refuses there by design until the symlink
question has an answer. The tier stays `Limited`: one guest, virtual hardware, Edge only, no person
at it, and one failure in about ninety sessions that nobody has attributed.

## 9. The suite re-measured, and the one design that does not port

Section 6 counted 107 failures on the guest. That number was quoted afterwards without being re-run,
which is exactly how a stale figure turns into a claim. It has now been re-measured at the current
HEAD, on the same guest.

| | Section 6 | Re-measured at HEAD |
|---|---|---|
| pass | 123 | **151** |
| fail | 107 | **88** |
| skip | 18 | 18 |

Nineteen failures closed, and the cause is named rather than guessed: `RESOURCE_LIMIT_REQUIRED`
appears **zero** times in the new log. Joining the budget to a job object closed that whole class.

The remaining 88 sort into three causes, counted by evidence lines in the log: symlinks (101 lines),
`/usr/bin/python3` helpers (46), and systemd or findmnt probes (20).

### Symlinks are not a call to swap, they are a design that does not port

The symlink group is the largest, and it is not a matter of substituting an API. `src/update.ts`
keeps versions side by side and repoints ONE symlink by rename, so that no reader ever sees the name
missing. That atomicity is the design, not an implementation detail.

Measured on the guest, unelevated, with Developer Mode **absent** (the registry value is not set):

| Operation | Windows guest | Linux host |
|---|---|---|
| `symlink(dir)` | **EPERM** | ok |
| `mklink /J` junction | ok, needs no elevation | n/a |
| read through the junction | ok | n/a |
| `rename` over a live junction | **EPERM** | ok (over a symlink) |
| `rename` over an empty plain directory | **EPERM** | **ok** |
| `rename` over an existing FILE | ok, 43.66ms | ok |

The last two rows are the finding. The EPERM is **not** about reparse points: renaming over a plain
empty directory fails the same way, and the same call succeeds on Linux. Windows does not replace a
directory by rename at all, so no amount of junction cleverness recovers the swap.

Two ways out were measured rather than argued about:

- **Delete then recreate the junction.** Works, exit 0, and the name is absent for **0.90ms**, with
  the whole operation taking 26.23ms. That window is small but it is real, and the Linux design
  exists precisely so that there is no window. It would be a weaker guarantee wearing the same name.
- **A pointer FILE naming the current version, swapped by rename.** Rename over an existing file is
  allowed on Windows, so this is atomic. It survived a reader that had already read, and it survived
  a reader holding the file **open** across the swap, which is the property the design actually
  depends on. It needs no link, no elevation and no Developer Mode.

So the portable shape is a pointer file, and the Windows port should not try to keep the symlink.

### The pointer file, implemented and run on the guest

`src/update.ts` now records the current version per platform. Linux keeps the symlink and its rename,
unchanged. Windows writes the target into `current.txt` and renames a temporary file over it, which is
the one atomic swap Windows offers.

Measured on the guest, unelevated, driving the shipped code:

| | Result |
|---|---|
| `activate 1.0.0` | activated, `current` reads `1.0.0` |
| pointer file / plain `current` directory | present / never created |
| `activate 2.0.0`, then `previous` | activated, rollback target recorded as `1.0.0` |
| swap while a reader held the pointer **open** | ok, and `current` then read `1.0.0` |
| `pruneVersions(root, 0)` | removed nothing, kept both, so the rollback target survived |
| `readlink(current)` | ENOENT, because no symlink was ever made |

### Two bugs a simulated platform could not have found

The Linux suite exercises this branch by overriding `process.platform`, which is worth having. It is
not the platform, and the guest proved it twice.

- **Every Windows activation refused.** `activateVersion()` tested for `bin/sbar-orbit` to decide
  whether a directory is a prepared version, and a Windows install's launcher is `bin\sbar-orbit.cmd`.
  A complete, correct version directory was rejected as "not a prepared version". The name now comes
  from `launcherName()`, and `prepareVersion()` uses the same one, so a version cannot be prepared by
  one check and refused by the other.
- **The test agreed with itself.** Its fixture wrote `bin/sbar-orbit` regardless of platform, so the
  simulated Windows run passed against a file a real Windows install would never have. The fixture is
  now built inside the platform override and uses `launcherName()`.

Two more Windows-only details were fixed with it, both of which would have silently disabled updates:
`updateRoot()` returns `%LOCALAPPDATA%\sbar-orbit` rather than an `XDG_DATA_HOME` path that does not
exist there, and `updatableInstall()` compares with the platform separator, because `realpath` returns
backslashes on Windows and a POSIX prefix test would call every managed install unmanaged. The
`previous` pointer is also split on both separators, since a POSIX-only split left the rollback target
unprotected and a prune would have deleted it.

The remaining `update.test.ts` failures on the guest are harness, not product: the fixtures build
source checkouts with `symlink()` and feed tarballs carrying the bash launcher. The one test that
asserts a symlink exists is now skipped on Windows rather than left to fail, so a Windows run reports
it as not applicable instead of as a pass it never earned.

### What this section does not claim

The 88 remaining failures were counted and their causes tallied from log evidence, not individually
diagnosed. The python3 and systemd groups have not been probed on the guest at all, so nothing is
claimed about how hard they are. No fix was made here: this section moved a number from stale to
measured, and turned one unknown into a named design decision.

## 10. The one command install, run on the guest

`install` had never run on Windows. It refused there by name, pending the symlink answer, and that
answer now exists, so this is the command actually running.

### What it writes instead of a symlink

`activateLocal` writes a `.cmd` shim that forwards to the source launcher. The shim carries a marker
line, because the Linux path refuses to replace anything that is not a symlink pointing into a
recognised source, and a shim that could not be told from a person's own batch file would have traded
that safety away. Measured on the guest, 131 bytes:

```
@echo off
@rem sbar-orbit-managed-shim
@rem Target: C:\orbit\src\bin\sbar-orbit.cmd
@call "C:\orbit\src\bin\sbar-orbit.cmd" %*
```

### The run

| Step | Result on the guest |
|---|---|
| `install --dry-run --json` | `installed: true`, every step reporting what it would do |
| `install --json` | `installed: true`, launcher and connector written |
| prerequisites | `done`, 6 optional items missing, no blocking failure |
| installing twice | safe, no duplicate |
| a foreign `sbar-orbit.cmd` in the prefix | **refused**, and the file was left byte for byte intact |

Then the whole product, driven through the INSTALLED command rather than the source tree:

| Call | Result |
|---|---|
| `sbar-orbit.cmd serve --managed-socket` | bound `%LOCALAPPDATA%\sbar-orbit\broker.sock` |
| `sbar-orbit.cmd status` | real JSON, `Orbit idle`, naming that socket |
| `sbar-orbit.cmd session create browser` | `state: running` |
| `sbar-orbit.cmd session observe` | `image/jpeg, 1280x800` |
| `sbar-orbit.cmd session stop` | stopped |

### Three product bugs, each found by running it

- **The managed broker could not bind, and would not say why.** `claimSocket` treated every `stat`
  failure as "nothing is there". On Windows a socket file that IS there answers `stat` with EACCES
  while it is bound, so a leftover was left in place and the bind failed with
  `Failed to listen on unix socket` and no cause. Only ENOENT means absent now; anything else is
  probed. The `isSocket()` shape test is Linux only, because a Windows AF_UNIX socket file reports as
  a regular file. This is exactly the trap section 2 predicted, reaching the product this time.
- **The CLI threw away every error it did not recognise.** Any non `OrbitError` was reported as the
  bare string `Command failed`. That is what made the bind failure undiagnosable, and finding the
  cause needed the message back. It is kept and trimmed now, with `ORBIT_DEBUG=1` adding the stack.
- **`preflight` demanded systemd on a platform that has none.** The install failed at its first step
  for the absence of `systemctl`, `systemd-run`, `nice` and `python3`, none of which the Windows path
  calls, and it looked for a browser at Linux paths while `doctor` used the Windows resolver. The
  platform check now admits Windows at the Limited tier, skips the systemd group there, and uses the
  same browser resolver `doctor` does.

### What is not claimed

`install` ran with `--no-service` throughout. The service step refuses on Windows by design, because a
browser does not run in session 0, so nothing about autostart there has been measured. The prefix was
a throwaway directory, not a real one on PATH, and `prefix-not-on-path` was reported rather than
acted on, which is the same thing it does on Linux.

Two CLI papercuts were found and deliberately not fixed here, because they behave identically on
Linux and are not Windows work: `--version` is not a verb, and `session create browser --json` reads
`--json` as the account name, since positional parsing does not filter flags.

## 11. The suite triaged, and what a failure count was hiding

The guest suite's failure count was being read as the size of the remaining port. It was not. Most of
those tests are not shared code failing on Windows, they are tests of features this project has
already decided do not exist there, failing correctly and being counted as defects. A number made of
those hides the real ones underneath it.

| After | Failures | Skips |
|---|---|---|
| Before this session | 107 | 18 |
| The port's own work landing | 76 | 22 |
| Suites that name themselves Linux only | 48 | 60 |
| More gates, and two tests that were simply wrong | 39 | 69 |
| The resource contract per platform, and three more suites | **30** | **86** |

Every skip states its reason at the call site, and `tests/platform-support.ts` says in its own comment
that reaching for either gate to make a number smaller is how a portability defect gets buried. The
rule is narrow on purpose: use it only where the feature under test is one this project has already
decided does not exist on the other platform.

What is gated, and why it is not a port: the private display runtime and the compositor's IPC, the
panel broker and the settings schema, which are Python and GTK, the desktop theming, systemd
autostart and units, the profile clone, which `docs/support-tiers.md` records as `Refused` with a
primary source, the Python subreaper, which a job object replaces outright, the bash launcher, which
`bin/sbar-orbit.cmd` replaces, saved account leases, which `src/profiles.ts` already refuses off Linux
because they are held with `flock`, the person's own browsers, which are read from XDG desktop
entries, and the `/proc` cgroup audit of a browser tree.

Two gates are probes rather than platform checks, which matters. `needsSymlink` tries to make one: an
unelevated Windows process cannot, and dies building its fixture before reaching a line of product
code, while a Windows host with Developer Mode on runs those tests for real. `needsCommand` asks
whether the host has the binary: the guest has no `git`, and asking git what is tracked is the right
question and unanswerable there.

Three tests were wrong rather than Linux only, and are fixed rather than gated. `tests/theme.test.ts`
asserted a literal `/` against paths the product builds with `join`, so it tested the runner's
separator. `tests/service.test.ts` named no platform while `serviceSocketPath()` now answers
differently on Windows. `tests/resources.test.ts` asserted the Linux resource shape everywhere and
failed against a broker that was answering correctly; it pins each platform's own promise now, which
is what puts `enforcement`, `unbounded`, the peak rather than a current commit, and the null swap and
null events under test at all.

One test shelled out to `bash -c ls` to glob for a tarball. It reads the directory now.

### The registry package on Windows, and the one thing that does not work

`docs/packaging.md` documents `bun add -g sbar-orbit` as how a machine that is not a development
checkout gets Orbit. That path was measured on the guest on 16 September 2026, from a tarball built by
`bun pm pack` and installed into a throwaway `BUN_INSTALL` home, and it is half working:

| Step | Result |
|---|---|
| `bun add -g <tarball>` | **succeeded**, 95 packages, 64.8 s, with `os: ["linux"]` still in `package.json`. Bun did not enforce that field here |
| The shim it generated, `bin\sbar-orbit.exe` | **failed**: `interpreter executable "bash" not found in %PATH%` |
| `bin/sbar-orbit.cmd` inside the installed package | present, and CRLF, which is what `.gitattributes` now guarantees |
| That `.cmd`, run directly: `doctor --report` | exit 0 |
| That `.cmd`, run directly: `preflight` | exit 0 |

The cause is one line. `package.json` names `bin/sbar-orbit` as its `bin`, the shim generator reads
that file's `#!/usr/bin/env bash` shebang, and writes a Windows shim that calls `bash`. A package can
map one command name to one file, so the Windows launcher cannot simply be named beside it.

So `os` is left as `["linux"]` deliberately, and this is the reason rather than an oversight:
declaring Windows support would install a command that does not run, which is worse than a refusal
because it looks like it worked. The path that works today is the `.cmd` inside the installed package.
Making `bin` a launcher that starts on both platforms is the next named job for the registry path, and
it changes a measured Linux entry point, so it belongs in its own commit rather than this one.

### The thirty that are left

Eleven are in `src/install.ts`, `src/local-install.ts`, `src/update.ts` and `src/preflight.ts`, which
another session was working in while this was written, and which are deliberately untouched here.

The rest are real questions, none of them large, and none of them measured further: a broker socket
that answers `stat` with `EACCES` while bound, which `claimSocket()` already handles and two tests do
not expect; `uv_spawn` of a Linux helper in the agent contract and session suites; the source manifest
and workspace storage checking POSIX mode bits; and a browser crash case that counts processes the way
Linux counts them.

## 12. Re-measured after the fixes, and a safety property I had traded away

Section 11 triaged the count. This ran the suite again at HEAD afterwards, because the update
pointer, the preflight platform gate, `claimSocket` and the CLI error all changed it without being
re-run, and it re-reads the failures for product bugs rather than for a smaller number.

| | Section 9 | Section 11 | Now |
|---|---|---|---|
| pass | 151 | not stated | **158** |
| fail | 88 | 30 | **27** |
| skip | 18 | 86 | **87** |

### The safety property, which the suite caught and I had not

The commit before this made `claimSocket` skip its shape test on Windows, because a Windows AF_UNIX
socket file reports as a regular file and `isSocket()` is false for it. That was wrong in a way worth
recording rather than quietly correcting: the test exists to refuse a path that is NOT a socket, so
skipping it meant a file someone had left there would be **deleted instead of refused**. The guest
said so directly, with `claiming refuses to remove a path that is not a socket` failing.

The fix is not to drop the test but to ask something both platforms can answer: a socket file is
empty, and a config or a note is not. `existing.size === 0` on Windows, `isSocket()` on Linux. This
is the second time a Windows convenience branch in this file removed a guarantee instead of porting
it, and both times the suite on the guest is what noticed.

### Two product bugs and one assertion that had become false

- **`install` and `update` spawned a bare `bun`.** Both launchers resolve Bun by location precisely
  because a service or an agent host starts Orbit with its own PATH, and these two threw that away,
  failing with `Executable not found in $PATH` on the guest where Bun lives outside PATH. Both use
  `process.execPath` now, and so do the tests that spawn the CLI.
- **The platform probe test asserted Windows cannot run browser sessions.** It required
  `browserBackendSupported === false` for every non Linux platform. True when written, false now
  that sessions are measured running through the broker's own RPC. Windows asserts `true` there and
  still asserts `nativeDisplaySupported === false`, because the private display really is Linux only.
- **A POSIX path assertion ran on Windows.** `the managed socket path lives under the runtime
  directory` joins a POSIX runtime directory and compares POSIX separators, and `XDG_RUNTIME_DIR`
  does not exist on Windows at all. Skipped there, with the Windows branch pinned separately.

### What the remaining 27 are worth

Counted from the log by surrounding error text: 14 assertions, 4 ENOENT, 3 symlink EPERM in test
fixtures, 2 `/usr/bin/python3` helpers, 1 systemd probe, 1 remaining bare interpreter. That tally is
approximate, classified by pattern rather than diagnosed one at a time, and one failure often prints
several kinds of line. **No claim is made that what remains is only harness.** Three product bugs came
out of the last two passes over exactly this kind of list.

## 13. The remaining failures, diagnosed one at a time

Section 12 said the remaining 27 were classified by log pattern rather than diagnosed, and that no
claim was being made that they were only harness. This read every one of them.

| | Section 12 | Now |
|---|---|---|
| pass | 158 | **160** |
| fail | 27 | **21** |
| skip | 87 | **92** |

Nothing regressed: the failures that disappeared are a subset, with no new name in the list.

### One more product bug, in the policy layer

`parsePolicy` required an advisor command to start with `/`:

```ts
if (typeof first !== "string" || !first.startsWith("/"))
```

The rule it means is *absolute*, so the broker never resolves an advisor through PATH and lets
whatever the agent host exported decide which program approves an action. Written in POSIX terms it
rejected every valid Windows path, which made the advisor **impossible to configure on Windows at
all**: a policy feature silently unavailable rather than refused with a reason. It is `isAbsolute`
now, in the platform's own terms, and a UNC path is still refused because a policy should not consult
a program across the network.

### A check that had quietly become unmockable

The Windows browser probe I added in section 10 called `windowsBrowserInstalls()` for a yes or no,
which reads the real machine. `inspectPrerequisites` takes an injected probe precisely so a test can
describe a machine, and answering from the host ignored it. The resolver still names the candidates,
but each one is now asked through `probe.file`, so the seam works on both platforms.

### Where a skip was the honest answer, and what had to be written to earn it

`tests/local-install.test.ts` asserts `readlink` on the installed command and runs `#!/bin/sh`
launchers. Its subject is the POSIX symlink install, so it is `linuxOnlySuite` now. That is only
honest if what Windows does instead is tested rather than left as a hole, which is the exact trap
`tests/platform-support.ts` warns about, so a Windows case was written alongside: the shim is a
marker carrying file, it forwards with `%*`, no symlink is created, re-activating is idempotent, and
a foreign `sbar-orbit.cmd` is refused **and left intact** by both activate and deactivate. That last
one matters most: it is the check that protects a person's own command, and losing it in the port
would be worse than losing the shim.

`IPC socket is private` was split rather than skipped. Only its first line is POSIX, asserting mode
`0o600`; the rest is the real IPC contract and now runs on both.

### Two of my own fixes were incomplete, and the guest said so

`preflight` and `an install without a service` both still failed after the fixes above, one line
further on each time. The first because the test's mock stripped paths with a POSIX-only pattern that
matched nothing against Windows backslashes, so the fixture claimed a runtime it meant to remove. The
second because the installed command on Windows is a shim that forwards to the launcher rather than
being the launcher, so asserting the launcher's own text was wrong: the marker and the target are
what identify it.

### The 21 that remain

Individually read, they group as: 7 update and packaging tests whose fixtures build source trees with
`symlink()`, 4 advisor tests that spawn `/bin/sh` and `/bin/true`, 3 that spawn `/usr/bin/python3` or
`findmnt`, 2 asserting a POSIX file mode, 2 in workspace cleanup using `chmod` semantics Windows does
not have, 1 broker-death reaping test, and `the documented plan command` failing with `EFTYPE` on a
spawn. None of them is a Windows code path failing; all are fixtures written against POSIX. **That is
a statement about these 21 specifically, read one at a time, and not a general claim that what is left
is always harness.** Four product bugs have come out of three passes over this list.

## 14. The advisor, consulted on Windows

Section 13 changed `parsePolicy` so a Windows advisor path is accepted, and that was a type level
fix: nothing had ever consulted an advisor on Windows. A security relevant path enabled by reasoning
is not the same as one that works, so every branch of the contract was run against real programs on
the guest, written as `.cmd` files because that is what a Windows machine would configure.

| What was asked | Result on the guest |
|---|---|
| `parsePolicy` with `C:\...\allow.cmd` | accepted |
| `parsePolicy` with a relative path | refused, "must name an absolute local executable" |
| `parsePolicy` with `\\server\share\a.cmd` | **refused**, so a policy cannot consult a program across the network |
| an advisor answering `{"decision":"allow"}` | `allow` / `advisor-allowed`, 41ms |
| an advisor answering `{"decision":"deny"}` | `deny` / `advisor-denied`, 32ms |
| an advisor exiting non zero | `deny` / `advisor-failed`, 28ms |
| an advisor printing something that is not JSON | `deny` / `advisor-unparsable`, 57ms |
| an advisor that hangs, against a 1500ms clock | `deny` / `advisor-timeout` at **1517ms** |
| an advisor reading the record on stdin | yes |

Every failure mode is a deny, which is the property the design turns on, and the clock is real rather
than a safety net that has never fired. The UNC refusal was the part written from reasoning in the
previous commit; it is measured now.

The four advisor tests still failing on the guest are unaffected by this: they spawn `/bin/sh` and
`/bin/true`, which is a fixture written against POSIX, not the advisor path failing.

## 15. The guarantee the project exists for, measured through a real broker death

Of the 21 failures read in section 13, one was classified too quickly. `abrupt broker death reaps its
browser tree` was filed under "fixtures written against POSIX" because it walks `/proc`. That is true
of its enumeration and false of its subject: **an agent's browser must not outlive the broker that
owned it**, which is the whole reason this project exists. Job object reaping was measured in
isolation in section 3, and it had never been measured through a real broker death on Windows.

So it was, before touching the test. A broker in its own process, a real browser session, then
`taskkill /F`, which runs no cleanup handler: anything surviving would have survived because the
kernel did not reap it.

| | Result on the guest |
|---|---|
| browser processes with a live session | 12 |
| broker killed with | `taskkill /F`, no cleanup |
| survivors | **0, after 236ms** |
| `msedge` left on the machine | **0** |
| the dead broker's session, asked of a fresh broker | `SESSION_NOT_FOUND` |
| a new session on the fresh broker | `running`, observed `image/jpeg 1280x800` |

### The test made portable rather than skipped

Skipping this one to make a number smaller would have buried the most important guarantee in the
project, so `descendants()` learned Windows instead: `Win32_Process` and its `ParentProcessId` build
the same tree `/proc/<pid>/task/<tid>/children` does. One snapshot of the whole table is taken and
walked in memory, because asking per process races a browser tree that is still starting. The
liveness poll asks each kernel the way it answers, `/proc/<pid>/stat` or signal 0.

The suite then passed on the guest, on its own terms, in 2649ms, with zero browsers left behind. It
is the same assertion Linux runs, not a weaker Windows variant.

This is the difference between a count and a diagnosis. Read as a pattern it was one more POSIX
fixture; read properly it was the single property most worth measuring on a new platform.

## 16. Private files, asked of Windows instead of of a number

Two more of the 21 were filed in section 13 as "POSIX file modes": they assert `0o600` and receive
`438`. Read as a mechanism that is a mode test. Read as a subject it is **whether the files carrying a
person's data stay private**, and Windows ignores the `mode` argument to `mkdir` and `writeFile`
entirely, so the number the test wanted was never stored by the kernel. The assertion was standing in
for a property that had never been checked on Windows at all.

So the property was measured directly, through the real `Diagnostics` code writing a real journal.

| Question | Answer on the guest |
|---|---|
| ACL on `events.jsonl` | `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators`, the owning user, each FullControl |
| principals beyond those three | **none**: no Everyone, no ANONYMOUS LOGON, no `BUILTIN\Users` |

That is the same set the broker socket inherits in section 2, which is the answer that matters: a
second account on the machine cannot read an agent's diagnostics.

### What the same probe found about secrets

The probe also asked the question the mode assertion was sitting next to, since `exclude exception
secrets` is the name of that test: a failure carrying `password=hunter2`, a token and a cookie was
forced through, and **none of the three reached the journal**. The journal records the method, a trace
ID and a timestamp, and by design never the params, so there is no redaction pass to get wrong. The
exception text goes to the broker's stderr, which is the operator's own console and is deliberate.

One caution recorded rather than dressed up: an early reading of this probe looked like the product
had redacted a token, because the string appeared as `token=***` in my own captured output. That was
this agent's tooling masking a GitHub-shaped string in transit, not Orbit. Checked at the source,
`src/diagnostics.ts` has no redactor and needs none. A measurement that flatters the code is worth
re-reading before it is written down.

### The test made portable, with a negative control

`tests/private-path.ts` asks each kernel in its own terms: the mode on POSIX, the ACL on Windows. It
refuses to pass on an empty ACL read, because a probe that fails silently would turn this check into
decoration. The four suites then pass on the guest, 13 pass and 0 fail.

And the check was shown to catch something before it was trusted: a file granted `Everyone:(R)` with
`icacls` is **refused** by the same helper on the same machine. A privacy assertion that has never
rejected an exposed file has not been shown to guard anything.

## 17. The person's own browser, with a real one running

`AGENTS.md` names two guarantees. Section 15 measured the first, that an agent's browser does not
outlive its broker. This is the second: **agents do not touch the person's own browser, screen,
pointer or windows.** It had not been measured on Windows, and Windows carries a hazard Linux does
not.

A Chromium launch normally **hands off** to an already running instance of the same browser through
its singleton, and the launching process then exits. If that happened here, Orbit would be driving the
person's browser, with their profile, their cookies and their windows, while reporting a perfectly
healthy session. On Windows the person's Edge is running in nearly every real session, so this is the
ordinary case, not an edge case.

Measured with a real second browser running first: not headless, its own window, its own profile.

| Question | Answer on the guest |
|---|---|
| the person's browser before | 14 processes, window `about:blank - Profile 1 - Microsoft Edge` |
| Orbit got a browser of its own rather than handing off | **yes**, 12 processes in its own profile |
| Orbit reused one of the person's processes | **no** |
| Orbit's browser headless | yes |
| Orbit's browser names the person's profile | **no** |
| Orbit drove its own page while theirs ran | yes |
| Orbit's processes after `close()` | **0** |
| the person's processes at the end | **14 of 14**, window unchanged |

What prevents the handoff is `--user-data-dir`, because the singleton is per user data directory. That
is one argument carrying an entire guarantee, which is exactly the kind of thing that deserves a test
standing over it rather than a comment.

### The test, and the proof it catches something

`tests/person-browser.test.ts` runs on both platforms: it starts a second browser in a profile that is
not Orbit's, launches Orbit's own, and asserts the two are separate in every way a person would check.
A handoff is caught by the assertion that Orbit's own profile holds at least one process, since a
handoff returns a usable looking handle while leaving none.

It was shown to fail before it was trusted. Pointed at the other browser's profile, the way a handoff
would leave it, **the suite fails**. On Linux it passes in 1113ms.

### Two probe errors worth recording

The first run of this probe crashed: it called `launchChrome({ profile })` when the signature is
positional, `launchChrome(profile, size, options)`. The second run then answered `false` to every
question for the wrong reason, because `launchChrome` returns a Playwright handle rather than a pid
and every `launched.pid` was `undefined`. **A probe that reports `false` for a safety property is
indistinguishable from a real failure until it is read carefully**, and reading `orbit reused one of
the person's processes: no` as a pass would have been an accident. The questions were re-asked of the
process table by command line, which is what a person looking at their own machine would do.

## 18. The remaining failures, read one at a time again

Section 13 read 21 failures individually and found four product bugs. Sections 14 to 17 then measured
four guarantees that classification had hidden. This is the same exercise on what was left, and the
count moved **18 to 10**, 167 pass to **175 pass**, with no regressions.

| What failed | What it actually was |
|---|---|
| 4 advisor tests | **One helper**, writing every advisor as a `#!/bin/sh` script. Windows has no `/bin/sh`, so all four died as `advisor-unstartable`, which reads like the advisor path is broken when the fixture simply wrote a program the platform cannot run |
| `install ... writes connector configuration` | The test asserted the POSIX spelling `sbar-orbit/broker.sock`. Windows correctly writes `%LOCALAPPDATA%\sbar-orbit\broker.sock`, so the assertion was checking the separator rather than the property |
| `pruning keeps the current version` | `readlink` on `previous`, which is only half the answer: this platform records it in a **pointer file**, by the design in section 9 |
| 2 source checkout tests | The fixture built the installed launcher with `symlink`, which is EPERM unelevated and is not what Windows installs anyway: there it is a `.cmd` shim |
| `one workspace that will not go` | `chmod 0o500` to make a directory refuse removal. Windows ignores that mode, so the sweep deleted **both** workspaces and the test proved nothing before failing in its own cleanup |

### The advisor translator, and the one case it refuses

`advisorScript` now writes a `.cmd` on Windows, translating the handful of shell bodies these tests
use. It is deliberately a **small translator for known shapes rather than a general one**: a general
shell to cmd translation is a second implementation to get wrong, and a body it mistranslated would
produce a **passing test that proves nothing**. Anything unrecognised throws.

That refusal earned itself immediately. The first guest run after the change failed with
`advisorScript has no Windows form for: kill -9 $$`, which is precisely the design working: the case
was visible instead of silently mistranslated into something that passed.

`kill -9 $$` is an advisor killed mid answer. cmd cannot signal itself, so it is **substituted** with a
non zero exit and no verdict on stdout, which is the same end state from the broker's side. That is a
substitution rather than a translation, and it is written down here because the two are not the same
evidence.

### Two fixtures that were asserting nothing

The workspace sweep is the sharper one. On POSIX, `chmod 0o500` on the parent makes a record
unremovable, which is how the test creates a workspace that will not go. Windows ignores the mode
entirely, so the sweep removed both workspaces, `refused` was empty, and the test then **failed in its
own `finally`** on a path that no longer existed. A test that cannot create the condition it is testing
is not a weaker test, it is a test of nothing. On Windows the fixture now holds a **file open** inside
the directory, which really does block removal there.

### What is left, and what it is

Ten failures. Named rather than grouped: 3 need `git`, which is **not installed on this guest**, and
`winget` could not fetch it in this session; 2 need `/usr/bin/findmnt` and `/bin/sh`; 1 needs the
systemd slice; 1 is the `plan` command's documented report; and 3 are packaging tests that read an
archive built by the git-dependent path.

The git ones are an **environment gap, not a code defect**, and they are recorded as unmeasured rather
than as passing or as harness noise. `not measured` is not a pass.

## 19. git installed, and the packaging bug that was hiding behind its absence

Section 18 left six failures recorded as **not measured** because git is absent from the guest, and
said plainly that `not measured` is not a pass. That gap is now closed: `winget` hung again, and the
GitHub API is rate limited from both this host and the guest, so **MinGit** was fetched directly from
the release URL. It is the portable Git for Windows build: a zip, no installer, no elevation.

```
git version 2.51.0.windows.1
```

Running the suite again moved it to 178 pass, and then two things appeared that the absence had been
hiding.

### A gate that checked for the binary while the test needed the repository

`the registry tarball carries tracked source` was skipped by `needsCommand("git", ...)`. With git
installed it ran, and failed with `fatal: not a git repository`: the guest runs the suite from an
**unpacked tarball**, which has no `.git`. A gate asking whether the machine has git, guarding a test
that needs a git **checkout**, is a gate that does not guard what it claims, and it turned an
environment fact into what looked like a packaging failure. `needsGitCheckout` asks the real question.

### The executable bit, which Windows does not have

`readVerifiedSource` decided which files a release may mark executable with:

```ts
executable: Boolean(info.mode & 0o111)
```

Windows stores no execute bit. `lstat` reports `0o666` for every file, so on this platform that line
calls **every file non executable**, including `bin/sbar-orbit`. A release verified and repackaged on
a Windows machine would ship a launcher with mode `0644`: a release that installs and then cannot
run, on the POSIX machine that receives it.

The bit is a property of the **release**, not of the filesystem the release happens to be sitting on,
so it now travels in `SOURCE-MANIFEST.json`. `scripts/package.ts` writes it, and `readVerifiedSource`
prefers it and falls back to the filesystem where the manifest is silent, which keeps every release
published so far verifying unchanged. Where the manifest is silent **and** the filesystem cannot
answer, it is **refused** rather than guessed.

Measured on the guest, on the machine that cannot hold the bit:

| Question | Answer |
|---|---|
| `bin/sbar-orbit` executable, filesystem with no execute bit | **true**, from the manifest |
| `NOTICE` executable | false |
| a manifest with no bits recorded | **refused**: "must record executable bits to be read on a filesystem without them" |

Note what the old code would have done with that last row: accepted it, and shipped `0644`.

### The workspace fixture, fixed twice

Section 18 replaced `chmod 0o500` with a held file handle. The guest showed that **was still wrong**:
Node's `openSync` opens with delete sharing on Windows, so the handle did not block `rm` and the sweep
still deleted both workspaces. A **running process with its working directory inside the folder** does
block it, because a current directory is a reference the kernel enforces. Two attempts at the same
fixture, and only the guest could tell them apart.

### Where the count stands

**176 pass, 5 distinct failures, 87 skip.** The five: the `plan` command spawns `install.sh`, which
needs a shell this platform does not have; the systemd slice test; `/usr/bin/findmnt`; and two update
tests that build a Linux release archive and check it against a Windows install. None is a Windows
code path failing.

## 20. The documented install, which did not exist on Windows

`docs/agent-install.md` opens by saying it is "not written for one operating system either". The only
entry point it named was `./install.sh`, a bash script. **On Windows the documented install did not
exist**: an agent handed that contract had nothing it could run, and the contract test proved it by
spawning `install.sh` and failing.

`install.cmd` is the second door into the same `scripts/install.ts`. Not a second installer: a second
door, because a second implementation drifts and the drift is only ever found on the platform nobody
tests. It checks for Bun and nothing else, since the systemd user session `install.sh` requires has no
analogue here and the shared budget is a job object the process joins itself.

Run on the guest exactly as the contract tells an agent to run it:

| Field | Value |
|---|---|
| exit | **0** |
| `installed` / `dryRun` | true / true |
| `launcher` | `%LOCALAPPDATA%\Temp\orbit-contract-.../bin/sbar-orbit.cmd` |
| `capabilities` | `browserSessions=True`, `nativeSessions=False` |
| `steps` | prerequisites:done, then six skipped, as a dry run should |

### The first run found a real defect

That run reported **three remedies**, and all three were unactionable:

```
no-native-runtime   ./install.sh --native
no-capture-tools    sudo dnf install grim wl-clipboard
no-xwayland         sudo dnf install xorg-x11-server-Xwayland
```

Fedora packages, `sudo` and a bash script, on a machine with none of the three and no possible private
display. The native backend is a nested Wayland compositor and cannot exist on Windows, yet every one
of its checks was still running. The contract requires an agent to **report the remedies it did not
run**, so Orbit would have had an agent faithfully hand a Windows user instructions for Fedora. A
remedy nobody can act on is worse than no remedy. Gated: **3 remedies to 0**.

### And the fix to that had a trap in it

Skipping the native checks makes the native list empty, and `every()` on an empty list is **true**, so
`nativePrerequisitesFound` would have flipped to `true` on a machine that cannot have a private
display at all. That is worse than the noise it replaced: noise is noise, but this is a **false
capability claim in the field an agent branches on**. It is stated as `false` outright.

`not measured` is not a pass, and here it is not even a possibility.

### What the suite says now

**178 pass, 4 distinct failures, 87 skip.** The four: the systemd slice test, `/usr/bin/findmnt`, and
two update tests that build a Linux release archive and check it against a Windows install. The last
two fail with `the archive carries no bin/sbar-orbit.cmd, so it is not an Orbit release for this
platform`, which is the Windows install **correctly refusing a Linux-only archive**.

## 21. Zero failures on the guest, and what that does and does not mean

The guest suite is at **196 pass, 0 fail, 95 skip**. Every failure recorded across sections 13, 18, 19
and 20 is now closed, and the last four went the way the earlier ones did: read one at a time, they
were four different things, not one category.

| What failed | What it was |
|---|---|
| 2 update tests | `packFixture` wrote only `bin/sbar-orbit`, so the fixture was a **Linux-only archive** and the Windows updater refused it, correctly. The refusal was right and the fixture was wrong |
| `a restore is refused ...` | `/usr/bin/findmnt` spawned at **module load**, so an ENOENT took down every test in the file instead of the one that cares about btrfs |
| the systemd slice test | Genuinely Linux only: Windows installs no service at all, by design, so there are no units to assert |
| `website/tests/locale.test.tsx` | `Cannot find module 'react/jsx-dev-runtime'`. The website is a **separate workspace** and its dependencies were never installed on the guest |

### The refusal got a test instead of being deleted

`packFixture` now writes both launchers, the way a real release does, which was verified against an
actual packaged archive rather than assumed: `sbar-orbit-0.1.0-alpha.6-source.tar.gz` carries
`bin/sbar-orbit`, `bin/sbar-orbit.cmd` and `install.cmd`, and every manifest entry carries the
executable field added in section 19.

But the behaviour the broken fixture had been accidentally exercising is worth keeping, so it has a
test of its own now: an archive missing **this platform's** launcher is refused, the reason names the
missing file, and no half prepared version is left behind. That shape is real, since the two launchers
are separate tracked files.

### Two of my own tools were wrong

`needsGitCheckout`, added in section 19, used `new URL("..", import.meta.url).pathname`, which is
`/C:/...` on Windows and is not a path any Windows API accepts. It threw **between tests** rather than
failing one, which took down every file importing the module and showed up as three failures with no
`(fail)` marker anywhere in the log. `fileURLToPath` is the conversion that knows about drive letters.

And two restore tests used a literal `/tmp`, which on Windows becomes `C:\tmp` at the **drive root**
and inherits the root's permissive ACL. The privacy helper from section 16 caught it: five principals
where none should be exposed. A fresh directory under `%TEMP%` has exactly the three. The helper found
a real difference between two directories that both look like "a temporary directory".

### What zero does not mean

95 tests are **skipped** on Windows, and a skip is not a pass. The private display, the systemd units,
the D-Bus and keyring work, the btrfs snapshots: those are Linux capabilities, and Orbit on Windows is
a browser backend, not a whole port of the Linux one. `docs/support-tiers.md` states each capability at
the tier its evidence supports, and this section does not raise any of them.

What zero failures means is narrower and still worth saying: **every test that can run on Windows
does, and passes.** There is no longer a pile of failures standing between a reader and the question of
what is actually supported.

## 22. The published release, installed on a machine that had nothing

Everything through section 21 ran from **my own working tree**, pushed as a tarball, with
`node_modules` already present. That is not what a person downloads. This is the other question: does
the **release archive the packager produces** install and work on a Windows machine with none of that?

Fresh directory, nothing carried over, only the commands `docs/agent-install.md` names. It found two
defects that the suite could not, because **no test installs the real artifact**.

### The release shipped batch files Windows cannot safely read

Unpacked on the guest, measured rather than inferred:

```
install.cmd in the archive: CRLF=0  bare LF=45
bin/sbar-orbit.cmd:         CRLF=0  bare LF=136
```

`.gitattributes` says `*.cmd text eol=crlf`, but that governs **checkout**. `scripts/package.ts` reads
raw bytes from the **git index**, where the file is stored with LF. cmd.exe reads a batch file byte by
byte and a multi line `( )` block in an LF only file is where that goes wrong.

It worked anyway, and only by luck: both files were written without such a block. **That is a landmine,
not a design.** The next person to add one breaks the published release while every git checkout, and
every test, keeps passing, because the defect exists only in the artifact nobody tests. The packager
now writes CRLF for `.cmd` and `.bat`, and a gate asserts it against the index bytes, including that a
non batch file is left alone and that the correction is idempotent.

### A correct install reported itself as a failed one

```
verify = failed :: no answer from the managed broker
exit: 1
```

Every step had succeeded. The service step **skips on Windows by design**, but `verify` was gated only
on `wantsService`, so it waited 15 seconds for a broker nobody had started and then failed the whole
install. The remedy it printed told the person to read a **systemd journal that does not exist here**.

Now:

```
verify = skipped :: no managed broker on Windows: start one with `sbar-orbit.cmd serve`, then `sbar-orbit.cmd status`
exit: 0   installed=True
```

### And then it was driven, from the installed command

| Step | Result |
|---|---|
| `install.cmd --json --prefix ...` | exit **0**, `installed=True` |
| `sbar-orbit.cmd serve --managed-socket` | socket bound |
| `sbar-orbit.cmd status --json` | real broker status |
| `sbar-orbit.cmd act ID '{"type":"navigate",...}'` | `{"ok":true,"result":{"url":"http://127.0.0.1:61093/"}}` |
| `session observe ID --output` | **29249 byte JPEG**, decoded and read |

The frame shows the fixture page rendered: white on dark blue, "Sbar Orbit / the published release,
installed and driven on Windows".

### Three probe errors, recorded because the first one nearly passed

The first observe used `--socket`, which `observe` does not take. The second used
`session act ID navigate URL`, a syntax the CLI does not have: it returned an error, the navigation
never happened, and `observe` still produced a **6758 byte JPEG** that was entirely **blank white**. A
frame arrived, a byte count was printed, and the whole thing looked like success. Decoding it is what
caught it: the metadata still said `location: "New page"`.

**A byte count is not a measurement.** The image had to be looked at.

The third was PowerShell stripping the JSON's inner quotes before the process saw them. That one was
checked against the CLI directly before being blamed on the launcher, and both failed **identically**,
which is what proved it was the shell rather than Orbit.

## 23. The control channel, for whoever repeats this

There is no Windows CI on Linux without a VM. Wine is not Windows and Windows containers need a
Windows host. What worked, with nothing on the person's screen at any point:

| Tool | What it is for |
|---|---|
| `experiments/windows-vm/vmexec.py` | run PowerShell in the guest through qemu-guest-agent, session 0 |
| `experiments/windows-vm/vmexec_user.py` | the same, handed to the interactive session by a scheduled task, which is the only way to touch a browser |
| `experiments/windows-vm/vmpush.py` | push a file in over the agent channel, base64, 90000 byte chunks, sha256 verified. 82 MiB of `bun.exe` at 5.35 MiB/s |

One trap worth writing down: the guest agent payload travels as a single argv entry and Linux caps
one argument at 128 KiB, `MAX_ARG_STRLEN`, independently of the 2 MiB `ARG_MAX`. Neither a shell nor
a temporary file gets around it. Chunk below the ceiling instead.
