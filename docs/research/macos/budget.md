# Enforcing and measuring a SHARED resource budget on macOS 13+ without root

Scope: macOS 13 Ventura through macOS 15/16 (Sequoia and the "26" line), Apple silicon
and Intel. Constraints assumed throughout: the Orbit broker runs as an ordinary
non-root user, installs no kernel extension, ships no signed installer with a
privileged helper, and must never raise a TCC prompt on the person's screen.

Target contract, restated from the Linux implementation (`sbarorbit.slice` with
`cpu.max`, `memory.max`, `memory.swap.max`, `pids.max`) and from the Windows port
(one named job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_JOB_MEMORY`,
`JOB_OBJECT_LIMIT_ACTIVE_PROCESS`, and a hard CPU rate cap).

---

## 0. The short answer, stated first

**macOS has no unprivileged, userland-reachable facility that enforces a shared
resource pool across several independent processes started at different times.**
There is no cgroup, no job object, no per-user-per-application container with a
CPU or memory ceiling that a normal process may create and then attach later
children to.

The one kernel object with the right shape is the **task coalition**
(`osfmk/mach/coalition.h`). It exists, it aggregates CPU time and physical
footprint across every task inside it, and the kernel does use it for resource
attribution. But:

- Creating a coalition (`coalition(COALITION_OP_CREATE, ...)`, syscall 458) is
  gated on `task_is_in_privileged_coalition(proc_task(p), type)` in
  `bsd/kern/sys_coalition.c`; on a release kernel that returns the `privileged`
  bit of the coalition your task already lives in. A coalition created by launchd
  for a user's LaunchAgent is not privileged, so an Orbit process calling
  `coalition_create` gets `EPERM`.
- Spawning into a coalition other than your own requires the entitlement
  `com.apple.private.coalition-spawn` (`COALITION_SPAWN_ENTITLEMENT` in
  `mach/coalition.h`, checked in `bsd/kern/kern_exec.c` around the
  `psa_coalition_info` handling). Private entitlements cannot be granted to
  third-party code.
- `coalition_ledger()` (syscall 532), the only coalition call that sets a *limit*,
  begins with `if (!kauth_cred_issuser(kauth_cred_get())) { error = EPERM; }` and
  in any case its sole operation is `COALITION_LEDGER_SET_LOGICAL_WRITES_LIMIT`,
  a disk-write limit, not CPU or memory.
- `coalition_policy_set` / `coalition_policy_get` (syscalls 556/557) both require
  `COALITION_POLICY_ENTITLEMENT`.

So coalitions can be **read** (see section 7) but never **created** or **capped**
by us. Everything else macOS offers is either per-process, per-UID, or
measurement only.

The strongest honest design is therefore: **per-process hard limits where the
kernel provides them, plus a userland accounting loop over the owned process tree
that refuses to start new work and kills the tree when the pool is over budget.**
Section 12 specifies that loop and names precisely what it does not prevent.

---

## 1. Capability matrix

Columns: E = enforces a limit, M = measures only. Scope = one process (P),
whole tree (T), whole UID (U), whole host (H).

| Mechanism | E/M | Scope | Root or entitlement | Reachable from Bun |
|---|---|---|---|---|
| `setrlimit(RLIMIT_AS)` | E | P, inherited by fork and preserved across exec | no | `bun:ffi` `libc` |
| `setrlimit(RLIMIT_DATA)` | E | P, inherited | no | `bun:ffi` |
| `setrlimit(RLIMIT_CPU)` | E (SIGXCPU) | P, inherited, **counter resets per process** | no | `bun:ffi` |
| `setrlimit(RLIMIT_NPROC)` | E | **U, not T** | no (lowering only) | `bun:ffi` |
| `setrlimit(RLIMIT_NOFILE)` | E | P, inherited | no (lowering only) | `bun:ffi` |
| `setrlimit(RLIMIT_RSS)` | none | n/a | n/a | alias of `RLIMIT_AS` on Darwin |
| launchd `HardResourceLimits` / `SoftResourceLimits` | E | P of the job, inherited by its children | no, user agent | plist |
| launchd `ProcessType` | E (soft, scheduler and I/O) | job and children | no | plist |
| launchd `Nice`, `LowPriorityIO` | E (priority only) | job and children | no | plist |
| `MaterializeDatalessFiles` | E (I/O policy) | job and children | no | plist |
| `launchctl limit` | E | launchd domain, i.e. everything launched after | root for system domain | CLI |
| `taskpolicy(8)` `-c`, `-b`, `-d`, `-t`, `-l` | E (priority and I/O) | process and children | no | CLI |
| `taskpolicy -m` (jetsam memlimit) | E (fatal footprint kill) | **P only, not inherited** | no on macOS | CLI / `posix_spawnattr_setjetsam_ext` |
| `proc_setcpu_percentage` / `proc_set_cpumon_params_fatal` | E (CPU %, kill or notify) | **P only, self only on macOS** | no for self | private libproc symbol |
| `memorystatus_control` | E | P | **root or `com.apple.private.memorystatus`** | blocked |
| App Sandbox (`sandbox_init`, `sandbox-exec`) | none for CPU/memory | P | no | deprecated CLI |
| `proc_pid_rusage(RUSAGE_INFO_V4/V6)` | M | P (plus `ri_child_*` for **reaped** children) | same-UID | `libproc` via `bun:ffi` |
| `proc_pidinfo(PROC_PIDTASKINFO)` | M | P, incl. `pti_threadnum` | same-UID | `libproc` |
| `proc_listchildpids` / `proc_listpids` | M | tree enumeration | same-UID | `libproc` |
| `getrusage(RUSAGE_CHILDREN)` | M | reaped descendants only | no | `bun:ffi` |
| `task_info(TASK_BASIC_INFO_64)` | M | P | needs task port, same-UID | `bun:ffi` mach |
| `coalition_info(COALITION_INFO_RESOURCE_USAGE)` | M | **T, genuinely shared** | none observed, private SPI | `dlsym` probe |
| `host_statistics64(HOST_VM_INFO64)` | M | H | no | `bun:ffi` mach |
| `sysctl vm.swapusage` | M | H | no | `sysctlbyname` |
| task coalition create / cap | n/a | n/a | privileged coalition or private entitlement | **unavailable** |

---

## 2. setrlimit and getrlimit

Man page: `getrlimit(2)` / `setrlimit(2)`, `<sys/resource.h>`.

```c
struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; };
int getrlimit(int resource, struct rlimit *rlp);
int setrlimit(int resource, const struct rlimit *rlp);
```

Darwin resource numbers, from `bsd/sys/resource.h` on
`github.com/apple-oss-distributions/xnu` (path `bsd/sys/resource.h`, current main):

```
RLIMIT_CPU      0   cpu time per process (seconds)
RLIMIT_FSIZE    1
RLIMIT_DATA     2
RLIMIT_STACK    3
RLIMIT_CORE     4
RLIMIT_AS       5   address space; RLIMIT_RSS is a #define alias of RLIMIT_AS
RLIMIT_MEMLOCK  6
RLIMIT_NPROC    7   number of processes
RLIMIT_NOFILE   8
RLIM_NLIMITS    9
```

### 2.1 Is RLIMIT_AS actually honoured on macOS?

Yes on modern kernels, no on older ones. This is the single most misreported
fact in this area, so here is the primary evidence.

`bsd/kern/kern_resource.c`, `dosetrlimit()`:

```c
case RLIMIT_AS:
        /* Over to Mach VM to validate the new address space limit */
        if (vm_map_set_size_limit(current_map(), newrlim->rlim_cur) != KERN_SUCCESS) {
                /* The limit specified cannot be lowered because current usage is already higher than the limit. */
                error =  EINVAL;
                goto out;
        }
        break;
```

and enforcement in `osfmk/vm/vm_map.c`, at the tail of `vm_map_enter()`:

```c
if (map->size_limit != RLIM_INFINITY && map->size > map->size_limit) {
        result = KERN_NO_SPACE;
        printf("%d[%s] %s: map size 0x%llx over RLIMIT_AS 0x%llx\n", ...);
        vm_map_enter_RLIMIT_AS_count++;
} else if (map->data_limit != RLIM_INFINITY && map->size > map->data_limit) {
        result = KERN_NO_SPACE;   /* RLIMIT_DATA */
}
```

I bisected the XNU tags on opensource.apple.com to date this:

- `xnu-7195.141.2` (macOS 11 Big Sur): **no** `case RLIMIT_AS` in
  `dosetrlimit`; the limit was stored and ignored. This is the origin of the
  widely repeated "ulimit -v does nothing on macOS" folklore.
- `xnu-8020.140.41` (macOS 12 Monterey): `case RLIMIT_AS` present.
- `xnu-8792.81.2` (macOS 13 Ventura), `xnu-10002.1.13` (macOS 14 Sonoma),
  `xnu-11215.1.10` (macOS 15 Sequoia): present and unchanged.

So for our floor of macOS 13, `RLIMIT_AS` is enforced. Two caveats an implementer
must internalise:

1. It bounds the **virtual address space** of the `vm_map`, not resident memory
   and not phys_footprint. A JavaScript engine or a Chromium renderer reserves
   enormous address ranges it never faults in. Setting `RLIMIT_AS` to a value
   that looks like a sane RSS budget will make Chromium abort during startup.
   Treat it as a runaway-allocation backstop set several times higher than the
   footprint budget, not as the memory budget itself.
2. `setrlimit` returns `EINVAL` if the new limit is below current `map->size`
   (`vm_map_set_size_limit` rejects `new_size_limit < map->size`). Set it before
   the child grows, i.e. in the pre-exec window.

`RLIMIT_DATA` goes through the identical path via `vm_map_set_data_limit` and is
checked in the same `vm_map_enter` epilogue. On Darwin it is not the classic brk
limit; it is a second address-space ceiling. Do not set both to the same value.

### 2.2 Inheritance

Inherited across `fork`: yes. `bsd/kern/kern_fork.c`, `forkproc()` calls
`proc_limitfork(parent_proc, child_proc)`.

Preserved across `exec`: yes, and re-applied to the fresh `vm_map`.
`bsd/kern/kern_exec.c`:

```c
vm_map_set_size_limit(map, proc_limitgetcur(p, RLIMIT_AS));
vm_map_set_data_limit(map, proc_limitgetcur(p, RLIMIT_DATA));
```

This means a limit set once in the Orbit supervisor before spawning propagates to
every descendant, including Chromium's helper processes, with no further action.
That is the closest thing macOS has to tree-wide enforcement. **It is still
per-process, not pooled**: a limit of 4 GiB with twelve renderer processes
permits 48 GiB, exactly as `ulimit -v` does on Linux and exactly unlike
`memory.max`.

### 2.3 RLIMIT_NPROC is a trap

`RLIMIT_NPROC` on Darwin is **per real UID for the whole system**, not per tree.
`bsd/kern/kern_fork.c`:

```c
count = chgproccnt(uid, 1);
rlimit_nproc_cur = proc_limitgetcur(parent_proc, RLIMIT_NPROC);
if (uid != 0 && (rlim_t)count > rlimit_nproc_cur) {
        err = EAGAIN;
        goto bad;
}
```

`chgproccnt(uid, 1)` counts every process owned by that UID, including the
person's Safari, Xcode and Finder. If Orbit lowers `RLIMIT_NPROC` to bound its own
fan-out, the ceiling it sets is a ceiling on the human's entire login session, and
the failure mode is that *their* next application launch fails with `EAGAIN`.

**Do not use `RLIMIT_NPROC` for process-count budgeting.** Count the tree in
userland (section 8) instead. A high `RLIMIT_NPROC` is still worth setting purely
as a fork-bomb backstop, but choose a value comfortably above the person's normal
process count, and understand that hitting it hurts them, not only us.

Also note the kernel refuses to raise `rlim_cur` above `maxprocperuid` for a
non-root caller, so a non-root Orbit can only lower it.

### 2.4 RLIMIT_CPU is per process and resets

`RLIMIT_CPU` is implemented as a task virtual timer:

```c
case RLIMIT_CPU:
        ... task_info(proc_task(p), TASK_ABSOLUTETIME_INFO, ...)
        timersub(&tv, &ttv, &p->p_rlim_cpu);
        if (timercmp(&p->p_rlim_cpu, &tv, >)) task_vtimer_set(proc_task(p), TASK_VTIMER_RLIM);
        else { ... psignal(p, SIGXCPU); }
```

The budget is **per process**: each forked child starts a fresh allowance of the
same number of seconds. A tree of twenty processes with `RLIMIT_CPU` of 600 gets
twenty times 600 CPU-seconds. It cannot express "this session may consume 10
CPU-minutes total". It also cannot express a *rate* (the cgroup `cpu.max`
semantics of "40% of one core, sustained"); it is a lifetime total, after which
`SIGXCPU` fires and then `SIGKILL` on the second breach.

### 2.5 bun:ffi binding

```ts
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const libc = dlopen(`libSystem.B.${suffix}`, {
  setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});

const RLIMIT_CPU = 0, RLIMIT_DATA = 2, RLIMIT_AS = 5, RLIMIT_NPROC = 7, RLIMIT_NOFILE = 8;

function setLimit(resource: number, soft: bigint, hard: bigint): void {
  const buf = new BigUint64Array(2);   // struct rlimit { rlim_t cur; rlim_t max; }, rlim_t = uint64
  buf[0] = soft; buf[1] = hard;
  if (libc.symbols.setrlimit(resource, ptr(buf)) !== 0) throw new Error("setrlimit failed");
}

// Address-space backstop, deliberately generous: Chromium reserves far more VA than it faults in.
setLimit(RLIMIT_AS, 96n * 1024n ** 3n, 96n * 1024n ** 3n);
```

Call this in the supervisor before spawning session children. Bun's
`Bun.spawn` has no pre-exec hook, so either set the limit in the supervisor
process itself (children inherit it) or spawn through a tiny `/bin/sh -c 'ulimit
-v ...; exec ...'` shim. `ulimit -v` in `sh(1)` maps to `RLIMIT_AS`.

---

## 3. launchd LaunchAgent plist keys

Man page: `launchd.plist(5)`. All of the following go in a user LaunchAgent at
`~/Library/LaunchAgents/com.sbar.orbit.plist`, loaded into the `gui/<uid>`
domain with `launchctl bootstrap gui/$(id -u) <path>`. No root, no installer.

### 3.1 HardResourceLimits and SoftResourceLimits

`launchd.plist(5)` states verbatim: "Resource limits to be imposed on the job.
These adjust variables set with `setrlimit(2)`." Keys: `Core`, `CPU`, `Data`,
`FileSize`, `MemoryLock`, `NumberOfFiles`, `NumberOfProcesses`,
`ResidentSetSize`, `Stack`.

Mapping and honesty notes:

- `Data` maps to `RLIMIT_DATA`, enforced (section 2.1).
- `ResidentSetSize` maps to `RLIMIT_RSS`, which on Darwin is `#define
  RLIMIT_RSS RLIMIT_AS`. **The key is named after resident set size but sets
  the address-space limit.** The man page text describing it as a soft hint that
  makes the system "prefer to take memory from processes that are exceeding their
  declared resident set size" is inherited 4.4BSD prose and does not describe
  Darwin behaviour. Do not present this key to users as an RSS cap.
- `CPU` maps to `RLIMIT_CPU`, per process, resets per child (section 2.4).
- `NumberOfProcesses` maps to `RLIMIT_NPROC`, per UID (section 2.3). The man page
  itself says "the maximum number of simultaneous processes **for this UID**".
- The man page also documents that in a **system-wide daemon** these keys write
  `kern.maxfiles` / `kern.maxfilesperproc` / `kern.maxproc` / `kern.maxprocperuid`
  as a side effect. That side effect does not apply to a user LaunchAgent and in
  any case would need root.

Because these are just `setrlimit` values applied to the job before exec, they are
inherited by the job's whole subtree exactly as in section 2.2. This is the
cleanest way to establish the per-process backstops for an Orbit session: state
them declaratively in the agent plist rather than in code.

Enforce? yes, per process. Tree? inherited, but per process, not pooled. Root? no.

### 3.2 ProcessType

`launchd.plist(5)`: "This optional key describes, at a high level, the intended
purpose of the job. The system will apply resource limits based on what kind of
job it is. If left unspecified, the system will apply light resource limits to the
job, throttling its CPU usage and I/O bandwidth. This classification is preferable
to using the HardResourceLimits, SoftResourceLimits and Nice keys."

Values: `Background`, `Standard`, `Adaptive`, `Interactive`. Apple documents
`Interactive` as running "with the same resource limitations as apps, that is to
say, none".

For Orbit the right choice is **`Background`**: it is the documented way to say
"this work was not directly requested by the user, keep it from disrupting the
user experience". On Apple silicon this is what steers the tasks onto the
efficiency cores and applies the Darwin-background I/O and scheduler tiers.

What it is not: it is not a quantified cap. Apple does not publish the CPU
percentage or I/O bandwidth that `Background` implies, and the numbers differ
across machines and OS versions. You may report "class: background" to the user
but you may not report "cap: 25%".

Enforce? yes, qualitatively, scheduler and I/O tiers only. Tree? applies to the
job and is inherited by children as a task policy. Root? no.

### 3.3 Nice and LowPriorityIO

`Nice <integer>` applies `setpriority(2)`. A non-root user may only raise nice
(lower priority), which is the direction we want.

`LowPriorityIO <boolean>`: "whether the kernel should consider this daemon to be
low priority when doing filesystem I/O". Companion key `LowPriorityBackgroundIO`
applies when the process is additionally Darwin-background throttled.

Both are priority shaping, never a bound. Neither can prevent the tree from using
100% of the machine when nothing else is runnable. Include them; do not count
them as budget.

### 3.4 MaterializeDatalessFiles

`launchd.plist(5)`: "specifies the dataless file materialization policy. Setting
this key to true causes dataless files to be materialized. Setting this key to
false causes dataless files to not be materialized. ... See `setiopolicy_np(3)`."

Relevance to Orbit is narrow but real: set it to **false** so that an agent
browsing the filesystem never triggers an iCloud Drive or Optimised Storage
download of evicted files. That is a bandwidth and disk-space protection for the
person, not a CPU or memory budget. It is also a good defensive default because
materialisation can block for a long time on a network fetch.

Enforce? yes, for that one I/O behaviour. Tree? inherited as a process-scoped
iopolicy. Root? no.

### 3.5 What launchd cannot do

No launchd key expresses a pooled memory ceiling, a pooled process count, a CPU
rate cap, or a swap limit. `launchd.plist(5)` documents no such key in any macOS
13+ version, and `SMAppService` (macOS 13+, `ServiceManagement`) adds registration
and approval plumbing, not new resource keys.

One deployment caveat worth writing down because it touches the "nothing on the
person's screen" rule: in macOS 13+ a newly registered LaunchAgent surfaces in
System Settings > General > Login Items, and the OS posts a **"Background Items
Added"** user notification the first time it appears. That is a banner, not a TCC
prompt, and it does not block execution. It is still a visible artefact on the
person's screen. If that is unacceptable, do not install a LaunchAgent at all:
run the broker as a plain child of the terminal session and set the same limits
with `setrlimit` in code (section 2.5). Both routes give identical enforcement.

---

## 4. launchctl limit

`launchctl(1)`: "With no arguments, this command prints all the resource limits of
launchd as found via `getrlimit(2)`. When a given resource is specified, it prints
the limits for that resource. With a third argument, it sets both the hard and
soft limits to that value."

This mutates the limits of the **launchd domain**, which then become the
inherited defaults for everything subsequently launched in that domain. In the
system domain (`launchctl limit maxproc ...`) it requires root. In a user domain
its blast radius is the person's entire GUI session.

Verdict for Orbit: **do not use it.** It is a global side effect on a shared
domain, it is not scoped to our tree, and changing it is user-visible in a way
that outlives our process. Use per-process `setrlimit` or the agent plist.

---

## 5. taskpolicy(8) and the spawn attributes behind it

`taskpolicy(8)`: "uses the `setiopolicy_np(3)` and `setpriority(2)` APIs to
execute a program with altered I/O or scheduling policies. **All children of the
specified program also inherit these policies.**"

Useful flags, all non-root, all inherited by children:

- `-c utility|background|maintenance` sets a QoS clamp. Backed by
  `posix_spawnattr_set_qos_clamp_np` (declared in
  `libsyscall/wrappers/spawn/spawn_private.h`, `__API_AVAILABLE(macos(10.10))`).
  This is the strongest single knob we have for "be polite": a clamp ceilings the
  QoS of every thread in the task, so even a thread that requests
  `USER_INTERACTIVE` is scheduled at the clamp.
- `-b` sets `PRIO_DARWIN_BG` via `setpriority(2)`: background scheduling plus
  throttled disk and network.
- `-d throttle` and `-g throttle` set the disk iopolicy for the process scope and
  the Darwin-background scope, via `setiopolicy_np(3)`.
- `-t` throughput tier and `-l` latency tier.

Flags that look like budgets but are not usable as such:

- **`-m limit`**, documented as "Run the program with specified memory limit (in
  MiB)". Implementation, from `system_cmds/taskpolicy/taskpolicy.c`:

  ```c
  if (set_memlimit) flags |= (POSIX_SPAWN_JETSAM_MEMLIMIT_ACTIVE_FATAL |
                              POSIX_SPAWN_JETSAM_MEMLIMIT_INACTIVE_FATAL);
  ret = posix_spawnattr_setjetsam_ext(&attr, flags, jetsam_priority, memlimit_mb, memlimit_mb);
  ```

  This sets a per-task jetsam phys_footprint limit that the kernel enforces in
  `bsd/kern/kern_memorystatus.c`:

  ```c
  void memorystatus_on_ledger_footprint_exceeded(boolean_t warning, boolean_t memlimit_is_active, boolean_t memlimit_is_fatal)
  {
      ...
      if (memlimit_is_fatal) {
              jetsam_reason = os_reason_create(OS_REASON_JETSAM, JETSAM_REASON_MEMORY_PERPROCESSLIMIT);
              ...
              memstat_kill_process_sync(proc_getpid(p), kMemorystatusKilledPerProcessLimit, jetsam_reason);
      }
  }
  ```

  Two hard problems. First, it is set at `posix_spawn` time on that one task and
  is **not inherited**: `forkproc()` explicitly zeroes the child's memstat state
  (`child_proc->p_memstat_memlimit = 0; child_proc->p_memstat_memlimit_active = 0;
  child_proc->p_memstat_memlimit_inactive = 0;`). A Chromium browser process
  launched under `taskpolicy -m 2048` will fork renderers with no limit at all.
  Second, it is still per process, so N processes times the limit, never a pool.

  It is nonetheless the only **hard, kernel-enforced, phys_footprint-based**
  memory kill available without root, and phys_footprint is the number Activity
  Monitor shows as "Memory". If you want a genuine per-process footprint ceiling,
  this is it, applied individually to each process you spawn yourself.

- `-P kill|throttle|suspend` sets `psa_pcontrol`, the action taken "by the system
  upon resource exhaustion". `kern_exec.c` maps this to `P_PCKILL`, `P_PCTHROTTLE`,
  `P_PCSUSP`. This is the low-swap / process-control path, not a budget you set.

### 5.1 posix_spawnattr_setprocesspolicy

There is **no** `posix_spawnattr_setprocesspolicy` in any Apple header on
opensource.apple.com. I grepped `bsd/sys/spawn.h`, `bsd/sys/spawn_internal.h`,
and `libsyscall/wrappers/spawn/spawn_private.h` on xnu `main`. The name does not
appear. The real, private-but-present spawn attribute setters are:

```c
int posix_spawnattr_setprocesstype_np(posix_spawnattr_t *, const int);            /* macos(10.8)  */
int posix_spawnattr_set_qos_clamp_np(const posix_spawnattr_t * __restrict, uint64_t); /* macos(10.10) */
int posix_spawnattr_set_darwin_role_np(const posix_spawnattr_t * __restrict, uint64_t); /* macos(10.11) */
int posix_spawnattr_setjetsam_ext(posix_spawnattr_t * __restrict, short, int, int, int);
int posix_spawnattr_setpcontrol_np(posix_spawnattr_t * __restrict, const int);
```

All are declared in `spawn_private.h`, which is **not** shipped in the macOS SDK.
The symbols exist in `libSystem` and are reachable by `dlsym`, but they are SPI:
Apple may change or remove them without notice, and a binary that depends on them
can break on a point release. If you use them, probe with `dlsym` and degrade
gracefully when the symbol is absent.

For Orbit the pragmatic choice is to shell out to `/usr/bin/taskpolicy`, which is
a shipped, documented, man-paged binary that does exactly this work for you, and
to accept the one extra exec per spawn.

```ts
// Polite by construction: background QoS clamp plus throttled disk, inherited by all children.
Bun.spawn(["/usr/bin/taskpolicy", "-c", "background", "-d", "throttle", "-b", "--", ...argv]);
```

---

## 6. App Sandbox, sandbox-exec, and Jetsam

### 6.1 App Sandbox

The App Sandbox is an **access control** mechanism: file paths, Mach services,
network, device access, via entitlements on a signed app bundle. It has no
resource-quantity vocabulary at all. There is no CPU, memory, process count, or
swap primitive in the sandbox profile language. Chromium's own
`sandbox/mac/seatbelt_sandbox_design.md` describes the V2 sandbox purely in terms
of resource *access* enumeration and the removal of the unsandboxed warmup phase;
it contains no resource-quantity limits, because the platform offers none.

`sandbox-exec(1)` is marked **DEPRECATED** in its own man page. Do not build on it.

Additionally, adopting App Sandbox requires a signed, entitled bundle, which
collides with the "no signed installer" constraint, and several sandbox
extensions are exactly the things that trigger TCC prompts. Out of scope.

### 6.2 Jetsam / memorystatus

`memorystatus_control` is syscall 440
(`bsd/kern/syscalls.master`: `{ int memorystatus_control(uint32_t command,
int32_t pid, uint32_t flags, user_addr_t buffer, size_t buffersize); }`).

Every interesting command is gated. `bsd/kern/kern_memorystatus.c`:

```c
/* Need to be root or have entitlement. */
if (!kauth_cred_issuser(kauth_cred_get()) &&
    !IOCurrentTaskHasEntitlement(MEMORYSTATUS_ENTITLEMENT) && !skip_auth_check) {
        error = EPERM;
        goto out;
}
```

`skip_auth_check` is true only for `MEMORYSTATUS_CMD_SET_PROCESS_IS_FREEZABLE`,
`..._GET_PROCESS_IS_FREEZABLE`, `..._GET_PROCESS_IS_FROZEN`, plus two commands
unlocked on `DEVELOPMENT || DEBUG` kernels only. So
`MEMORYSTATUS_CMD_SET_JETSAM_TASK_LIMIT`, `..._SET_MEMLIMIT_PROPERTIES`,
`..._GET_JETSAM_SNAPSHOT`, `..._GET_PRIORITY_LIST` are all **root or private
entitlement**. Unavailable to us.

Two further facts that matter:

- Several of the interesting commands are additionally inside `#if CONFIG_JETSAM`,
  and `config/MASTER.arm64.MacOSX` and `config/MASTER.x86_64` list
  `memorystatus` but **not** `jetsam` in `VM_BASE`, whereas
  `config/MASTER.arm64` (the embedded arm64 config) does list `jetsam`. So on a
  Mac, even with root, the classic jetsam commands are compiled out; the
  per-process fatal footprint limit set at spawn (section 5) still works because
  it lives on the `CONFIG_MEMORYSTATUS` path, not the `CONFIG_JETSAM` path.
- `memorystatus_get_level` (syscall 453) is ungated and just copies out
  `memorystatus_level`, a system-wide pressure percentage. `memorystatus_available_memory`
  (syscall 534) is likewise ungated. Both are **host-scope measurements**, useful
  as a "the machine is under pressure, back off" signal, useless as a per-session
  budget.

The sysctls `kern.memorystatus_*` are similarly write-gated:
`error = priv_check_cred(kauth_cred_get(), PRIV_VM_JETSAM, 0);` with the comment
"Writers must be root or have the `com.apple.private.kernel.jetsam` entitlement".
Read access to a few of them exists but gives host-wide state.

**Conclusion: Jetsam is not a budget mechanism for third-party code on macOS.**
The only piece of it we can reach is the per-task fatal footprint limit set at
spawn time via `posix_spawnattr_setjetsam_ext` / `taskpolicy -m`, per process,
not inherited.

---

## 7. Coalitions: the only shared-pool MEASUREMENT on the platform

This is the most useful under-documented finding in this report, so it gets its
own section. It is **measurement only**, it is **private SPI**, and it is
genuinely tree-wide.

### 7.1 What the kernel aggregates

`osfmk/mach/coalition.h` defines:

```c
struct coalition_resource_usage {
        uint64_t tasks_started;
        uint64_t tasks_exited;
        uint64_t time_nonempty;
        uint64_t cpu_time;                  /* mach_absolute_time units */
        uint64_t interrupt_wakeups;
        uint64_t platform_idle_wakeups;
        uint64_t bytesread;
        uint64_t byteswritten;
        uint64_t gpu_time;                  /* nanoseconds */
        uint64_t cpu_time_billed_to_me;
        uint64_t cpu_time_billed_to_others;
        uint64_t energy;                    /* nanojoules */
        ... 
        uint64_t cpu_instructions;
        uint64_t cpu_cycles;
        ...
        uint64_t phys_footprint;            /* Sum of instantaneous process phys_footprint */
        ...
        uint64_t swapins;
};
```

`phys_footprint` is documented in the header as "Sum of instantaneous process
phys_footprint" across every task in the coalition, and `cpu_time` is the summed
CPU time. `tasks_started` minus `tasks_exited` is a live task count. `swapins` is
a coalition-scoped swap-in counter, the closest thing to per-tree swap accounting
that exists anywhere in the system.

That is, structurally, exactly the counter set that `cpu.stat`,
`memory.current` and `pids.current` provide on Linux, and it already exists for
every process tree launchd starts.

### 7.2 What we can and cannot call

- `coalition_create` (`coalition()` syscall 458): **blocked**, needs a privileged
  coalition. See section 0.
- `coalition_info(COALITION_INFO_RESOURCE_USAGE, &cid, buf, &sz)` (syscall 459):
  the kernel implementation in `bsd/kern/sys_coalition.c` has **no credential
  check** on the read path. The source literally carries the comment:

  ```c
  coal = coalition_find_by_id(cid);
  if (coal == COALITION_NULL) return ESRCH;
  /* TODO: priv check? EPERM or ESRCH? */
  ```

  Labelled honestly: **this is an absence of a check in the current source, not an
  Apple guarantee.** The comment shows Apple considers adding one. Any Orbit code
  that depends on this must treat failure as normal and fall back to section 8.
- `coalition_ledger` (syscall 532): root only, and only a disk-write limit.
- `sys_coalition_policy_set` / `_get` (556/557): `COALITION_POLICY_ENTITLEMENT`.

### 7.3 Finding the coalition id for a pid

`bsd/sys/proc_info_private.h`:

```c
struct proc_pidcoalitioninfo {
        uint64_t coalition_id[COALITION_NUM_TYPES];   /* COALITION_NUM_TYPES == 2 */
        ...
};
#define PROC_PIDCOALITIONINFO       20
#define PROC_PIDCOALITIONINFO_SIZE  (sizeof(struct proc_pidcoalitioninfo))
```

`proc_pidinfo()` itself is a **public** libproc symbol
(`libproc.h`, `__OSX_AVAILABLE_STARTING(__MAC_10_5, ...)`), so only the flavor
constant is private. `COALITION_TYPE_RESOURCE` is index 0,
`COALITION_TYPE_JETSAM` is index 1.

`proc_listcoalitions(int flavor, int coaltype, void *buffer, int buffersize)` is
declared in `libproc_internal.h` (`__OSX_AVAILABLE_STARTING(__MAC_10_11, ...)`)
and is SPI.

### 7.4 FFI sketch, with the required guardrails

```ts
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

// proc_pidinfo is public API. The flavor number 20 is private.
const libproc = dlopen(`libSystem.B.${suffix}`, {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

const PROC_PIDCOALITIONINFO = 20;

function resourceCoalitionId(pid: number): bigint | null {
  const buf = new BigUint64Array(8);           // over-allocated on purpose
  const n = libproc.symbols.proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0n, ptr(buf), buf.byteLength);
  if (n <= 0) return null;
  return buf[0];                               // coalition_id[COALITION_TYPE_RESOURCE]
}
```

Reading the usage needs the `coalition_info_resource_usage` wrapper, which lives
in libsyscall (`libsyscall/wrappers/coalition.c`) but is not declared in any SDK
header:

```c
int coalition_info_resource_usage(uint64_t cid, struct coalition_resource_usage *cru, size_t sz);
```

```ts
// SPI. Probe, never assume. Fall back to per-pid summation when absent.
let coalUsage: ((cid: bigint, buf: Uint8Array) => number) | null = null;
try {
  const lib = dlopen(`libSystem.B.${suffix}`, {
    coalition_info_resource_usage: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32,
    },
  });
  coalUsage = (cid, buf) => lib.symbols.coalition_info_resource_usage(cid, ptr(buf), BigInt(buf.byteLength));
} catch { coalUsage = null; }
```

Offsets into `struct coalition_resource_usage` are **not stable across OS
versions**: the struct has grown repeatedly (`conclave_mem`, `ane_mach_time`,
`gpu_energy_nj*` and `swapins` are recent additions, appended at the tail). Read
only the leading fields whose position has been stable since macOS 13:
`tasks_started` (offset 0), `tasks_exited` (8), `time_nonempty` (16), `cpu_time`
(24). Do **not** hardcode the offset of `phys_footprint`; it moves. If you need
tree footprint, sum `ri_phys_footprint` per pid (section 8), which is version
stable.

`cpu_time` is in `mach_absolute_time` units. Convert with
`mach_timebase_info(&tb)` and `ns = ticks * tb.numer / tb.denom`. On Apple
silicon `numer/denom` is not 1/1, so the conversion is mandatory.

### 7.5 Verdict

Enforce? **no, never.** Tree? **yes, genuinely shared.** Root? no, but private
SPI with an explicit "TODO: priv check?" in the source. Cannot bound anything.

Use it as a **cross-check** on the userland accounting loop, and as a way to catch
descendants that escaped `proc_listchildpids` (section 8.3). Never as the primary
source of truth, and never as a gate on its own.

---

## 8. Per-process measurement: the reliable path

### 8.1 proc_pid_rusage

`libproc.h`:

```c
int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer)
        __OSX_AVAILABLE_STARTING(__MAC_10_9, __IPHONE_7_0);
```

`bsd/sys/resource.h`:

```
RUSAGE_INFO_V0 0 ... RUSAGE_INFO_V4 4, RUSAGE_INFO_V5 5, RUSAGE_INFO_V6 6
#define RUSAGE_INFO_CURRENT RUSAGE_INFO_V6
```

Permission: `proc_pid_rusage` in `bsd/kern/proc_info.c` calls
`proc_security_policy(p, PROC_INFO_CALL_PIDRUSAGE, flavor, CHECK_SAME_USER)`.
Same UID is sufficient, **no root, no task port, no TCC prompt**. This is the
workhorse.

Field layout, `struct rusage_info_v4` (stable prefix shared by V0 through V6):

| offset | field | note |
|---|---|---|
| 0 | `uint8_t ri_uuid[16]` | |
| 16 | `ri_user_time` | nanoseconds |
| 24 | `ri_system_time` | nanoseconds |
| 32 | `ri_pkg_idle_wkups` | |
| 40 | `ri_interrupt_wkups` | |
| 48 | `ri_pageins` | |
| 56 | `ri_wired_size` | |
| 64 | `ri_resident_size` | |
| 72 | `ri_phys_footprint` | **the "Memory" column in Activity Monitor** |
| 80 | `ri_proc_start_abstime` | mach abs |
| 88 | `ri_proc_exit_abstime` | |
| 96 | `ri_child_user_time` | reaped children only |
| 104 | `ri_child_system_time` | reaped children only |

Units of `ri_user_time` and `ri_system_time`: **nanoseconds, not mach ticks.**
Evidence chain: `bsd/kern/kern_resource.c` `gather_rusage_info()` calls
`fill_task_rusage()`, which in `osfmk/kern/bsd_kern.c` does

```c
task_power_info_locked(task, &powerinfo, NULL, NULL, &extra);
ri->ri_user_time = powerinfo.total_user;
ri->ri_system_time = powerinfo.total_system;
```

and `task_power_info_locked` in `osfmk/kern/task.c` fills `total_user` from the
recount metrics converted to nanoseconds. (This differs from
`TASK_ABSOLUTETIME_INFO` and from `coalition_resource_usage.cpu_time`, which are
in mach_absolute_time units. Getting this wrong by the timebase ratio is the
classic Apple-silicon CPU-accounting bug.)

`ri_phys_footprint` is the right memory number for a budget. It is what the
kernel's own ledger enforces against in `memorystatus_on_ledger_footprint_exceeded`,
so a userland budget expressed in `ri_phys_footprint` is directly comparable to
the per-process fatal limit from section 5. Unlike RSS it does not double-count
shared clean pages, and it does include IOKit mappings and the compressed
footprint, which matters a lot for Chromium.

```ts
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const lp = dlopen(`libSystem.B.${suffix}`, {
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});

const RUSAGE_INFO_V4 = 4;

export interface ProcUsage { cpuNs: bigint; footprint: bigint; pageins: bigint; }

export function procUsage(pid: number): ProcUsage | null {
  const buf = new ArrayBuffer(512);            // >= sizeof(rusage_info_v6); kernel writes only the V4 prefix
  if (lp.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buf)) !== 0) return null;  // ESRCH on race
  const u = new BigUint64Array(buf, 16);       // skip ri_uuid[16]
  return {
    cpuNs:     u[0] + u[1],                    // ri_user_time + ri_system_time, nanoseconds
    footprint: u[7],                           // ri_phys_footprint, bytes
    pageins:   u[4],                           // ri_pageins
  };
}
```

Always pass a buffer sized for the newest flavor even when requesting an older
one: `proc_get_rusage` in the kernel copies out `size` bytes chosen by flavor, so
an over-sized buffer is safe and an under-sized one is a corruption bug waiting
for the next OS release.

### 8.2 Thread and process counts

`proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, sizeof ti)`, `PROC_PIDTASKINFO == 4`,
public API. `struct proc_taskinfo` (`bsd/sys/proc_info.h`):

```c
struct proc_taskinfo {
        uint64_t pti_virtual_size;
        uint64_t pti_resident_size;
        uint64_t pti_total_user;       /* mach ticks */
        uint64_t pti_total_system;
        uint64_t pti_threads_user;
        uint64_t pti_threads_system;
        int32_t  pti_policy;
        int32_t  pti_faults;
        int32_t  pti_pageins;
        int32_t  pti_cow_faults;
        int32_t  pti_messages_sent;
        int32_t  pti_messages_received;
        int32_t  pti_syscalls_mach;
        int32_t  pti_syscalls_unix;
        int32_t  pti_csw;
        int32_t  pti_threadnum;        /* number of threads in the task */
        int32_t  pti_numrunning;
        int32_t  pti_priority;
};
```

`pti_threadnum` is the only way to count threads per process without a task port.
Note `pti_total_user` here **is** in mach ticks, unlike `ri_user_time`. Two
adjacent APIs, two different units; annotate every variable.

There is no `RLIMIT_NTHREADS` on Darwin and no per-process thread cap reachable
without root. Thread count is measurable and unbounded.

### 8.3 Tree enumeration

`libproc.h`, all public:

```c
int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize);
int proc_listallpids(void *buffer, int buffersize);
int proc_listchildpids(pid_t ppid, void *buffer, int buffersize);
int proc_listpgrppids(pid_t pgrpid, void *buffer, int buffersize);
```

`proc_listpids` types, `bsd/sys/proc_info.h`: `PROC_ALL_PIDS 1`,
`PROC_PGRP_ONLY 2`, `PROC_UID_ONLY 4`, `PROC_RUID_ONLY 5`, `PROC_PPID_ONLY 6`.

`proc_listchildpids` returns **direct children only**. Walking a tree means
recursing, which is racy: a grandchild whose parent exits gets reparented to
launchd (pid 1) and disappears from the walk while still holding memory. Two
mitigations, use both:

1. Put the session in its own **process group** with `setsid()` or `setpgid()` in
   the child, then enumerate with `proc_listpgrppids`. A process group survives
   the death of intermediate parents, so reparented grandchildren stay visible,
   and `killpg(2)` reaches them all. This is macOS's nearest analogue to a cgroup
   membership set. It is still escapable: a descendant can call `setsid()` itself
   and leave the group.
2. Cross-check against the resource coalition id (section 7.3): every descendant
   inherits the coalition of its parent and cannot leave it, so
   `resourceCoalitionId(pid) === sessionCoalitionId` is a membership test that
   `setsid()` cannot defeat. Because it is SPI, treat a mismatch or a failure as
   "unknown", not as "not ours".

```ts
const lp2 = dlopen(`libSystem.B.${suffix}`, {
  proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

export function pidsInGroup(pgid: number): number[] {
  let cap = 256;
  for (;;) {
    const buf = new Int32Array(cap);
    const bytes = lp2.symbols.proc_listpgrppids(pgid, ptr(buf), buf.byteLength);
    if (bytes < 0) return [];
    const n = bytes / 4;
    if (n < cap) return Array.from(buf.subarray(0, n)).filter((p) => p > 0);
    cap *= 2;                                   // buffer was full: could have truncated
  }
}
```

### 8.4 getrusage(RUSAGE_CHILDREN)

`getrusage(2)`. `bsd/kern/kern_resource.c`:

```c
case RUSAGE_CHILDREN:
        proc_lock(p);
        rup = &p->p_stats->p_cru;
        rubuf = *rup;
        proc_unlock(p);
        break;
```

`p_cru` is accumulated in `update_rusage_info_child()` at child exit. Therefore
`RUSAGE_CHILDREN` reports **only descendants that have already exited and been
reaped by us**. It reports nothing about the twelve Chromium processes currently
burning CPU. It is useless for live budgeting and mildly useful for a
post-session total, and even then only for children the supervisor itself
reaped, which excludes anything re-parented to launchd.

### 8.5 task_info and TASK_BASIC_INFO

`task_info(task_t, TASK_BASIC_INFO_64, ...)` gives `virtual_size`,
`resident_size`, `user_time`, `system_time`. To call it on another process you
need its task port from `task_for_pid()`.

`task_for_pid` permission, `bsd/kern/kern_proc.c`, `task_for_pid_posix_check()`:
non-root callers pass only if the target's real, effective and saved uids all
equal the caller's euid, the target's group set is a subset of the caller's, and
the target has not switched credentials; plus a `mac_proc_check_get_task()` hook
and, if the target set a task access port, an upcall to `taskgated`.

In practice, on a stock Mac, a non-root process calling `task_for_pid` on another
user process it did not spawn is where debugging-authorisation dialogs come from.
**That is a screen artefact, and it is exactly what we are forbidden from
causing.** Since `proc_pid_rusage` and `proc_pidinfo` give strictly more useful
numbers (`ri_phys_footprint` beats `resident_size`) with only a same-UID check
and no task port, **do not use `task_for_pid` at all.** Reach for
`mach_task_self()` and `task_info` only for the supervisor's own process.

### 8.6 Host-level counters

```c
kern_return_t host_statistics64(host_t, host_flavor_t, host_info64_t, mach_msg_type_number_t *);
#define HOST_VM_INFO64 4     /* osfmk/mach/host_info.h */
```

`vm_statistics64_data_t` carries `free_count`, `active_count`, `inactive_count`,
`wire_count`, `compressor_page_count`, `swapins`, `swapouts`, `decompressions`.
No credential required. Host scope only.

Swap, system-wide, `sysctlbyname("vm.swapusage", ...)`, `bsd/sys/sysctl.h`:

```c
struct xsw_usage {
        u_int64_t xsu_total;
        u_int64_t xsu_avail;
        u_int64_t xsu_used;
        u_int32_t xsu_pagesize;
        boolean_t xsu_encrypted;
};
```

Also ungated: `memorystatus_get_level` (syscall 453) and
`memorystatus_available_memory` (syscall 534).

---

## 9. Swap: state it as unbounded, like the Windows port did

There is no per-process, per-tree, per-user swap limit on macOS. There is no
equivalent of `memory.swap.max`. There is not even a reliable per-process swap
measurement:

- `struct rusage.ru_nswap` is marked `(NU)` (not used) in `bsd/sys/resource.h`.
- `ri_pageins` counts page-ins, which conflates file-backed faults with
  decompression and swap reads.
- `coalition_resource_usage.swapins` is coalition-scoped and is the only
  tree-shaped swap counter, but it is SPI (section 7) and counts swap-ins only,
  never current swap residency.
- `vm.swapusage` and `host_statistics64` give host totals with no attribution.

Compounding this: on macOS most "swap" pressure is absorbed first by the
**compressor**, so a tree can be consuming a large amount of physical memory that
shows up as `compressor_page_count` rather than as swap at all, and
`ri_phys_footprint` already includes the compressed footprint of the task.

**Recommended contract wording, mirroring the Windows port's honesty:**
`swap: unbounded (macOS provides no per-process or per-tree swap limit; host swap
is observable via vm.swapusage only)`.

Same for threads: `threads: unbounded (measured via PROC_PIDTASKINFO
pti_threadnum; macOS has no per-process thread limit reachable without root)`.

---

## 10. What each mechanism CANNOT bound, collected

- `RLIMIT_AS` / `RLIMIT_DATA`: cannot bound resident or physical footprint;
  cannot pool across processes; cannot be lowered below current usage; will
  break Chromium if sized like an RSS budget.
- `RLIMIT_CPU`: cannot express a rate; resets per process; no pooling.
- `RLIMIT_NPROC`: cannot be scoped to our tree; hits the person's other apps.
- `RLIMIT_NOFILE`: bounds descriptors only; capped by `kern.maxfilesperproc`.
- launchd `ProcessType`/`Nice`/`LowPriorityIO`: cannot bound anything
  quantitatively; only reorder and throttle.
- `taskpolicy -c/-b/-d`: same; a clamped background task still reaches 100% CPU
  on an idle machine.
- `taskpolicy -m` / `posix_spawnattr_setjetsam_ext`: per process, not inherited
  across fork, no pooling, no CPU, no swap, no thread count.
- `proc_setcpu_percentage` and friends: per process; on macOS
  `handle_cpuuse()` contains `if ((action == PROC_POLICY_ACTION_APPLY || action ==
  PROC_POLICY_ACTION_RESTORE) && curp != proc) return EPERM;` with the comment
  "On macOS, tasks can only set and clear their own CPU limits", so we can only
  apply it to ourselves, not to a spawned Chromium; and it is private SPI.
- `memorystatus_control`: unavailable without root or a private entitlement.
- App Sandbox: no resource-quantity vocabulary whatsoever.
- Coalitions: measurement only for us; creation and capping are entitlement-gated.
- `getrusage(RUSAGE_CHILDREN)`: blind to living processes.
- `task_for_pid`: risks an on-screen authorisation prompt; adds nothing over
  `proc_pid_rusage`.

---

## 11. Recommended macOS implementation of the Orbit contract

Layer the mechanisms; each one is honest about what it does.

**Spawn-time, per process, kernel-enforced:**

1. Supervisor calls `setrlimit(RLIMIT_AS, generous)` and
   `setrlimit(RLIMIT_NOFILE, n)` before spawning; children inherit through fork
   and exec.
2. Spawn each session leader through
   `/usr/bin/taskpolicy -c background -d throttle -b -- <cmd>` so the whole
   subtree inherits background QoS and throttled disk I/O.
3. Optionally add `-m <MiB>` to give the session leader a hard, kernel-enforced
   phys_footprint kill. State clearly in the docs that this applies to that one
   process, not its children.
4. Child calls `setsid()` so the session owns a process group.

**Session-lifetime, userland-enforced (section 12):**

5. Sampling loop over the process group; admission control on new work; kill the
   group when the pool is exceeded.

**Cleanup, the `KILL_ON_JOB_CLOSE` analogue:**

6. macOS has no kill-on-close. The nearest equivalents are `killpg(pgid, SIGKILL)`
   from an `atexit` / signal handler, plus a launchd agent with `KeepAlive` that
   reaps orphans, plus a watchdog that kills any pid still in the session
   coalition after the supervisor dies. All of these are userland and all can be
   defeated by a process that `setsid()`s away. Declare
   `kill_on_close: best effort`.

---

## 12. The honest fallback: a userland accounting loop

Since no shared pool can be enforced, implement the pool in userland and be
explicit about the gap.

```ts
// Poll at a fixed cadence. 500ms to 1s is a reasonable compromise:
// proc_pid_rusage over ~30 pids costs well under a millisecond.
interface Budget { footprintBytes: bigint; cpuNsPerSec: bigint; maxProcs: number; }

interface Sample { pids: number[]; footprint: bigint; cpuNs: bigint; threads: number; at: number; }

function sampleGroup(pgid: number): Sample {
  const pids = pidsInGroup(pgid);
  let footprint = 0n, cpuNs = 0n, threads = 0;
  for (const pid of pids) {
    const u = procUsage(pid);                    // null when the pid died mid-walk: skip, do not throw
    if (!u) continue;
    footprint += u.footprint;
    cpuNs     += u.cpuNs;
    threads   += threadCount(pid) ?? 0;
  }
  return { pids, footprint, cpuNs, threads, at: Date.now() };
}

// Admission control: refuse NEW work when the pool is already over budget.
function mayStartWork(s: Sample, b: Budget): boolean {
  return s.footprint < b.footprintBytes && s.pids.length < b.maxProcs;
}

// Enforcement of last resort: the whole group, not a single pid.
function enforce(prev: Sample, cur: Sample, b: Budget, pgid: number): void {
  const dtSec = (cur.at - prev.at) / 1000;
  const cpuRate = Number(cur.cpuNs - prev.cpuNs) / dtSec;      // ns of CPU per second of wall time
  if (cur.footprint > b.footprintBytes || BigInt(Math.round(cpuRate)) > b.cpuNsPerSec) {
    process.kill(-pgid, "SIGKILL");                            // negative pid == process group
  }
}
```

Report the pool state to the user with the same field names as the Linux and
Windows backends, so the contract reads identically across platforms, and mark
enforcement strength per field:

```
cpu:     enforced=advisory  (sampled, kill on sustained breach; QoS clamp applied)
memory:  enforced=advisory  (sampled phys_footprint sum; per-process RLIMIT_AS backstop)
procs:   enforced=advisory  (sampled count; admission control only)
threads: unbounded          (measured)
swap:    unbounded          (host-level observation only)
```

### What this loop does NOT prevent

Write these down in the product docs; they are the price of having no cgroup.

1. **Overshoot between samples.** A process can allocate many gigabytes inside one
   polling interval. The kernel learns about it; we learn about it up to one
   interval later. On a machine already near its memory limit that interval is
   enough for the system-wide compressor and swap to start hurting the person's
   foreground apps. Shortening the interval reduces but never removes this.
2. **No back-pressure, only death.** A cgroup slows an over-budget process by
   refusing allocations; our loop can only watch and then kill. There is no
   graceful "allocation fails with ENOMEM at the pool boundary" behaviour, so
   there is no chance for the application to recover.
3. **Escape by `setsid()`.** A descendant that creates its own session leaves the
   process group and stops being enumerated by `proc_listpgrppids`. The coalition
   cross-check (section 7.3) catches this, but it is SPI and may stop working.
4. **Escape by re-parenting.** If the supervisor dies unexpectedly, descendants are
   re-parented to launchd and nothing kills them. There is no
   `KILL_ON_JOB_CLOSE`. A separate watchdog helps and is itself killable.
5. **Escape by launching through a system service.** A process that asks launchd,
   `open(1)`, or an XPC service to start something gets a process outside our
   group and outside our coalition, started by launchd, which we never see. This
   is the macOS analogue of a container escape via the service manager and it is
   not closeable without an entitlement.
6. **Nothing bounds swap or the compressor.** Even a perfectly enforced footprint
   budget does not stop the tree from pushing the person's foreground applications
   into the compressor, because the budget is per-tree and the pressure is global.
7. **Nothing bounds threads, file descriptors across the tree, GPU time, or disk
   bandwidth in aggregate.** `RLIMIT_NOFILE` is per process;
   `coalition_ledger_set_logical_writes_limit` is root only.
8. **Accounting is approximate.** Summing `ri_phys_footprint` over a tree
   double-counts nothing by design, but it also does not attribute shared IOKit
   and GPU mappings the way a cgroup's `memory.current` does, and the
   sum can drift from `coalition_resource_usage.phys_footprint`.
9. **Killing the group is not graceful.** `SIGKILL` to a process group leaves
   browser profile directories, lock files, and shared memory segments behind.
   Send `SIGTERM` first with a short grace period, then `SIGKILL`, and make the
   session directory disposable.

---

## 13. Primary sources

XNU source, `github.com/apple-oss-distributions/xnu` (the current mirror of
opensource.apple.com), branch `main` unless a tag is named:

- `bsd/sys/resource.h`: `RLIMIT_*` numbers, `struct rlimit`, `RUSAGE_INFO_V0..V6`,
  `struct rusage_info_v0..v6`, `RLIMIT_WAKEUPS_MONITOR`, `RLIMIT_CPU_USAGE_MONITOR`,
  `RLIMIT_THREAD_CPULIMITS`, `RLIMIT_FOOTPRINT_INTERVAL`.
- `bsd/kern/kern_resource.c`: `dosetrlimit()` cases for `RLIMIT_CPU`,
  `RLIMIT_DATA`, `RLIMIT_AS`, `RLIMIT_NPROC`; `proc_rlimit_control()`;
  `getrusage()` `RUSAGE_CHILDREN`; `gather_rusage_info()`; `proc_get_rusage()`;
  `update_rusage_info_child()`.
- Tag comparison for the `RLIMIT_AS` question: `xnu-7195.141.2` (absent),
  `xnu-8020.140.41`, `xnu-8792.81.2`, `xnu-10002.1.13`, `xnu-11215.1.10` (present).
- `osfmk/vm/vm_map.c`: `vm_map_set_size_limit()`, `vm_map_set_data_limit()`, and
  the `RLIMIT_AS` / `RLIMIT_DATA` check at the end of `vm_map_enter()`.
- `bsd/kern/kern_fork.c`: `chgproccnt()` and the `RLIMIT_NPROC` `EAGAIN` path;
  `proc_limitfork()`; the memstat zeroing in `forkproc()`.
- `bsd/kern/kern_exec.c`: `vm_map_set_size_limit(map, proc_limitgetcur(p, RLIMIT_AS))`;
  the `POSIX_SPAWN_JETSAM_SET` handling; the `COALITION_SPAWN_ENTITLEMENT` check.
- `bsd/kern/kern_memorystatus.c`: the `memorystatus_control()` root-or-entitlement
  gate; `memorystatus_on_ledger_footprint_exceeded()`;
  `priv_check_cred(..., PRIV_VM_JETSAM, 0)` on the sysctl writers.
- `bsd/sys/kern_memorystatus.h`: the `MEMORYSTATUS_CMD_*` table.
- `bsd/kern/sys_coalition.c`: `coalition()` gated on
  `task_is_in_privileged_coalition()`; `coalition_info()` with no credential check
  and the "TODO: priv check?" comment; `coalition_ledger()` gated on
  `kauth_cred_issuser`; `sys_coalition_policy_set/get` gated on
  `COALITION_POLICY_ENTITLEMENT`.
- `osfmk/kern/coalition.c`: `task_is_in_privileged_coalition()`,
  `unrestrict_coalition_syscalls` (a `DEBUG || DEVELOPMENT`-only tunable, defined
  as `false` on release kernels).
- `osfmk/mach/coalition.h`: `struct coalition_resource_usage`,
  `COALITION_SPAWN_ENTITLEMENT`, `COALITION_INFO_*`, `COALITION_TYPE_*`.
- `libsyscall/wrappers/coalition.c`: `coalition_info_resource_usage()` wrapper.
- `bsd/kern/syscalls.master`: syscall numbers 323 `process_policy`,
  440 `memorystatus_control`, 446 `proc_rlimit_control`, 453 `memorystatus_get_level`,
  458 `coalition`, 459 `coalition_info`, 532 `coalition_ledger`,
  534 `memorystatus_available_memory`, 556/557 `coalition_policy_set/get`.
- `bsd/kern/process_policy.c`: `handle_cpuuse()` with the macOS-only
  "tasks can only set and clear their own CPU limits" restriction.
- `bsd/sys/process_policy.h`: `PROC_POLICY_RESOURCE_USAGE`, `PROC_POLICY_RUSAGE_CPU`,
  `PROC_POLICY_RSRCACT_*`, `proc_policy_cpuusage_attr_t`.
- `bsd/sys/proc_info.h`: `struct proc_taskinfo`, `PROC_PIDTASKINFO`,
  `PROC_ALL_PIDS` / `PROC_PGRP_ONLY` / `PROC_UID_ONLY` / `PROC_PPID_ONLY`.
- `bsd/sys/proc_info_private.h`: `struct proc_pidcoalitioninfo`,
  `PROC_PIDCOALITIONINFO` (20), `LISTCOALITIONS_*`.
- `bsd/kern/proc_info.c`: `proc_pid_rusage()` and its
  `proc_security_policy(..., CHECK_SAME_USER)` gate.
- `bsd/kern/kern_proc.c`: `task_for_pid_posix_check()` and `task_for_pid()`
  including the `taskgated` upcall.
- `osfmk/kern/bsd_kern.c`: `fill_task_rusage()` proving `ri_user_time` comes from
  `task_power_info.total_user` (nanoseconds).
- `osfmk/mach/task_info.h`: `struct task_basic_info_64`,
  `struct task_absolutetime_info` (mach units), `struct task_power_info`,
  `TASK_VM_INFO`.
- `osfmk/mach/host_info.h`: `HOST_VM_INFO64`, `vm_statistics64` revisions.
- `bsd/sys/sysctl.h`: `struct xsw_usage` for `vm.swapusage`.
- `config/MASTER`, `config/MASTER.arm64`, `config/MASTER.arm64.MacOSX`,
  `config/MASTER.x86_64`: `CONFIG_JETSAM` present in the embedded arm64 config and
  absent from both macOS configs.
- `libsyscall/wrappers/libproc/libproc.h`: `proc_pid_rusage`, `proc_pidinfo`,
  `proc_listpids`, `proc_listallpids`, `proc_listchildpids`, `proc_listpgrppids`.
- `libsyscall/wrappers/libproc/libproc_internal.h`: `proc_setcpu_percentage`,
  `proc_set_cpumon_params`, `proc_set_cpumon_params_fatal`, `proc_listcoalitions`.
- `libsyscall/wrappers/libproc/libproc.c`: implementations showing the
  `__process_policy` and `proc_rlimit_control(pid, RLIMIT_CPU_USAGE_MONITOR, ...)`
  call sequence.
- `libsyscall/wrappers/spawn/spawn_private.h`: `posix_spawnattr_setjetsam_ext`,
  `posix_spawnattr_set_qos_clamp_np`, `posix_spawnattr_setprocesstype_np`,
  `posix_spawnattr_set_darwin_role_np`. No `posix_spawnattr_setprocesspolicy`
  exists in any Apple header.
- `system_cmds/taskpolicy/taskpolicy.c`: what `-m`, `-c`, `-b`, `-P` actually call.

Man pages: `getrlimit(2)` and `setrlimit(2)`, `getrusage(2)`, `setpriority(2)`,
`setiopolicy_np(3)`, `sysctl(3)` and `sysctl(8)`, `launchd.plist(5)`,
`launchctl(1)`, `taskpolicy(8)`, `sandbox-exec(1)` (marked DEPRECATED),
`killpg(2)`, `setsid(2)`, `posix_spawn(2)`.

Apple developer documentation: `ServiceManagement` / `SMAppService` (macOS 13.0+),
`register()`, `Status`, `openSystemSettingsLoginItems()`, which is the supported
macOS 13+ route for registering a LaunchAgent from inside an app bundle and which
documents that registration is "subject to user approval".

Chromium: `sandbox/mac/seatbelt_sandbox_design.md` (Mac Sandbox V2 Design Doc,
status Final, last updated 2025-01-30), which describes the macOS sandbox purely
as resource-access enumeration and contains no resource-quantity limits.

### Labelling

Documented by Apple: everything cited from a man page, from an Apple developer
documentation page, and the behaviour of the plist keys in `launchd.plist(5)`.

Read from published Apple source but not documented as API: the `RLIMIT_AS`
enforcement path and its version history, the `RLIMIT_NPROC` per-UID semantics,
the memstat zeroing on fork, the `memorystatus_control` credential gate, the
coalition entitlement gates, and the nanosecond units of `ri_user_time`. These
are facts about shipping code, not promises; Apple can change them in a point
release.

Observed behaviour reported by third parties, treated as unverified here: the
widespread claim that "`ulimit -v` does nothing on macOS". That claim was correct
through macOS 11 and is **wrong for macOS 12 and later**, per the tag comparison
above. Do not repeat it.

Explicitly unverified in this report: no code in this document has been executed
on a Mac. Every FFI snippet is derived from headers and must be validated on both
Apple silicon and Intel, on the oldest supported OS (13.0) and the newest, before
it ships. In particular, verify the symbol availability of
`coalition_info_resource_usage` by `dlsym` on each OS version rather than assuming
it, and verify the struct offsets used in section 8.1 against a small C program
that prints `offsetof` on each target.
