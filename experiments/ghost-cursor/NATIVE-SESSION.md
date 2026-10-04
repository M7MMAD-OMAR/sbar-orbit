# Persistent native session routing

Reviewed 4 October 2026. Session component with private compositor evidence.
Production broker and owner UI routing remain incomplete.

`src/native/session.py` retains admitted application handles and generated window
IDs. Actions name their application and window explicitly. A fixed prepared host
and owner-configured controller are constructor inputs; agent requests cannot
select a compositor or change protected/full mode. Enumerated metadata contains
only windows belonging to this session's exact live scopes.

The plugin accepts guarded targets as `address@stableId@unit`. It compares the
window's stable identity and retained scoped registration during the same IPC
command, before waking the client or delivering input. A mismatching identity or
scope is refused. The representation follows the pinned Hyprland
[window-data implementation](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/debug/HyprCtl.cpp).
The new `ghost-target-check` validates that registration without waking the
client. Enumeration and capture require this check. Capture rechecks it after
`grim -T`; there is no whole-display fallback. A migrated and subsequently
returned application cannot resume capture after its registration is revoked.
This is cooperative same-user ownership, not a hostile-process security boundary.

Capture bounds stdout to 16 MiB, stderr to 64 KiB and child IO to ten seconds,
with an additional three-second reap attempt. Reap and private diagnostic-storage
errors survive alongside the original error. Filesystem IO has no hard deadline.
Stderr is retained in a new owned 0600 log file. Image bytes are returned only
after the controller records the outcome. The journal stores byte count, hash,
dimensions and target metadata, rather than image bytes. Pointer metadata is the
last acknowledged surface-local agent position. The target PNG does not include
the compositor's cursor overlay; it is not visual cursor acceptance.

`session_worker.py` exposes line-framed launch, act, close-application and close
requests. It retains request fingerprints and completed replies. An identical
retry returns the earlier result; conflicting arguments cannot reuse its ID.
Normal new requests are refused once the encoded-result cache threshold or
request count is reached, while owned cleanup remains available. One final large
reply can exceed the cache threshold; this is a bounded representation policy,
not a measured RSS claim. EOF cleans all owned applications. The worker is an
internal component, not yet the public broker's native backend.

## Checks and reproduction

Run one bounded command at a time:

```sh
bun run scripts/limited.ts bun test tests/native-session-routing.test.ts tests/native-transport.test.ts
bun run scripts/limited.ts bash experiments/ghost-cursor/plugin/build.sh /tmp/ghostinput-native-session.so
```

Three session checks passed: strict target/action parsing, real failed capture
with retained private stderr, and bounded final-reap failure with both errors
preserved. A deliberate automatic-context cleanup policy fails the final-reap
check because context exit attempts an unbounded wait. Twelve current transport
checks also pass. These fixtures do not observe the owner's display.

Start the private lab, load the version-matched new plugin, and hold its private
pointer and keyboard fixtures as documented in `PRE-MAP-PLACEMENT.md`. Run the
absolute path to `native_session_probe.py` through `lab.py run LAB --`, inside the
shared budget. Stop that lab on success or failure.

The final probe passed ten checks: protected denial before resource allocation,
two persistent workers with their own window handles, foreign-handle refusal,
guarded cursor/click/text readback, fresh target-only pixels with no image data
in the journal, request deduplication and conflict refusal, compositor stable-ID
and scope refusal, sticky capture revocation after migration and return,
independent protected EOF cleanup and stand-in text/keyboard focus preservation.
Disabling registration checks in the deliberate `--unchecked-capture` negative
control fails by returning a capture after revocation. This negative policy is
not reported as an unchanged historical source run.

The migration fixture uses the kernel's documented
[`cgroup.procs` interface](https://docs.kernel.org/admin-guide/cgroup-v2.html)
only for its owned test process and captured original scope directory. The first
systemd attach-back attempt returned a nonzero status and remains failed evidence;
no systemd attach-back success is claimed. Earlier worker import, event assertion
and fixture-controller failures are retained. Each terminal attempt was diagnosed
before the next changed attempt. Raw requests, images and logs remain private.

Successful final-run source SHA-256:

- `session.py`: `c13a7d04ac6fb8fb3971451ca568229697e2a3bbabefc33ddac9bb3ad4b6c56f`.
- `session_worker.py`: `ece1f7d898098615ebd19d4fabdd5c2d018f5cd3dee59e23a24332801458b61f`.
- `application.py`: `0a5cd473ef7994385e84389dfd1d0ce8993887e2686435382db383419d5cc835`.
- `transport.py`: `c1d9e01d946712cb4e60635cb90942490da785838b966d3e62d631d5347ac2df`.
- Plugin source: `a4832255168eea579cc46e6babcf83bfd2dd6409aab98085354a755c59a15513`.
- Mapped plugin binary: `4bf1b21a3bb7ece3a10ad4f32a75b16cda6a7647bb3638a2757c733ca704acf6`, O0 prototype build.

## Repository validation

Bounded typecheck passed. The full bounded suite passed 587 tests with 45 skips,
zero failures and 3,784 assertions across 632 tests in 138 files. Skipped platform
and native checks are not accepted by that default gate. Both review axes have
no remaining actionable findings in this component.

## Remaining acceptance

The current routing proof covers root clients enrolled by the launcher. Child
clients require their own scoped registration and remain unmeasured on this
path. The two-worker task actions were sequential; this run does not prove B10.
It did not measure whole-system B1 to B4, click-through, the toolkit matrix,
owner theme match, actual owner activation or comparative performance. Public
broker and settings UI integration, native viewing of the cursor, accessibility
routing and final BAR.md acceptance remain required work. Earlier experimental
recording is historical evidence, not current routing acceptance.
