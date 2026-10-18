# Browser startup reliability incident ledger

The saved-account timeout cause remains unknown. Diagnostic instrumentation is
evidence gathering, not a production startup repair. The saved-account test keeps
its 30 second limit and all account survival, exclusive lease, private storage,
cleanup and restore-failure assertions. Production startup deadlines are unchanged.

## Retained Ubuntu evidence

These historical receipt statements are preserved from the c38c branch ledger.
The integration source proposal has not fetched or rerun these provider receipts.
They retain their original source scope and cannot certify the current source.

| Run and exact source | Saved account result | What it establishes |
| --- | --- | --- |
| [37428123732](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37428123732), `0fe18e3` | Normal full-suite timeout at 30002.65 ms | Original failure; no startup boundary trace. |
| [37430180528](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37430180528), unchanged original production source | Isolated pass at 7602.33 ms | This probe did not use `--smol`; it does not explain the full-suite failure. |
| [37472285951](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37472285951), `7bc9111` | Isolated `--smol` pass at 13680.61 ms; full-suite `--smol` timeout at 30001.02 ms | Account acquire and restore finished at 741 ms. Browser creation began at 935 ms; CDP began at 30058 ms. The 29123 ms gap is before CDP, without endpoint or socket attribution. |
| [37473790324](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37473790324), `6a6e56b` | Isolated pass at 12573.36 ms; full-suite pass at 13458.49 ms | First full-suite endpoint at 6144 ms, socket open at 7738 ms, CDP ready at 8426 ms. Shared-slice throttling and memory-limit events did not increase in that passing startup. |
| [37474794104](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37474794104), `cf73128` | Isolated pass at 29534.74 ms; full-suite pass at 14401.07 ms | First isolated endpoint at 18461 ms, socket open at 22205 ms, CDP ready at 23266 ms. First full-suite endpoint at 6369 ms, socket open at 7902 ms, CDP ready at 8613 ms. |
| [37474272086](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37474272086), `333b92e` | Nine normal CI jobs passed | Successful combined-source verification does not establish a startup cause. |

Run `37474794104` finished with 709 pass, 94 skip and one full-suite failure.
The failure was the separate native-selection callback fixture, which exited 5.
That fixture's discarded error output does not by itself establish a missing
compiler or library. Normal verification provisions its compiler and Wayland
development dependencies; diagnostic environment parity needs separate evidence.

The isolated first startup in `37474794104` had no increase in shared-slice
`throttled_usec` through socket open. CPU usage rose from 747180 to 1725109
microseconds over about 22.2 seconds. Shared-slice memory and task maxima were
not approached and memory-limit events remained zero. These are observations
from a passing startup, not measurements of the earlier timeout. Aggregate runner
CPU, guest steal and I/O pressure were not recorded in that run. D-Bus errors
appear in passing runs and are not a proved cause.

## Diagnostic correctness and evidence boundaries

Global readiness tracing in `6a6e56b` violated the existing viewer setup fixture's
empty-stderr subprocess contract. The same existing assertion failed with that
source and passed with `cf73128` under the same trace flag and nonmatching root
sentinel. That red/green result proves an instrumentation correction, not a
production startup correction. The full-suite `cf73128` run also passed that
fixture.

The current selective integration requires an explicit selected fixture root;
the flag alone cannot enable global startup output. Each launch has an opaque
identifier and sequence. Phase time and counter collection start/finish are
separate because asynchronous reads do not form an instantaneous snapshot.
Counters resolve the named enforced shared slice, with clearly labeled aggregate
runner pressure and CPU fields. Missing reads are listed as unavailable.
Stderr evidence contains bounded fixed categories of recognized browser records.
Free text, paths, endpoint URLs and arbitrary supervisor output are omitted. No diagnostic output
is evidence of a completed process-tree cleanup or ownership assertion.

The workflow remains opt-in. Its artifacts contain the tested commit, production
blob identities, instrumentation hashes, before/after worktree state, Bun and
browser versions, browser binary digest, kernel identity, exit code and complete
test log. Test-file order comes from that actual log. Instrumented source is
identified independently and is never called unchanged production source.

## Remaining Windows evidence

[Run 37411189838](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838)
attempt 1 on `66e15949ffad5b9f498d49b900dcd166629e6912` retained an installed-browser
endpoint timeout while Chrome was still running. Attempt 2 on the same source
passed. Failed-startup browser stderr, accounting, membership and stable process
handle liveness were not measured in that failure. The successful rerun cannot
close its cause or prove zero survivors after failed startup.

The older managed-broker cold-start failures and newer abrupt broker-death
measurements are separate events. Retained-handle correction and owned-tree
reaping evidence do not prove repeatable cold startup. See
[portability-verification.md](portability-verification.md) and
[windows-measured.md](windows-measured.md). Windows lifecycle adapters and
managed abort paths are coordinated with the portability workstream.

## Concrete next evidence

Reproduce a failing saved-account startup under the matched full `--smol` suite
with endpoint, socket, CDP, stderr, shared-slice counters, runner pressure and
exact source/browser identity retained. Compare its failing interval with a
passing interval before proposing a repair. No increased deadlines or arbitrary
retries are part of this investigation.

Windows cold-start and managed-broker abort probes must use owned disposable
fixtures and preserve stable process witnesses through cleanup. Local bounded
commands require the coordinator's explicit serial test-slot grant.

## Selected-page target capture attribution

The selected-page focus regression retains its 30 second deadline, original
assertions and owned fixture cleanup. Only its newly created broker target is
registered for phase capture. The current observer retains capture and navigation
rows, including original promise settlement. Registration admits the exact
backend, context, workspace and profile through the existing ownership check.
Neither viewer registration nor a warmup capture is part of this diagnostic.

The launcher exposes the exact selected executable alongside its existing owned
launch result. After the fixture scope cleanup attempt, a separate file hook can
retain a bounded stable executable file digest and the cached connected-browser
version digest. Executable path identifiers are hashed and arbitrary error
messages are redacted. Loaded bytes at launch, browser CLI version, dependency
identity, source before/after stability, root cause and capture performance are
not measured. A cleanup attempt or a fulfilled scope does not measure survivors.

This lane is diagnostic source preparation until its current source is executed.
A passing local helper fixture establishes only that fixture's behavior. If a
timed-out test does not reach its finally block, no queued artifact is promised.
The opt-in macOS lane is described separately by its source and execution
receipts; installation and historical passing runs do not close this incident.
