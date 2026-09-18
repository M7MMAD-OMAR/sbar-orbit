# Sbar Orbit on macOS 13+: launching, containing and reaping an owned Chromium process tree

Audience: engineers implementing the macOS backend of Sbar Orbit in Bun/TypeScript.

Scope: no root, no kernel extension, no TCC prompt, no Gatekeeper dialog, and no
contact whatsoever with the person's own browser, profile, windows or pointer.

Evidence labels used throughout:

- **[PRIMARY]** backed by a man page, Apple documentation, XNU source, or Chromium/Crashpad source, with the citation inline.
- **[INFERRED]** a conclusion drawn from primary sources but not stated verbatim by them.
- **[OBSERVED]** widely reported behaviour, third party reports, not a primary source.
- **[UNVERIFIED]** not confirmed; must be measured on a real macOS 13+ machine before it is relied on.

This research was carried out on a Linux workstation. Nothing in this document was
executed on macOS. Every timing number and every runtime behaviour claim is
therefore **[UNVERIFIED]** unless it comes straight from a cited source. Section 9
lists the exact measurements to run before shipping.

---

## 0. Executive summary

macOS has **no** kernel guaranteed "kill my children when I die" primitive. There is no
`PR_SET_PDEATHSIG`, no job object with `KILL_ON_JOB_CLOSE`, no cgroup. The Linux and
Windows designs do not port. What macOS gives you is:

1. **Process groups**, which are kernel objects and which `killpg(2)` sweeps atomically.
   Chromium's renderer/GPU/utility helpers inherit the browser's process group
   (Section 1), so one `killpg` reaches nearly the whole tree.
2. **launchd**, which on job death kills remaining processes sharing the job's process
   group ID. This is documented in `launchd.plist(5)` under `AbandonProcessGroup`
   (Section 2.2). It is kernel adjacent (launchd is PID 1) but it is still a
   userland policy, and it is **process group based, not descendant based**.
3. **Userland death watchers**: kqueue `EVFILT_PROC`/`NOTE_EXIT`, GCD process sources,
   and pipe EOF. All best effort. Pipe EOF is the strongest of the three because file
   descriptor teardown on process death is performed by the kernel and cannot be
   skipped, even on `SIGKILL`.

The recommended architecture is therefore a **three layer defence**:

```
  Bun broker (may be SIGKILLed at any time)
        |  holds write end of a pipe; no other role in cleanup
        v
  orbit-reaper (tiny, own session via setsid(), own process group)
        |  blocks on the pipe read end + kqueue NOTE_EXIT on the broker pid
        |  on either signal: killpg(-pgid, SIGTERM) then SIGKILL after grace
        v
  Chrome browser process (same pgid as reaper) ---> helpers (inherit pgid)
                                               ---> crashpad handler (ESCAPES, Section 1.3)

  plus: a session manifest on disk + a launchd janitor that sweeps orphans,
        for the case where the reaper itself is SIGKILLed.
```

The one process that genuinely escapes a process group sweep is the **Crashpad
handler**, which deliberately double forks and calls `setsid()`. Section 1.3 proves this
from Crashpad source and Section 6 gives the mitigation.

---

## 1. Process group and session semantics

### 1.1 The primitives

`setpgid(2)` (Apple man page, `SETPGID(2)`, "set process group"):

> `setpgid()` sets the process group of the specified process `pid` to the specified
> `pgid`. If `pid` is zero, then the call applies to the current process.
> [...] `[EACCES]` The value of the `pid` argument matches the process ID of a child
> process of the calling process, and the child process has successfully executed one
> of the exec functions.

**[PRIMARY]** That `EACCES` clause is the entire reason you cannot reliably do
`spawn(); setpgid(childpid, childpid)` from the parent: it races the child's `exec`.
Set the process group **at spawn time**, not afterwards.

`posix_spawnattr_setflags(3)` (Apple man page, `POSIX_SPAWNATTR_SETFLAGS(3)`):

> `POSIX_SPAWN_SETPGROUP` If this bit is not set, then the child process inherits the
> parent process group; if it is set, then the child process will behave as if the
> `setpgid(2)` function had been called with a `pid` parameter of 0 and a `pgid`
> parameter equal to the value of the spawn-pgroup value of the `posix_spawnattr_t`,
> as set by `posix_spawnattr_setpgroup(3)`.

**[PRIMARY]** So `posix_spawnattr_setpgroup(&attr, 0)` plus `POSIX_SPAWN_SETPGROUP`
means "the child becomes the leader of a brand new process group whose pgid equals its
own pid". That is exactly what Orbit wants.

`killpg(2)` (Apple man page, `KILLPG(2)`):

> The `killpg()` function sends the signal `sig` to the process group `pgrp`.
> [...] The sending process and members of the process group must have the same
> effective user ID, or the sender must be the super-user.

**[PRIMARY]** Same UID is satisfied: Orbit runs as the person's own user. No root
needed. Equivalent from a shell or from `process.kill`: `kill(-pgid, sig)`.

### 1.2 Do Chromium's helpers stay in the browser's process group?

**Yes.** Chain of evidence, all **[PRIMARY]**:

`base/process/launch_mac.cc` (Chromium `main`), the only place `new_process_group` is
honoured on macOS:

```cpp
  short flags = POSIX_SPAWN_CLOEXEC_DEFAULT;
  if (options.new_process_group) {
    flags |= POSIX_SPAWN_SETPGROUP;
    DPSXCHECK(posix_spawnattr_setpgroup(attr.get(), 0));
  }
  DPSXCHECK(posix_spawnattr_setflags(attr.get(), flags));
```

`base/process/launch.h`:

```cpp
  // If true, start the process in a new process group, instead of
  // inheriting the parent's process group.  The pgid of the child process
  // will be the same as its pid.
  bool new_process_group = false;
```

Default `false`. **[PRIMARY]**

`content/browser/child_process_launcher_helper_mac.cc`, the mac child process launcher,
launches every renderer/GPU/utility helper:

```cpp
ChildProcessLauncherHelper::Process
ChildProcessLauncherHelper::LaunchProcessOnLauncherThread(
    const base::LaunchOptions* options,
    std::unique_ptr<PosixFileDescriptorInfo> files_to_register,
    bool* is_synchronous_launch,
    int* launch_result) {
  *is_synchronous_launch = true;
  ChildProcessLauncherHelper::Process process;
  process.process = base::LaunchProcess(*command_line(), *options);
  ...
}
```

The mac helper's `BeforeLaunchOnLauncherThread` only touches `fds_to_remap` and the
seatbelt sandbox client; it never sets `new_process_group`. **[PRIMARY]**

**[INFERRED]** Conclusion: `Google Chrome Helper`, `Google Chrome Helper (Renderer)`,
`Google Chrome Helper (GPU)` and `Google Chrome Helper (Plugin)` are all spawned with
`new_process_group == false`, hence with no `POSIX_SPAWN_SETPGROUP`, hence they inherit
the browser process's process group. A single `killpg(pgid, SIGKILL)` on the browser's
pgid reaches all of them.

The mac helpers also do **not** call `setsid()` and are not detached: they remain
direct children of the browser process, visible via `proc_listchildpids(browser_pid)`.
**[INFERRED]** from the absence of any such call in the launcher path.

Note for completeness: `base::LaunchOptions` on mac also exposes
`disclaim_responsibility`, implemented via
`responsibility_spawnattrs_setdisclaim(attr.get(), 1)` in `launch_mac.cc`. **[PRIMARY]**
The header comment explains why it matters to Orbit:

```cpp
  // When a child process is launched, the system tracks the parent process
  // with a concept of "responsibility". The responsible process will be
  // associated with any requests for private data stored on the system via
  // the TCC subsystem. When launching processes that run foreign/third-party
  // code, the responsibility for the child process should be disclaimed so
  // that any TCC requests are not associated with the parent.
```

**[INFERRED]** For Orbit this cuts the other way: you want the browser's TCC identity to
be its own, so that a stray TCC request never appears attributed to the terminal or to
Hermes. Calling `responsibility_spawnattrs_setdisclaim(attr, 1)` when spawning Chrome
from the reaper is the safer default. It is a private API (declared `extern "C"` by
Chromium, not in any public header), so treat availability as **[UNVERIFIED]** and make
the call optional behind a `dlsym` lookup.

### 1.3 The Crashpad handler escapes. Proven.

Chrome starts Crashpad from `components/crash/core/app/crashpad_mac.mm`:

```cpp
      base::FilePath handler_path =
          framework_bundle_path.Append("Helpers").Append(
              "chrome_crashpad_handler");
      ...
      bool result = GetCrashpadClient().StartHandler(
          handler_path, *database_path, metrics_path, url, ...);
```

**[PRIMARY]** `CrashpadClient::StartHandler` on macOS goes through
`util/posix/spawn_subprocess.h`. `third_party/crashpad/.../util/posix/spawn_subprocess.cc`:

```cpp
  // The three processes involved are parent, child, and grandchild. The child
  // exits immediately after spawning the grandchild, so the grandchild becomes
  // an orphan and its parent process ID becomes 1. This relieves the parent and
  // child of the responsibility to reap the grandchild with waitpid() or
  // similar. The grandchild is expected to outlive the parent process, so the
  // parent shouldn't be concerned with reaping it. ...
  pid_t pid = fork();
  ...
  if (pid == 0) {
    // Child process.
    ...
    // Call setsid(), creating a new process group and a new session, both led
    // by this process. The new process group has no controlling terminal. ...
    PCHECK(setsid() != -1) << "setsid";
```

**[PRIMARY]** This is unambiguous. The Crashpad handler:

- is **not** in the browser's process group, so `killpg` misses it;
- is **not** a descendant of the browser (reparented to PID 1), so
  `proc_listchildpids` misses it;
- is explicitly designed to **outlive** its client.

Three mitigations, in order of preference:

1. **Do not start it.** Pass `--disable-crash-reporter` (and do not pass
   `--enable-crash-reporter`). On a non branded / Chrome for Testing build crash
   reporting is off by default. **[UNVERIFIED]**, measure it.
2. **Attribute and kill it by argv.** The handler's argv contains
   `--database=<path>` and `--metrics-dir=<path>` built by
   `CrashpadClient::StartHandler` (`argv.push_back(FormatArgumentString("database", ...))`,
   **[PRIMARY]**). Point Chrome's crash dump location inside Orbit's own session
   directory, then sweep any process whose `KERN_PROCARGS2` argv contains that session
   path. Section 3.4 gives the sysctl.
3. **Match by executable path**: `proc_pidpath` of the handler ends in
   `Helpers/chrome_crashpad_handler` and lives under **Orbit's own** browser
   installation directory, never under `/Applications`. Safe to kill by path prefix
   only because Orbit ships its own browser (Section 4.3).

Never sweep by process name alone. `chrome_crashpad_handler` belonging to the person's
own Chrome has the same name.

### 1.4 Session vs process group

`setsid(2)` gives a new session **and** a new process group, and detaches from the
controlling terminal. Orbit's reaper should call it so that a Ctrl-C or a hangup in the
person's terminal never propagates into the browser tree, and conversely so that the
browser can never grab the terminal.

Because the reaper is the session leader, `KERN_PROC_SESSION` (`sysctl.h`, value 3,
**[PRIMARY]**) becomes a second, independent way to enumerate the owned tree. Use it as
a cross check against the process group, not as the primary key: the Crashpad handler
calls `setsid()` itself so it leaves both.

---

## 2. Is there a macOS analogue of `PR_SET_PDEATHSIG` or `KILL_ON_JOB_CLOSE`?

**No kernel guaranteed one exists.** Stated plainly so nobody spends a week looking.

XNU has no process death signal inheritance, no job objects, no cgroups, no
`prctl(2)`. `kqueue(2)` on macOS also has **no `NOTE_TRACK`** (the FreeBSD/NetBSD
fork-following flag); the Apple `KQUEUE(2)` man page lists only `NOTE_EXIT`,
`NOTE_EXITSTATUS`, `NOTE_FORK`, `NOTE_EXEC`, `NOTE_SIGNAL`, `NOTE_REAP` for
`EVFILT_PROC`. **[PRIMARY]**

What exists instead, ranked by strength:

### 2.1 launchd as supervisor: the strongest available mechanism

`launchd.plist(5)`, key `AbandonProcessGroup`:

> When a job dies, `launchd` kills any remaining processes with the same process group
> ID as the job. Setting this key to true disables that behavior.

**[PRIMARY]** and it is the single most useful sentence in this whole document. Read it
carefully:

- The sweep is performed by **launchd (PID 1)**, which cannot be killed and cannot be
  raced. So if the browser tree is a launchd job, the tree's cleanup does not depend on
  any Orbit process surviving.
- The sweep is keyed on **process group ID**, not on descendancy. Everything in
  Section 1.2 (the helpers) is covered. The Crashpad handler of Section 1.3 is **not**,
  because it `setsid()`s into its own group.
- Default is `false`, i.e. the sweep is **on** by default. Do not set this key.

`launchctl(1)` on domains and `bootout`:

> `bootstrap | bootout` `domain-target` [`service-path` ...] | `service-target`
> Bootstraps or removes domains and services. When service arguments are present,
> bootstraps and correspondingly removes their definitions into the domain.

> `gui/<uid>/[service-name]` Another form of the `login` specifier. Rather than
> specifying a user-login domain by its ASID, this specifier targets the domain based on
> which user it is associated with and is generally more convenient.

**[PRIMARY]**

`launchd.plist(5)`, `ExitTimeOut`:

> The amount of time `launchd` waits between sending the SIGTERM signal and before
> sending a SIGKILL signal when the job is to be stopped.

**[PRIMARY]**

**Honest answer to "does `bootout` kill descendants?":** the man pages do **not** say
that. What they support is: `bootout` removes the service, which stops it
(SIGTERM, then SIGKILL after `ExitTimeOut`), and the `AbandonProcessGroup` semantics
then make launchd kill remaining processes **with the same process group ID as the
job**. Descendants that changed their process group are not documented as being killed.
Claiming "bootout kills the whole process tree" is **[UNVERIFIED]** and should not be
written into Orbit's docs. Claiming "bootout kills the job and every process still in
the job's process group" is **[PRIMARY]**.

Usage sketch, no root, user domain only:

```bash
UID_=$(id -u)
LABEL=com.sbarah.orbit.session.${SESSION_ID}
PLIST="$HOME/Library/Application Support/SbarOrbit/sessions/${SESSION_ID}/${LABEL}.plist"

# bootstrap into the GUI domain of this user (no sudo)
launchctl bootstrap gui/${UID_} "$PLIST"
# start it now regardless of launch conditions, print the PID
launchctl kickstart -p gui/${UID_}/${LABEL}
# inspect
launchctl print gui/${UID_}/${LABEL}
# teardown
launchctl bootout gui/${UID_}/${LABEL}
```

Minimal plist (note: `RunAtLoad` false because we `kickstart`; `KeepAlive` false because
a dead browser must stay dead; `AbandonProcessGroup` deliberately absent):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.sbarah.orbit.session.SESSION_ID</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/example/Library/Application Support/SbarOrbit/browsers/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing</string>
    <string>--user-data-dir=/Users/example/Library/Application Support/SbarOrbit/sessions/SESSION_ID/profile</string>
    <string>--remote-debugging-port=0</string>
    <string>--headless=new</string>
    <string>--use-mock-keychain</string>
    <string>--no-first-run</string>
    <string>--no-default-browser-check</string>
    <string>--disable-crash-reporter</string>
  </array>
  <key>RunAtLoad</key>          <false/>
  <key>KeepAlive</key>          <false/>
  <key>LaunchOnlyOnce</key>     <true/>
  <key>ExitTimeOut</key>        <integer>5</integer>
  <key>ProcessType</key>        <string>Background</string>
  <key>StandardOutPath</key>    <string>/Users/example/Library/Application Support/SbarOrbit/sessions/SESSION_ID/stdout.log</string>
  <key>StandardErrorPath</key>  <string>/Users/example/Library/Application Support/SbarOrbit/sessions/SESSION_ID/stderr.log</string>
</dict>
</plist>
```

`ProcessType` `Background` applies throttled CPU and I/O limits per `launchd.plist(5)`
**[PRIMARY]**; if page rendering latency matters, use `Standard` instead and measure.

Trade-off to be explicit about: as a launchd job the browser is **not** a child of any
Orbit process. You lose `waitpid`, you lose exit status, you lose stdout/stderr piping
(you get log files instead), and every launch becomes a plist write plus two
`launchctl` calls (**[UNVERIFIED]** cost, likely tens of milliseconds). What you buy is
cleanup that survives the SIGKILL of every Orbit process.

### 2.2 kqueue `EVFILT_PROC` / `NOTE_EXIT`: userland watcher, best effort

`KQUEUE(2)`, Apple:

> `EVFILT_PROC` Takes the process ID to monitor as the identifier and the events to
> watch for in `fflags` [...] **If a process can normally see another process, it can
> attach an event to it.** The events to monitor are:
> `NOTE_EXIT` The process has exited.
> `NOTE_EXITSTATUS` The process has exited and its exit status is in filter specific
> data. **Valid only on child processes** and to be used along with `NOTE_EXIT`.
> `NOTE_FORK` The process created a child process via `fork(2)` or similar call.
> `NOTE_EXEC` The process executed a new process via `execve(2)` or similar call.

**[PRIMARY]** Two consequences:

- You can watch a **non child** (the Bun broker, from the reaper) for `NOTE_EXIT`. This
  is what makes the reaper pattern possible at all.
- `NOTE_FORK` fires on the watched pid but macOS gives you **no** `NOTE_TRACK`, so you
  cannot auto-attach to newly forked grandchildren. Tree following must be done by
  polling `proc_listchildpids` (Section 3). **[PRIMARY]** by absence from the man page.

`NOTE_EXIT` is delivered by the kernel but **acted on** by your userland watcher. If the
watcher is `SIGKILL`ed, nothing happens. Best effort, not guaranteed.

### 2.3 GCD `DISPATCH_SOURCE_TYPE_PROC`

Apple's `DispatchSourceProcess` / `dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, pid,
DISPATCH_PROC_EXIT, queue)` is a libdispatch wrapper over exactly the same
`EVFILT_PROC` kqueue filter. Identical guarantees, identical failure mode, plus a
libdispatch dependency you do not need from Bun. **[INFERRED]** Skip it; use kqueue
directly, or skip both in favour of pipe EOF (next).

### 2.4 Pipe EOF: the most robust userland signal

Not a process API at all, which is why it is better. The parent holds the **write** end
of a pipe and never writes to it; the reaper holds the **read** end and blocks on
`read()`. When the parent dies for any reason, including `SIGKILL`, the kernel closes
its file descriptors during process teardown; when the last write end closes, the
reaper's `read()` returns 0 (EOF).

Why prefer it over `NOTE_EXIT`:

- It is immune to PID reuse (a kqueue registered on a PID that has already exited fails
  with `ESRCH`; register the kqueue and only then check the pid is still alive).
- No race at setup: create the pipe before `fork`/spawn.
- No watcher registration to get wrong.

Caveat: EOF fires when the **last** holder of the write end closes it. Set `FD_CLOEXEC`
on the write end in the broker so that anything the broker itself spawns does not keep
it alive. In Bun, set `stdio` explicitly and do not leak the fd.

Use **both** pipe EOF and kqueue `NOTE_EXIT`, whichever fires first. They cost nothing
together.

### 2.5 Summary table

| Mechanism | Kernel guaranteed kill? | Survives parent SIGKILL? | Survives reaper SIGKILL? | Covers Crashpad handler? |
|---|---|---|---|---|
| `killpg` from a live process | kill itself is atomic, the *decision* is userland | only if a reaper is alive | no | no (different pgid) |
| launchd job + default `AbandonProcessGroup` | yes, performed by PID 1 | yes | yes | no (different pgid) |
| kqueue `EVFILT_PROC`/`NOTE_EXIT` watcher | no | yes, if watcher lives | no | no |
| GCD `DISPATCH_SOURCE_TYPE_PROC` | no | yes, if watcher lives | no | no |
| pipe EOF watcher | no | yes, if watcher lives | no | no |
| on-disk manifest + periodic janitor | no | yes | yes, eventually | yes, by argv/path match |

Nothing in this table is a Windows job object. Say so in Orbit's docs: on macOS the
guarantee is "launchd sweeps the process group, plus a janitor catches the rest within
N seconds", not "0 survivors immediately".

---

## 3. Enumerating the owned tree from Bun via `bun:ffi`

All of `libproc` lives in `libSystem.B.dylib`, which is already loaded in every process.
No extra dylib to ship.

### 3.1 Exact C signatures

From Apple's `Libc` `darwin/libproc.h` **[PRIMARY]**:

```c
int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize);
int proc_listpgrppids(pid_t pgrpid, void *buffer, int buffersize);   /* since 10.7 */
int proc_listchildpids(pid_t ppid, void *buffer, int buffersize);    /* since 10.7 */
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);
int proc_name(int pid, void *buffer, uint32_t buffersize);
int proc_pidpath(int pid, void *buffer, uint32_t buffersize);
int proc_listpidspath(uint32_t type, uint32_t typeinfo, const char *path,
                      uint32_t pathflags, void *buffer, int buffersize);
```

`proc_listpgrppids` is the one that matches Orbit's containment model exactly: give it
the session's pgid, get back every live member. Prefer it over `proc_listchildpids`.

### 3.2 `bun:ffi` binding

```ts
// src/macos/libproc.ts
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const lib = dlopen("libSystem.B.dylib", {
  proc_listpgrppids: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  proc_listchildpids: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  proc_pidpath: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  killpg: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  setsid: { args: [], returns: FFIType.i32 },
  getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
});

/** PROC_PIDPATHINFO_MAXSIZE == 4 * MAXPATHLEN == 4 * 1024 (xnu bsd/sys/proc_info.h). */
const PROC_PIDPATHINFO_MAXSIZE = 4096;

export function pidsInGroup(pgid: number): number[] {
  // Size the buffer generously and retry on saturation. The return value is the
  // number of BYTES written. [UNVERIFIED for proc_listpgrppids specifically;
  // proc_listpids is documented as returning bytes and the family is consistent.
  // Verify by spawning a known number of children and asserting rc / 4.]
  let cap = 256;
  for (;;) {
    const buf = new Int32Array(cap);
    const rc = lib.symbols.proc_listpgrppids(pgid, ptr(buf), buf.byteLength);
    if (rc < 0) return [];                 // ESRCH: group is gone
    const n = rc >> 2;                     // bytes -> pid_t count
    if (n < cap) return Array.from(buf.subarray(0, n)).filter((p) => p > 0);
    cap *= 4;                              // buffer was saturated, grow and retry
  }
}

export function pidPath(pid: number): string {
  const buf = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE);
  const rc = lib.symbols.proc_pidpath(pid, ptr(buf), buf.byteLength);
  if (rc <= 0) return "";
  return new TextDecoder().decode(buf.subarray(0, rc));
}
```

`killpg(pgid, sig)` needs a positive pgid. Bun's own `process.kill(-pgid, sig)` also
works and avoids one FFI symbol; the FFI form is clearer about intent and returns errno
state via the return value.

### 3.3 `proc_pidinfo` short BSD info: pid, ppid, pgid in one call

From XNU `bsd/sys/proc_info.h` **[PRIMARY]**:

```c
#define PROC_PIDT_SHORTBSDINFO       13
#define PROC_PIDT_SHORTBSDINFO_SIZE  (sizeof(struct proc_bsdshortinfo))

struct proc_bsdshortinfo {
        uint32_t pbsi_pid;      /* offset  0 */
        uint32_t pbsi_ppid;     /* offset  4 */
        uint32_t pbsi_pgid;     /* offset  8 */
        uint32_t pbsi_status;   /* offset 12 */
        char     pbsi_comm[MAXCOMLEN];   /* offset 16, MAXCOMLEN == 16 */
        uint32_t pbsi_flags;    /* offset 32 */
        uid_t    pbsi_uid;      /* offset 36 */
        gid_t    pbsi_gid;      /* offset 40 */
        uid_t    pbsi_ruid;     /* offset 44 */
        gid_t    pbsi_rgid;     /* offset 48 */
        uid_t    pbsi_svuid;    /* offset 52 */
        gid_t    pbsi_svgid;    /* offset 56 */
        uint32_t pbsi_rfu;      /* offset 60 */
};                              /* total 64 bytes */
```

Offsets computed from the header field order; all fields are 4 byte, `pbsi_comm` is a
16 byte char array, so there is no padding. **[INFERRED]**, assert
`rc === 64` at runtime before trusting the layout.

```ts
const PROC_PIDT_SHORTBSDINFO = 13;

export function shortInfo(pid: number) {
  const buf = new Uint8Array(64);
  const rc = lib.symbols.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0n, ptr(buf), 64);
  if (rc !== 64) return null;           // process gone, or layout drifted
  const dv = new DataView(buf.buffer);
  const comm = new TextDecoder().decode(buf.subarray(16, 32)).replace(/\0.*$/, "");
  return {
    pid:  dv.getUint32(0,  true),
    ppid: dv.getUint32(4,  true),
    pgid: dv.getUint32(8,  true),
    status: dv.getUint32(12, true),   // SRUN 2, SZOMB 5, ... (xnu bsd/sys/proc.h)
    comm,
  };
}
```

`MAXCOMLEN` is 16, so `pbsi_comm` only carries the first 16 characters of the
executable name. `Google Chrome H` truncates. **Never match on `comm`.** Use
`proc_pidpath`, which returns the full executable path.

### 3.4 `sysctl` fallbacks

`KERN_PROC` and its subtypes, XNU `bsd/sys/sysctl.h` **[PRIMARY]**:

```c
#define CTL_KERN            1
#define KERN_PROC          14   /* struct: process entries */
#define KERN_PROC_ALL       0
#define KERN_PROC_PID       1
#define KERN_PROC_PGRP      2
#define KERN_PROC_SESSION   3
#define KERN_PROC_UID       5
#define KERN_PROCARGS      38
#define KERN_PROCARGS2     49
```

`sysctl(3)` with `mib = [CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid]` returns an array of
`struct kinfo_proc`. `kinfo_proc` embeds `struct extern_proc`, whose layout in
`bsd/sys/proc.h` puts `p_pid` at **offset 40** on LP64 (union of two pointers = 16,
`p_vmspace` 8, `p_sigacts` 8, `p_flag` int 4 at 32, `p_stat` char at 36, then 4 byte
align before `pid_t p_pid`). **[INFERRED]** from the header, must be asserted at
runtime. There are also `user32_kinfo_proc` and `user64_kinfo_proc` variants in
`sysctl.h`, which is the sort of detail that makes hand-rolled struct offsets fragile.

**Recommendation:** use `libproc` for enumeration; use `sysctl` only for the one thing
libproc cannot do, namely reading a process's argv.

`KERN_PROCARGS2` (mib `[CTL_KERN, KERN_PROCARGS2, pid]`) returns, in order: a 4 byte
`argc`, the executable path, NUL padding, then `argc` NUL terminated argv strings, then
the environment. Size the buffer from `sysctl [CTL_KERN, KERN_ARGMAX]` (value 8,
**[PRIMARY]**). This is the only reliable way to see `--user-data-dir=` and
`--database=` on a running process, and hence the only reliable way to attribute the
Crashpad handler (Section 1.3) and any stray helper to an Orbit session rather than to
the person's browser.

Reading another process's argv via `KERN_PROCARGS2` requires the target to be the same
UID (or root). Same UID is satisfied. **[UNVERIFIED]** whether macOS 13's hardened
runtime restrictions affect reading argv of a **signed, hardened** Chrome from an
unsigned Bun process. Measure this. If it fails, fall back to attribution by
`proc_pidpath` prefix, which is sufficient because Orbit ships its own browser under
its own directory (Section 4.3).

### 3.5 Attribution: is this pid Orbit's, or the person's?

Apply these in order. A process is Orbit's **only if** at least one of 1 or 2 holds.
Never kill on a weaker match.

1. **Process group / session identity.** `shortInfo(pid).pgid === session.pgid`, or the
   session id from `KERN_PROC_SESSION` matches the reaper's. Cheap, exact, and it is
   the primary key. Covers browser plus all helpers.
2. **Executable path prefix.** `proc_pidpath(pid)` starts with Orbit's browser install
   directory, e.g.
   `~/Library/Application Support/SbarOrbit/browsers/`. Because Orbit never launches
   `/Applications/Google Chrome.app`, this can never match the person's browser.
   Covers the escaped Crashpad handler.
3. **argv contains the session's `--user-data-dir` or `--database` path.** Confirmatory
   only, via `KERN_PROCARGS2`. Use it to log *why* a pid was swept.
4. **Start time is after the session's start time.** `proc_bsdinfo.pbi_start_tvsec`
   (`PROC_PIDTBSDINFO`, flavor 3). Guards against PID reuse between the manifest write
   and the janitor run. Always apply this as an additional filter, never alone.

Hard rule for the implementation: the janitor **must** refuse to signal any pid whose
`proc_pidpath` lies under `/Applications`, `/System`, or `/Users/<me>/Applications`. Make
that a unit-tested guard, not a comment.

---

## 4. Never touching the person's browser

### 4.1 Why `open(1)` is disqualified

`OPEN(1)`, Apple man page:

> The `open` command opens a file (or a directory or URL), just as if you had
> double-clicked the file's icon. If no application name is specified, the default
> application as determined via **LaunchServices** is used to open the specified files.
> [...] `-n` Open a new instance of the application(s) even if one is already running.

**[PRIMARY]** Two independent reasons `open` cannot be used by Orbit:

1. **Handoff.** Without `-n`, LaunchServices hands the request to the already running
   `Google Chrome.app` instance, which is the person's browser with the person's windows
   and the person's logged-in profile. The command
   `open -a "Google Chrome" --args --headless` given in Chrome's own docs
   (developer.chrome.com, "Chrome Headless mode", macOS section, **[PRIMARY]**) is exactly
   the wrong thing for Orbit's threat model: on a machine where Chrome is already
   running it may simply activate the person's Chrome and drop the flags. **[OBSERVED]**,
   since `--args` is only delivered to a newly launched instance.
2. **No containment, even with `-n`.** `open` asks launchd/LaunchServices to start the
   app and returns. The resulting process is a child of `launchd`, not of Orbit. It is in
   neither Orbit's process group nor Orbit's session. `killpg` cannot reach it,
   `proc_listchildpids` cannot find it, pipe EOF means nothing to it. Everything in
   Sections 1 to 3 stops working. **[INFERRED]** from `open(1)` plus launchd semantics.

So: **never call `open(1)` in Orbit's macOS path.** Add a lint rule.

### 4.2 The correct way: exec the Mach-O inside the bundle

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

Executing this path directly with `posix_spawn`/`execve`:

- does **not** go through LaunchServices, so there is no instance handoff;
- makes the browser a **direct child** of the spawner, in the spawner's process group;
- delivers argv exactly as given.

Chrome's own instance deduplication then happens at the application layer, via
`ProcessSingleton`. `chrome/browser/process_singleton.h`:

```cpp
// This class allows different browser processes to communicate with
// each other.  It is named according to the user data directory, so
// we can be sure that no more than one copy of the application can be
// running at once with a given data directory.
//
// Implementation notes:
// - the Windows implementation uses an invisible global message window;
// - the Linux implementation uses a Unix domain socket in the user data dir.
```

**[PRIMARY]** On macOS the POSIX implementation is used (`process_singleton_posix.cc`,
socket plus `SingletonLock` symlink inside the user data dir), with one mac-specific
addition, `process_singleton_mac.mm`, whose only job is forwarding a pending
`kAEGetURL` Apple Event to an already running instance:

```cpp
// macOS 10.13 tries to open a new Chrome instance if a user tries to
// open an external link after Chrome has updated, but not relaunched.
// This method extracts any waiting "open URL" AppleEvent and forwards
// it to the running process.
bool WaitForAndForwardOpenURLEvent(pid_t event_destination_pid);
```

**[PRIMARY]** The singleton is **keyed on the user data directory**. A distinct
`--user-data-dir` therefore gets a distinct singleton and cannot hand off to, notify, or
activate the person's running Chrome. This is the mechanism that makes the isolation
real, and it is documented in Chromium source.

### 4.3 Strong recommendation: ship your own browser, do not use `/Applications`

Even done correctly, launching the person's `/Applications/Google Chrome.app` binary is
a bad idea for Orbit:

- Chrome auto-updates underneath you; the bundle can be swapped mid-run.
  `chrome/app/chrome_exe_main_mac.cc` carries an entire block of comments about the main
  executable changing on disk while the application is running and `SecCode` ceasing to
  work as a result. **[PRIMARY]**
- Its Keychain "Chrome Safe Storage" item is the person's (Section 6.3).
- Path-prefix attribution (Section 3.5, rule 2) becomes impossible: Orbit's processes
  and the person's processes share an executable path.

Use **Chrome for Testing** instead, downloaded into Orbit's own directory. It is
published per version at
`https://storage.googleapis.com/chrome-for-testing-public/<version>/mac-arm64/chrome-mac-arm64.zip`
with a machine readable index at
`https://googlechromelabs.github.io/chrome-for-testing/` (JSON API endpoints documented
in the GoogleChromeLabs repo). **[PRIMARY]** Chrome's own docs state its purpose:

> **Chrome for Testing** is a Chrome flavor that specifically targets web app testing and
> automation use cases. [...] None of this is possible with an auto-updating browser
> binary.

**[PRIMARY]** It does not auto-update, has a different bundle identifier, and the
executable is at
`chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.

### 4.4 The launch flags Orbit should use

```
--user-data-dir=<session dir>/profile   # distinct ProcessSingleton, own everything
--remote-debugging-port=0               # then read <profile>/DevToolsActivePort
--headless=new                          # or use chrome-headless-shell, Section 5
--use-mock-keychain                     # no Keychain dialog, Section 6.3
--no-first-run
--no-default-browser-check
--disable-crash-reporter                # avoid the escaping Crashpad handler [UNVERIFIED]
--password-store=basic                  # belt and braces alongside --use-mock-keychain
--disable-background-networking
--disable-component-update
--no-default-browser-check
```

`--user-data-dir` on macOS does the same thing it does everywhere: it relocates the
entire profile tree, including `Local State`, `Default/`, the DevTools port file, and
the `SingletonLock`. It does **not** relocate the Keychain item (Section 6.3) and it does
**not** by itself relocate the Crashpad database. Both need explicit handling.

---

## 5. Headless specifics on macOS 13+

### 5.1 The two headless implementations

`headless/README.md` (Chromium), **[PRIMARY]**:

> As of M118, precompiled `headless_shell` binaries are available for download under the
> name `chrome-headless-shell` via Chrome for Testing infrastructure.
> As of M132, headless shell functionality is no longer part of the Chrome binary, so
> `--headless=old` has no effect. If you are using old Headless functionality you should
> now migrate to `chrome-headless-shell`.

`chrome/browser/headless/README.md`, **[PRIMARY]**:

> This directory hosts the new Headless implementation, sharing browser code in
> `//chrome`. The old Headless was implemented as a separate application layer and can be
> found in `//headless`.

developer.chrome.com, "Chrome Headless mode", **[PRIMARY]**:

> In Chrome 112, the Headless mode was updated so that Chrome creates, but doesn't
> display, any platform windows. All other functions, existing and future, are available
> with no limitations.

So on a current Chrome, `--headless` and `--headless=new` are the same thing, and
`--headless=old` is dead. "Creates, but doesn't display, any platform windows" is the
key phrase for macOS.

### 5.2 Does new headless need a window server connection or an Aqua session?

New headless Chrome on macOS runs platform window creation code. Chromium's
mac-specific headless initialisation, `chrome/browser/headless/headless_mode_platform_mac.mm`,
in full **[PRIMARY]**:

```objc
void PreventDockIconAndMenu() {
  // Transform the process to a background daemon (BackgroundOnly) to hide it
  // from the Dock, remove the menu bar and prevent interactive windows.
  ProcessSerialNumber psn = {0, kCurrentProcess};
  TransformProcessType(&psn, kProcessTransformToBackgroundApplication);
}

void InitializePlatform() {
  const base::CommandLine& command_line =
      CHECK_DEREF(base::CommandLine::ForCurrentProcess());
  if (!command_line.HasSwitch(::switches::kProcessType)) {
    PreventDockIconAndMenu();
  }
}
```

`TransformProcessType` is an ApplicationServices (HIToolbox) call operating on a
`ProcessSerialNumber`. **[INFERRED]** It, and the AppKit/`NSApplication` machinery
around it, require the process to be in a GUI-capable security session, i.e. to have a
connection to the WindowServer. **[OBSERVED]** and consistently reported: new headless
Chrome on macOS fails when started from a plain SSH shell with nobody logged in at the
console, and works when started from a Terminal in a logged-in GUI session or from a
launchd **agent** in `gui/$UID`. This is **not** confirmed by a primary source; measure
it (Section 9).

**Practical answers:**

- **From a Terminal in a logged-in GUI session:** works. **[OBSERVED]**
- **From a launchd agent bootstrapped into `gui/$UID`:** the `gui/<uid>` domain is
  explicitly "created when the user logs in at the GUI" (`launchctl(1)`, **[PRIMARY]**),
  so a job there has the Aqua session. Expected to work. **[UNVERIFIED]**, measure.
- **From a launchd job in `user/<uid>` with no GUI login:** "A user domain may exist
  independently of a logged-in user" (`launchctl(1)`, **[PRIMARY]**). No Aqua session.
  New headless expected to fail. **[UNVERIFIED]**
- **Over SSH with no console login:** no Aqua session. New headless expected to fail.
  **[OBSERVED]**
- **`chrome-headless-shell` in all of the above:** it is the old, separate application
  layer in `//headless` with no `//chrome` browser UI code, so it does not run
  `headless_mode_platform_mac.mm` and does not call `TransformProcessType`. Expected to
  work with no GUI session at all. **[INFERRED]** from the two READMEs plus the absence
  of that file from `//headless`.

### 5.3 Recommendation for Orbit

Ship **both** binaries from the same Chrome for Testing version and pick at runtime:

```ts
// Detect whether this process has a GUI (Aqua) session available.
// Primary source for the domain semantics: launchctl(1).
async function hasGuiSession(uid: number): Promise<boolean> {
  const p = Bun.spawn(["launchctl", "print", `gui/${uid}`], {
    stdout: "ignore", stderr: "ignore",
  });
  return (await p.exited) === 0;
}
```

- GUI session present and the task needs full Chrome fidelity (extensions, PDF, DRM-free
  media, the real `//chrome` browser layer) -> `Google Chrome for Testing` with
  `--headless=new`.
- No GUI session, or the task is pure DOM/CDP work -> `chrome-headless-shell`.

`launchctl print gui/$UID` exiting non-zero as a GUI-session probe is **[UNVERIFIED]**;
an alternative primary-source-backed probe is the Security framework's
`SessionGetInfo` with `sessionHasGraphicAccess`, which requires more FFI. Measure the
cheap probe first.

Both binaries obey `--user-data-dir` and `--remote-debugging-port=0`, so the rest of
Orbit's plumbing is identical.

---

## 6. Known failure modes

### 6.1 Gatekeeper and quarantine

The quarantine flag is an extended attribute, `com.apple.quarantine`, applied by
**LaunchServices-aware downloaders** (Safari, Chrome, Mail, AirDrop). It is **not**
applied by `curl(1)`, `wget`, or a `fetch()` in Bun writing a file. **[OBSERVED]**, this
is well established but not stated in an Apple man page found here.

Consequences for Orbit:

- Download Chrome for Testing with `fetch()`/`curl` and unzip with `ditto -x -k` or
  `unzip`. No quarantine xattr is set, so Gatekeeper's first-launch **user consent
  dialog** never appears. The person sees nothing. This is the whole point.
- Verify, and fail loudly if the assumption breaks:

```bash
APP="$ORBIT_BROWSERS/chrome-mac-arm64/Google Chrome for Testing.app"
xattr -p com.apple.quarantine "$APP" 2>/dev/null && echo "QUARANTINED"   # expect no output
xattr -lr "$APP" | grep -c quarantine                                     # expect 0
```

- If a quarantine bit did get set (for example because the person downloaded the zip
  themselves), clear it without root, requires ownership:

```bash
xattr -dr com.apple.quarantine "$APP"
```

- `ditto -x -k --sequesterRsrc --rsrc` preserves the bundle's signature correctly;
  `unzip` has historically mangled symlinks in `.app` bundles. **[OBSERVED]** Prefer
  `ditto`.

### 6.2 Codesign verification

Chrome for Testing is signed and notarized by Google. Verify before first launch and
cache the result:

```bash
codesign --verify --deep --strict --verbose=2 "$APP"         # expect "satisfies its Designated Requirement"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Identifier|TeamIdentifier|flags'
spctl -a -vvv -t exec "$APP"                                  # Gatekeeper assessment
```

Two notes:

- `spctl` may report `rejected` for a build Gatekeeper has not seen, but with **no
  quarantine xattr** the binary still executes. Do not gate Orbit's launch on `spctl`;
  gate it on `codesign --verify` plus a pinned expected `TeamIdentifier`. **[OBSERVED]**
- Do not modify anything inside the bundle (no injecting files, no `install_name_tool`);
  any edit invalidates the signature and a hardened-runtime binary will then fail to
  launch. **[OBSERVED]**
- `codesign --verify --deep` on a full Chrome bundle is slow (**[UNVERIFIED]**, likely
  seconds). Run it once at install time, record the result plus the bundle's mtime and
  size in Orbit's manifest, and skip it on subsequent launches.

### 6.3 The Keychain "Safe Storage" prompt. This is the important one.

**Direct answer to the question asked:** a fresh `--user-data-dir` alone does **not**
guarantee that no Keychain dialog appears, because the Keychain item is **not** keyed on
the user data directory. It is keyed on two compile-time constant strings.

`components/os_crypt/keychain_password_mac.mm`, **[PRIMARY]**:

```objc
// These two strings ARE indeed user facing.  But they are used to access
// the encryption keyword.  So as to not lose encrypted data when system
// locale changes we DO NOT LOCALIZE.
#if BUILDFLAG(GOOGLE_CHROME_BRANDING)
const char kDefaultServiceName[] = "Chrome Safe Storage";
const char kDefaultAccountName[] = "Chrome";
#else
const char kDefaultServiceName[] = "Chromium Safe Storage";
const char kDefaultAccountName[] = "Chromium";
#endif

std::string KeychainPassword::GetPassword() const {
  UInt32 password_length = 0;
  void* password_data = nullptr;
  OSStatus error = keychain_.FindGenericPassword(
      GetServiceName().size(), GetServiceName().c_str(),
      GetAccountName().size(), GetAccountName().c_str(), &password_length,
      &password_data, nullptr);

  if (error == noErr) { ...return password; }

  if (error == errSecItemNotFound) {
    std::string password = AddRandomPasswordToKeychain(
        keychain_, GetServiceName(), GetAccountName());
    return password;
  }
  ...
}
```

Read the flow carefully:

1. The lookup is `FindGenericPassword(service="Chrome Safe Storage", account="Chrome")`.
   **Nothing in that call mentions the profile directory.** A fresh `--user-data-dir`
   changes nothing here.
2. If the item exists (it does, on any Mac where the person has ever run Chrome) and the
   calling binary is not on the item's ACL, macOS raises the
   "wants to use your confidential information stored in Chrome Safe Storage" dialog.
   That dialog appears **on the person's screen** and is a hard violation of Orbit's
   rule. **[INFERRED]** from the code plus Keychain Services ACL semantics.
3. Only if the item is genuinely absent (`errSecItemNotFound`) does Chrome create a
   fresh random 128-bit password with `AddGenericPassword`, which does **not** prompt.
   So the "fresh Safe Storage item does not prompt" half of the question is **true**, but
   you can only reach it on a machine where no Chrome has ever run, which Orbit cannot
   assume. **[PRIMARY]** for the code path, **[INFERRED]** for the no-prompt conclusion.

`ALLOW_RUNTIME_CONFIGURABLE_KEY_STORAGE` exists in the same file and would let the
service/account names be overridden at runtime, but it is a build flag that is not
enabled in shipping Chrome builds. **[PRIMARY]** for the flag's existence,
**[UNVERIFIED]** for whether Chrome for Testing enables it. Do not rely on it.

**The fix.** `components/os_crypt/os_crypt_switches.h`, **[PRIMARY]**:

```cpp
// Uses mock keychain for testing purposes, which prevents blocking dialogs
// from causing timeouts.
COMPONENT_EXPORT(OS_CRYPT) extern const char kUseMockKeychain[];
```

and `os_crypt_switches.cc`:

```cpp
const char kUseMockKeychain[] = "use-mock-keychain";
```

So pass **`--use-mock-keychain`** on every Orbit launch on macOS. The switch exists
precisely to stop the Keychain from raising blocking dialogs. Add `--password-store=basic`
as a second line of defence.

Trade-off to document: with a mock keychain, cookies and passwords in the Orbit profile
are encrypted with a throwaway key, so they do not survive across the mock keychain's
lifetime in the way a real profile's do. For Orbit, whose profiles are per-session and
disposable, this is correct behaviour, not a loss.

**Absolute rule, restating the existing policy:** Orbit must never call
`FindGenericPassword` (or `security find-generic-password`) against the person's
"Chrome Safe Storage" item, and must never attempt to decrypt the person's cookie or
login database. Reading it raises a dialog and is refused by design.

### 6.4 Other failure modes worth encoding as tests

- **Stale `SingletonLock`.** A `SIGKILL`ed browser leaves `SingletonLock`,
  `SingletonSocket`, `SingletonCookie` in the profile. Orbit's profiles are per-session
  and disposable, so the correct handling is: never reuse a profile directory after an
  abnormal exit, create a new one. Do **not** write generic "delete the SingletonLock"
  code that could ever be pointed at the person's profile.
- **`DevToolsActivePort` race.** With `--remote-debugging-port=0`, the file
  `<user-data-dir>/DevToolsActivePort` is written after the listener binds. Poll for it
  with a timeout; do not assume it exists at spawn+0ms.
- **PID reuse.** macOS PIDs wrap. Always pair a pid with its start time
  (`proc_bsdinfo.pbi_start_tvsec`, flavor `PROC_PIDTBSDINFO` = 3, **[PRIMARY]**) in the
  on-disk manifest before the janitor acts on it.
- **Process group reuse.** A pgid is just a pid, so it is subject to the same reuse.
  The janitor must verify that the pgid's leader still has the recorded start time
  before it calls `killpg`. Getting this wrong means Orbit kills an unrelated process
  group belonging to the person. This is the single highest-severity bug in this design;
  gate it behind the path-prefix guard of Section 3.5.
- **Zombies.** If Orbit's reaper spawns the browser, it must `waitpid` it, or the
  browser stays a zombie holding its pid. Bun's `Subprocess` reaps automatically when
  you `await proc.exited`.

---

## 7. Recommended implementation

### 7.1 Launch

```ts
// orbit/macos/launch.ts  (runs in the Bun broker)
import { mkdirSync } from "node:fs";

export async function launchSession(session: OrbitSession) {
  mkdirSync(session.dir + "/profile", { recursive: true });

  // 1. A pipe whose write end only the broker holds. Its EOF is the reaper's
  //    kernel-backed signal that the broker died, SIGKILL included.
  const { readFd, writeFd } = makePipe();          // via bun:ffi pipe(2)

  // 2. Spawn the reaper. The reaper calls setsid(), so it leads a new session
  //    AND a new process group; it then spawns Chrome into that same group.
  const reaper = Bun.spawn(
    [
      process.execPath, import.meta.dir + "/reaper.ts",
      "--watch-pid", String(process.pid),
      "--death-fd", String(readFd),
      "--session-dir", session.dir,
      "--", browserExecutable, ...browserArgs(session),
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
      // the reaper must NOT die with the broker's terminal
    },
  );

  // 3. The reaper writes {reaperPid, pgid, browserPid, startTimes} to
  //    <session.dir>/manifest.json before it starts watching.
  return await readManifestWhenReady(session.dir);
}
```

### 7.2 The reaper

```ts
// orbit/macos/reaper.ts
// Own session + own process group, so killpg(pgid) is exactly "everything Orbit owns".
lib.symbols.setsid();                      // new session, new pgroup, no controlling tty
const pgid = lib.symbols.getpgid(0);       // == our own pid

const browser = Bun.spawn([browserExecutable, ...args], { stdio: [...] });
// browser inherits OUR process group because we do not pass POSIX_SPAWN_SETPGROUP
// and Chromium's helpers inherit it in turn (Section 1.2).

writeManifest({ reaperPid: process.pid, pgid, browserPid: browser.pid, ... });

// Wait for whichever comes first: broker pipe EOF, broker NOTE_EXIT, browser exit.
await Promise.race([
  waitForPipeEof(deathFd),                 // strongest, Section 2.4
  waitForNoteExit(brokerPid),              // kqueue EVFILT_PROC, Section 2.2
  browser.exited,
]);

// Graded teardown.
lib.symbols.killpg(pgid, SIGTERM);
await sleep(GRACE_MS);                     // start at 500 ms, tune from measurement
if (pidsInGroup(pgid).length > 0) {
  lib.symbols.killpg(pgid, SIGKILL);
}
// Crashpad and any other escapee: attribute by proc_pidpath prefix + start time,
// then SIGKILL individually. Never by name alone.
sweepEscapees(session);
clearManifest(session.dir);
```

### 7.3 The janitor, for when the reaper itself is SIGKILLed

A launchd **agent** in `gui/$UID`, `StartInterval` 60, that:

1. reads every `manifest.json` under `~/Library/Application Support/SbarOrbit/sessions/`;
2. for each, checks whether the recorded reaper pid is alive **and** still has the
   recorded start time;
3. if the reaper is gone, verifies the pgid leader's start time, verifies every member's
   `proc_pidpath` lies under Orbit's browser directory, then `killpg(pgid, SIGKILL)` and
   sweeps escapees by path plus argv;
4. removes the session directory.

This is the layer that makes the macOS story honest: "cleanup within one janitor
interval, guaranteed by launchd, even if every Orbit process is SIGKILLed", as opposed to
Windows' "0 survivors after 236 ms".

### 7.4 Optional stronger variant: browser as its own launchd job

If the 60 second janitor window is unacceptable, put the **browser** in a per-session
launchd job (Section 2.1 plist) instead of under the reaper. Then:

- `launchctl bootout gui/$UID/<label>` is the normal teardown path;
- if everything of Orbit's dies, the job is still a launchd job with `KeepAlive false`,
  and when its main process dies launchd sweeps the job's process group by default
  (`AbandonProcessGroup`, **[PRIMARY]**);
- you still need the janitar to `bootout` orphaned labels, but the *process* cleanup no
  longer depends on Orbit.

Cost: no direct parent/child relationship, no stdout pipe, extra plist I/O per session.
Recommendation: build 7.1 to 7.3 first, measure, and only move to 7.4 if the measured
orphan window is a real problem.

---

## 8. What to write in Orbit's macOS documentation

Do not claim parity with Linux or Windows. The accurate wording:

> On macOS, Orbit places the browser in its own process group and session, owned by a
> small reaper process that watches the broker through a pipe whose EOF the kernel
> guarantees. Normal teardown and broker crash are both handled immediately. macOS
> provides no kernel guaranteed kill-on-parent-death primitive, so if the reaper itself
> is force-killed, a launchd-supervised janitor sweeps the orphaned process group within
> one interval. Orbit never launches, signals, or reads the profile of the browser
> installed in /Applications; it ships and runs its own pinned Chrome for Testing build.

---

## 9. Measurements to run on real macOS 13+ hardware before shipping

Each of these turns an **[UNVERIFIED]** above into a fact. Record results back into this
document.

1. **Helper process groups.** Launch Chrome for Testing headful and headless; for every
   pid under it run `ps -o pid,ppid,pgid,sess,comm`. Assert every
   `Google Chrome Helper*` shares the browser's `pgid`. Confirms Section 1.2.
2. **Crashpad escape.** Same run, locate `chrome_crashpad_handler`, record its `ppid`
   (expect 1), `pgid` and `sess` (expect its own). Confirms Section 1.3. Then repeat with
   `--disable-crash-reporter` and assert the handler does not exist at all.
3. **`killpg` coverage and timing.** `killpg(pgid, SIGKILL)`, then poll
   `proc_listpgrppids` until empty. Record the milliseconds. This is the number to put
   next to Windows' 236 ms.
4. **Broker SIGKILL.** `kill -9` the Bun broker; assert the reaper fires on pipe EOF and
   the group is empty within the recorded time. Repeat 100 times, assert 0 survivors.
5. **Reaper SIGKILL.** `kill -9` broker and reaper together; assert the janitor cleans up
   within one interval and that it never touches any process outside Orbit's browser
   directory.
6. **`proc_listpgrppids` return units.** Spawn N known children, assert `rc === 4*N` (or
   `rc === N`, whichever it is) and fix the `>> 2` in Section 3.2 accordingly.
7. **`proc_bsdshortinfo` layout.** Assert `proc_pidinfo(..., 13, ...) === 64` and that
   the decoded `pid` equals the requested pid.
8. **`KERN_PROCARGS2` against a hardened, signed Chrome** from an unsigned Bun process.
   Does it return argv, or `EINVAL`/`EPERM`? Determines whether Section 3.5 rule 3 is
   usable.
9. **New headless without a GUI session.** Run
   `Google Chrome for Testing --headless=new --user-data-dir=... --remote-debugging-port=0`
   over SSH with nobody logged in at the console. Record the exact failure, if any. Then
   repeat from a launchd agent in `gui/$UID` with the console logged in. Then repeat both
   with `chrome-headless-shell`. Confirms or refutes Section 5.2.
10. **Keychain dialog.** On a Mac where the person's Chrome has run before, launch Orbit's
    browser with a fresh `--user-data-dir` **without** `--use-mock-keychain` and watch for
    the Safe Storage dialog (in a VM or on a test account, never on the person's
    machine). Then confirm `--use-mock-keychain` suppresses it. Confirms Section 6.3.
11. **Quarantine.** Download the Chrome for Testing zip with `curl`, extract with
    `ditto`, assert `xattr -lr` shows no `com.apple.quarantine`, and that the first launch
    raises no dialog.
12. **`launchctl bootout` scope.** Bootstrap a job that forks a child which calls
    `setsid()`. `bootout` the job. Does the `setsid()`ed grandchild survive? Expected yes,
    per Section 2.1. Settles the "does bootout kill descendants" question definitively.

---

## Source index

Apple man pages (macOS / Xcode command line tools):

- `SETPGID(2)`, `KILLPG(2)`, `KQUEUE(2)`, `OPEN(1)`, `LAUNCHCTL(1)`,
  `LAUNCHD.PLIST(5)`, `POSIX_SPAWNATTR_SETFLAGS(3)`, `SYSCTL(3)`.

XNU source (`apple-oss-distributions/xnu`):

- `bsd/sys/sysctl.h`: `CTL_KERN`, `KERN_PROC`, `KERN_PROC_ALL/PID/PGRP/SESSION`,
  `KERN_PROCARGS2`, `KERN_ARGMAX`, `struct kinfo_proc`.
- `bsd/sys/proc.h`: `struct extern_proc`, process status values.
- `bsd/sys/proc_info.h`: `struct proc_bsdinfo`, `struct proc_bsdshortinfo`,
  `PROC_PIDTBSDINFO`, `PROC_PIDT_SHORTBSDINFO`, `PROC_PIDPATHINFO_MAXSIZE`.

Apple Libc source:

- `darwin/libproc.h`: `proc_listpids`, `proc_listpgrppids`, `proc_listchildpids`,
  `proc_pidinfo`, `proc_pidpath`, `proc_name`, `proc_listpidspath`.

Chromium source (`chromium/src`, branch `main` unless noted):

- `base/process/launch_mac.cc`: `POSIX_SPAWN_SETPGROUP`, `posix_spawnattr_setpgroup`,
  `responsibility_spawnattrs_setdisclaim`.
- `base/process/launch.h`: `new_process_group`, `disclaim_responsibility`.
- `content/browser/child_process_launcher_helper_mac.cc`: helper launch path.
- `chrome/browser/process_singleton.h`, `chrome/browser/process_singleton_mac.mm`:
  singleton keyed on user data dir, Apple Event forwarding.
- `chrome/browser/headless/headless_mode_platform_mac.mm`: `TransformProcessType`.
- `chrome/browser/headless/README.md`, `headless/README.md`: new vs old headless.
- `components/crash/core/app/crashpad_mac.mm`: `StartHandler` call site.
- `components/os_crypt/keychain_password_mac.mm` (tag 106.0.5249.221):
  `"Chrome Safe Storage"`, `GetPassword`, `AddRandomPasswordToKeychain`.
- `components/os_crypt/os_crypt_switches.{h,cc}`: `--use-mock-keychain`.
- `chrome/app/chrome_exe_main_mac.cc`: executable-changed-on-disk / `SecCode` notes.

Crashpad source (`crashpad/crashpad`):

- `client/crashpad_client_mac.cc`: `SpawnSubprocess` call, handler argv construction.
- `util/posix/spawn_subprocess.cc`: the double fork plus `setsid()` that detaches the
  handler.

Chrome developer documentation:

- developer.chrome.com "Chrome Headless mode".
- developer.chrome.com "Chrome for Testing".
- googlechromelabs.github.io/chrome-for-testing (download index).
