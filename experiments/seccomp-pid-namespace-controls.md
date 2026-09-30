# Experimental private PID namespace

Measured on 30 September 2026. The process fixture and installed Loupe image
loading now pass under the private namespace. This route remains opt-in and
experimental. Personal accounts and complete isolation have not been measured.

## Mechanism and process evidence

`ORBIT_PRIVATE_BROKER_PID_NAMESPACE=1` makes the experimental launcher execute
its target through bubblewrap with a private PID namespace and a fresh `/proc`.
It requires private pair support. The parent broker remains outside that
namespace so it can handle its owned child's seccomp notifications. The target
retains the shared filesystem through a root bind. No network namespace or
filesystem access policy is added by this flag.

The generated process fixture observes the harness's own host PID only. It does
not inspect or signal any personal process. `kill(pid, 0)` checks reachability,
not a state-changing signal. The fixture also starts and terminates its own
sleep child and reads and rewrites its own generated file.

| Check | No namespace control | Private PID namespace |
| --- | --- | --- |
| Harness host PID in `/proc` | Visible | Absent |
| Signal-zero reachability of that host PID | Succeeds | ESRCH |
| `pidfd_open` of that host PID | Succeeds | ESRCH |
| Terminate own private child | Succeeds | Succeeds |
| Read and rewrite generated file | Succeeds | Succeeds |
| Visible process directories in final run | 957, a changing host count | 2 |
| Broker-created pair payload | `A` | `A` |
| Pair peer PID visible to target | Nonzero broker PID | 4, trusted factory creator |

The target PID was 2. The original host-created pair returned peer PID 0.
The corrected pair is created by a trusted helper inside the request's pinned
user and PID namespaces. Its peer PID is nonzero, but is the factory creator,
not the application. Both process fixture arms exited 0 with brokerFailure 0.
The helper does not enter the application's network namespace.

Reports:

- `output/seccomp-pid-controls-control-2026-09-30/report.json`
- `output/seccomp-pid-controls-2026-09-30/report.json`

## Private bus correction

The old private-bus credential check compared the supplied PID only with the
host `Tgid` from `/proc/<request>/status`. The namespaced application supplies
its namespace-local PID. The broker now validates it against the last kernel
`NStgid` entry and requires the first entry to match the host `Tgid`. UID and
GID checks, the exact one-byte handshake, registered bus cookie and one-shot
handshake limit are retained. Malformed, missing or truncated namespace TGID
metadata is denied. The parser does not treat an untrusted supplied PID as a
host process lookup key.

The [kernel proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [proc_pid_status manual](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)
describe this namespace TGID hierarchy. The broker still rewrites the forwarded
PID to its own PID. This corrects validation for the namespace case; it does
not supply transparent application process identity.

Before the correction the namespaced Loupe run forwarded zero bus credential
handshakes. After it, one credential handshake and five bus data messages were
forwarded. The existing non-namespaced GTK4 bus controls still accepted the
valid handshake and rejected wrong PID, UID, GID, payload, replay, oversized
payload and compositor credential/data cases. The GTK4 fixture also mapped,
accepted private keyboard input and loaded its generated texture.

## Image failure, reproduction and correction

Before the pair correction, namespaced Loupe mapped a window but showed
`Could not Load Image`. Its owned More Information dialog reported a D-Bus I/O
error with OS error -1000. Both sampled image colors failed. The application
exited 0 on window close, so the probe explicitly returns status 1 when a
namespace run's generated image colors fail. Mapping is not image success.

A minimal reproduction used the same Rustix 1.1.4 version pinned by Glycin
2.1.5, with the `net` feature and its unmodified upstream source. A host Python
process created a UNIX stream pair and passed one endpoint to a Rust reader:

```rust
use std::os::fd::BorrowedFd;
fn main() {
    let fd: i32 = std::env::args().nth(1).unwrap().parse().unwrap();
    let fd = unsafe { BorrowedFd::borrow_raw(fd) };
    match rustix::net::sockopt::socket_peercred(fd) {
        Ok(c) => println!("pid={} uid={}", c.pid.as_raw_pid(), c.uid.as_raw()),
        Err(e) => println!("error={} raw={}", std::io::Error::from(e), e.raw_os_error()),
    }
}
```

Outside bubblewrap, the reader returned a nonzero host peer PID and UID 1000.
Inside `bwrap --dev-bind / / --unshare-pid --proc /proc --`, it returned
`Unknown error -1000 (os error -1000)`. A separate C reader using libc in the
same namespace returned successful `SO_PEERCRED` with PID 0, and successful
`SO_PEERPIDFD`. Thus -1000 was reproduced in Rustix without a failing kernel
credential syscall or Loupe. Rustix's `UCred` represents PID as nonzero, while
its generic getter initializes that type directly from the kernel buffer.
The invalid zero conflicts with that representation. The exact compiler
layout that turns UID 1000 into error -1000 was not separately measured.
See the [Rustix 1.1.4 source](https://github.com/bytecodealliance/rustix/tree/v1.1.4/src).

A trusted factory now creates pairs inside the notification caller's pinned
user and PID namespaces. The broker validates the live notification before
namespace work, and the helper drops all descriptors above standard I/O except
its own channel and two namespace handles. After entering the user namespace,
it selects the PID namespace and forks the creator. The creator sends two FDs
to the broker through its own bounded channel and never executes application
code. The broker waits up to one second for that packet, then kills and reaps
its own helper group. Pair cookies, copied send validation and descriptor
injection remain mediated. Same-PID-namespace construction uses the original
host factory. No connect or send syscall is continued in application memory.

With the correction, installed Loupe loaded the generated 600 by 360 image.
Sampled RGB colors were `[24,179,75]` and `[25,76,230]`; five pairs carried
13 messages. One private bus credential handshake and five bus data messages
passed. The application exited normally with no forced stop or broker failure.
The existing non-namespaced Loupe image test also passed. No Glycin sandbox or
system package was disabled or patched.

The process fixture's new nonzero peer identity gate was run against a temporary
build with the old host pair factory. That negative arm returned PID 0 and
failed status 1. The corrected arm returned peer PID 4 and passed status 0.
The failed control is recorded before the assertion in
`output/seccomp-pid-controls-factory-control-2026-09-30/report.json`.

Artifacts:

- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/before.json`, before the earlier private bus correction
- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/report.json`, latest successful image run
- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/loupe.jpg`, latest generated image

## Commands and limits

```sh
ORBIT_PID_PAIR_FACTORY_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-pid-namespace-controls.ts
ORBIT_PID_NAMESPACE_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-pid-namespace-controls.ts
bun run scripts/limited.ts bun run experiments/seccomp-pid-namespace-controls.ts
ORBIT_PRIVATE_BROKER_PID_NAMESPACE=1 ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_LOOPBACK=1 ORBIT_LOUPE_BROKER_PAIRS=1 ORBIT_LOUPE_BROKER_DETAILS=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
```

The factory control intentionally fails status 1. The other commands pass,
including the namespaced Loupe image gate.
Current-account Nextcloud, terminal debugging, devices, namespace escape,
namespace descriptor receipt, alternative host proc mounts, ptrace behavior,
PID reuse races, deep namespace nesting and full application compatibility are
not measured. Root binding retains broad file and device authority; this is
not a complete sandbox. Private pair injection remains non-atomic and retains
factory peer identity, rather than application identity. Factory failure,
resource exhaustion, deep namespace ownership transitions and descriptor
cleanup under malformed factory responses need further evidence. Production launch behavior is unchanged.

Verification: process control and private-namespace fixtures
passed; the existing non-namespaced Loupe image colors still matched with normal
exit and no forced stop. Typecheck, compiler warnings-as-errors and diff check
passed. No full-suite or current-account result is claimed for this turn.
