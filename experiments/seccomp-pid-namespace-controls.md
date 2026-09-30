# Experimental private PID namespace

Measured on 30 September 2026. The process fixture passes; installed Loupe image
loading fails under the new namespace. This route must remain opt-in and is not
ready for personal or production use.

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
| Visible process directories in final run | 929, a changing host count | 2 |
| Broker-created pair payload | `A` | `A` |
| Pair peer PID visible to target | Nonzero broker PID | 0 |

The target PID was 2 in the private namespace. Pair peer credentials are not
transparent: the creating broker lives outside the namespace. A PID of 0 is a
measured compatibility issue, not a claim that this pair was created by the
application. Both control arms exited 0 with brokerFailure 0.

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

## Actual application failure

Namespaced Loupe maps a window but shows `Could not Load Image`. The owned
More Information dialog reports a D-Bus I/O error with OS error -1000. Both
sampled image colors fail. The application exits 0 when its window closes, so
the probe now explicitly returns status 1 for a namespace run whose generated
image colors did not match. Window mapping and application exit are not accepted
as image-rendering success.

The observed namespace pair peer PID of 0 and the loader's failure are separate
facts. The causal connection has not been demonstrated. A temporary tracer
covering only the owned disposable application did not locate a syscall return
of -1000 or a SIGSYS event. It was removed from the probe. No image sandbox was
disabled and no personal application or profile was changed to bypass the failure.

Artifacts:

- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/before.json`
- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/report.json`
- `output/seccomp-loupe-pid-loopback-pairs-2026-09-30/loupe-details.jpg`

## Commands and limits

```sh
ORBIT_PID_NAMESPACE_CONTROL=1 bun run scripts/limited.ts bun run experiments/seccomp-pid-namespace-controls.ts
bun run scripts/limited.ts bun run experiments/seccomp-pid-namespace-controls.ts
ORBIT_PRIVATE_BROKER_PID_NAMESPACE=1 ORBIT_LOUPE_BROKER_PROBE=1 ORBIT_LOUPE_BROKER_LOOPBACK=1 ORBIT_LOUPE_BROKER_PAIRS=1 ORBIT_LOUPE_BROKER_DETAILS=1 bun run scripts/limited.ts bun run experiments/seccomp-loupe-app-probe.ts
```

The first two commands pass. The namespaced Loupe command fails its image gate.
Current-account Nextcloud, terminal debugging, devices, namespace escape,
namespace descriptor receipt, alternative host proc mounts, ptrace behavior,
PID reuse races, deep namespace nesting and full application compatibility are
not measured. Root binding retains broad file and device authority; this is
not a complete sandbox. Private pair injection remains non-atomic and retains
its broker-created peer identity. Production launch behavior is unchanged.

Verification on the final source: process control and private-namespace fixtures
passed; the existing non-namespaced Loupe image colors still matched with normal
exit and no forced stop. Typecheck, compiler warnings-as-errors and diff check
passed. No full-suite or current-account result is claimed for this turn.
