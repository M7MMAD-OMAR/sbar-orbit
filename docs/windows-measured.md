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
- **No broker.** No Orbit source tree has been built or run on this guest yet. Everything above is
  the primitives underneath the broker, measured one at a time.

## 6. The control channel, for whoever repeats this

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
