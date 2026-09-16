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
248 pass, 0 fail, so nothing was traded away for it.

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

### What is still not done

A session created through the broker's `session.create` RPC did not complete. The launcher underneath
it works, so the remaining problem is in the session layer above `launchChrome`, not in the launch.
That is the next piece, and it is named rather than left as "it hangs sometimes".

`bin/sbar-orbit` is also a bash script, so Bun cannot run it on Windows at all. The broker was
reached by importing `startBroker` directly. A Windows launcher is a separate, small job.

## 8. The control channel, for whoever repeats this

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
