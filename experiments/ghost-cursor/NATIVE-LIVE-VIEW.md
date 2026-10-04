# Public native GTK view

Reviewed 4 October 2026. The native-view CLI now connects explicit owned broker
targets to the GTK frame renderer. This is measured inside the private lab,
not owner-display activation or overall completion of BAR.md.

## Measured behavior

The actual public command renders three real GTK target captures. Its first draw
acknowledges the fractional cursor at (40.5, 30.25). After an admitted target
cursor action, its third draw acknowledges (200.5, 100.25). A target-only capture
of the live GTK viewer was visually inspected: the field's text and the dark
cursor with white outline and teal marker are visible. The fixture's light theme
is not evidence of matching the owner's dark theme.

The viewer accepts an explicit session, application and window ID. It does not
change compositor, owner permissions or targets and forwards no input. It awaits
actual GTK draw acknowledgement before the next capture, then waits at least one
second. Frame count may be specified for an automatically closed preview.
Window closure stops new client captures. Local cancellation settles immediately
and destroys its request; an already admitted server capture retains its own
existing deadline and owned cleanup. This is not server-side cancellation.

The response cache retains one image plus bounded metadata and fingerprints.
Older capture replay returns REPLAY_EXPIRED rather than recapturing implicitly.
Mutating outcomes remain replayable. A saved unfixed worker refuses later
captures and the following mutation after crossing its 16 MiB image cache budget.
The same test on the fixed worker accepts 24 one-MiB captures and the following
mutation. The separate cache test verifies older expiry, latest-image replay,
mutation preservation and metadata accounting. This measures retained reply
storage, not whole-process RSS or comparative performance.

The client tests cover serialized capture/draw, early window exit, malformed
acknowledgement, cancellation of a deliberately stalled server response, and
cache storage. The initial Unix-fetch cancellation test timed out. The first
explicit socket-destroy implementation also delayed its error event. Explicit
local cancellation settlement then passes. All failed logs are retained. An
initial negative-control import failed because its saved file was too shallow
for its repository-relative import; the unchanged file in its original relative
layout reproduces the actual cache failure. Neither failure is counted as a
successful negative behavioral result.

The successful private broker proof also verifies independent native sessions,
protected admission, foreign target refusal, capture, request replay, pause,
policy narrowing, sibling preservation, and reaping owned roots and detached
children. All lab and owned short disk workspaces were removed after the proof.
Raw workstation screenshots and logs remain private. An earlier supplied screenshot
was losslessly optimized with identical decoded pixels; the current source-bound
proof captures a fresh image.

## Reproduction

```sh
bun run typecheck
bun run scripts/limited.ts bun test tests/native-preview.test.ts tests/native-reply-cache.test.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/native_reply_cache_test.py
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py run LAB -- /usr/bin/python3 ABSOLUTE_REPO/experiments/ghost-cursor/native_broker_probe.py
bun run verify
```

The broker proof requires the prepared private lab and the pinned O0 plugin
documented in NATIVE-BROKER.md. The runtime is Bun 1.3.14 on Linux with GTK3.24.
Full-suite and staged publication results are recorded in COMPLIANCE.md.

## Outstanding owner goal

The CLI path is implemented. Managed broker activation, final owner controls acceptance,
owner theme inheritance, accessibility routing, child-client enrollment,
the complete simultaneous-input and toolkit/clipboard/cursor matrix, and
CPU/memory/latency comparison remain incomplete. The 10000 worker-request limit
remains, so this is not an unlimited streaming session. The one-second preview
cadence is not input latency evidence. No faster-operation or zero-overhead
claim follows from these checks, and production support tiers remain unchanged.

## Source binding

This live-view proof is bound to the source below at revision 9a82eeb. Later
addition of the owner settings CLI is measured separately in
NATIVE-SETTINGS-RUNTIME.md. These hashes are historical proof bindings, not a
claim that every listed file still has the same current contents.

The actual public live GTK proof exited zero. The isolated client checks passed
five tests with 20 assertions; the cache helper now passes two Python tests.

- `src/native-preview.ts`: `0479c665f2ef64355750383309d066eb803adc258436f493036485508fbb4aaa`
- `src/cli.ts`: `bfdfcdc12e3a50882479ccba42e9f492b703eea3d745759b9dbf6b0d7a81aa3e`
- `src/ipc.ts`: `8badbd611b8f1f3ae9648caf46c582793439aeb56f125b4545756d18a4ca0e80`
- `src/native/session_worker.py`: `75d037d53526c60862886f2e858c98e986f3aa999d87167d9a9251e7f4d16339`
- `src/native/view.py`: `4930ccbf43da8415b16594e4737740fd0b5080d961706746ef84dbf3515e0af9`
- `bin/sbar-orbit`: `ea91e4332eeff95f9f5c0abf7e8ed035297ff56afa08944f36732c8782ec376c`
- `experiments/ghost-cursor/native_broker_fixture.ts`: `8b445580296ac70b0d266b797f2c3e323e81f30af139d6f09050f14dc08a7376`
- `experiments/ghost-cursor/native_broker_probe.py`: `64dbe955835ec84badae99074df5b1c34e9c2e40d751ac32073bcaf146486936`
- `experiments/ghost-cursor/native_reply_cache_test.py`: `2e3585803ff0efdb5e00357153658bdb471648f0b7d688808734ef0370621132`
- `experiments/ghost-cursor/native_preview_fixture.py`: `b62b3d5b76f4bba5276a3404c29e3bd797e817c19c4702c057cf44fbc26aec86`
- `tests/native-preview.test.ts`: `ebd012088fba04238d3415f15647c71d95d69a28542f4e348ac8f16ccc3735c3`
- `tests/native-reply-cache.test.ts`: `29ed57550cc64e3ee91fdd77487cbf02af6daa0572bb2ea3d1017110bcf48951`
- Saved unfixed worker: `713832f95b15718cbcaa4e53f77749536fb50741a4051ef3963d03ba5f92f52d`

- `src/session.ts`: `0d8ebce82b392545f4e464e1ffe183226752f3d9d839003fd0fb1c22db90c132`
- `src/diagnostics.ts`: `f6e4a22ea1a50afa2f31834ad3153732fa08036b0a2c7f24c9052feee4ba1616`
- `tests/adversarial/reaping-and-secrets.test.ts`: `285af915ff164b4a165aef6d1b67002e62406606cb40c293ffeeafeaec0458be`


## Actual live cursor recording

A fresh public broker proof on the native-settings runtime source now passes
all eight broker checks again and records its actual GTK native-view window.
The optional `--record` probe captures only that exact stable target, with a
maximum of 20 captures at a requested five samples per second. Real monotonic
capture timestamps are retained; encoding uses that nominal cadence rather
than claiming exact wall-clock playback or input latency. The final APNG has
11 frames and is 24569 bytes. Every decoded RGBA frame has the same dimensions
and bytes as its original target capture. The first frame was visually inspected.
The isolated blue agent marker, acknowledged variant 1, moves from (549.5, 100) to (703, 167), with the direction of
the acknowledged logical displacement from (40.5, 30.25) to (200.5, 100.25).
The check requires a minimum displacement and verifies the 70/160 slope
within two pixels; it does not validate the full projected vector magnitude. The animation is retained
privately as evidence/native-live-cursor-motion.png.

A no-motion fixture first exposed a false positive: the old whole-image check
accepted repainting while the agent pointer stayed fixed. The new isolated
marker check rejects that same fixture. An alpha-only mutation also exposes
the old RGB-only equality check and is rejected by exact RGBA comparison.
Neither initial check is counted as successful cursor-motion validation.
The recording is committed to its final evidence path only after these checks.

The first attempt failed before viewing because the fresh lab had no pointer
resource. A second diagnosis retained the cooperative journal and identified
`target has no pointer resource`. Private virtual pointer and keyboard devices
were then started, and the actual recording passed. The original failed logs,
diagnostic journal and negative-control logs remain retained locally. The lab and
its devices, temporary negative sources and owned application trees were removed.
No owner display was captured, and no owner activation or performance result
follows. This demonstrates the live GTK preview's drawn cursor, not acceptance
of compositor overlay click-through on the owner's desktop.

Reproduce after preparing the private lab, plugin and its virtual seat:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py run LAB -- /usr/bin/python3 ABSOLUTE_REPO/experiments/ghost-cursor/native_broker_probe.py --record
```

Current recording proof bindings, distinct from the historical list above:

- `src/cli.ts`: `85cba40e5c2143dd7d992ef3a7058a4caa113ab62bff0b7af8308a5009edd6e8`
- `experiments/ghost-cursor/native_broker_probe.py`: `4b189157b8bc7d0b227ebace569225271ec30fadef6f1778b0516be0550a5d1e`
- Renderer, preview client, IPC client, session worker, session lifecycle,
  diagnostics and broker fixture retain the hashes printed above.

The variant-aware proof completed on the c32efa3 runtime checkout with the
current uncommitted probe source bound above. The first two fresh setup attempts
failed because the pointer helper was invoked incorrectly; the private journal
retained `target has no pointer resource`. After starting the documented held
virtual pointer, recording reached the real viewer and exposed the detector's
teal-only assumption. The renderer legitimately chooses either teal or blue
from the acknowledged target variant. The corrected detector accepts only that
variant's fixed accent and retains the isolated marker bound.

A fresh no-motion fixture with a forced evidence-copy collision failed with both
the movement assertion and FileExistsError in one ExceptionGroup. An actual
recording alpha-only negative control also failed exact RGBA equality as
required. Negative sources were private and temporary, and the positive APNG
was not overwritten by the rejected recording. The fresh source-bound report is
retained in .private/native-recording-variant-proof.log. The first and last
decoded frames were visually inspected. Playback remains nominal five frames
per second, with actual capture timestamps retained separately.

Prepare the private virtual seat after loading the pinned plugin:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py spawn LAB -- /tmp/ghost-person-pointer 50 50 1920 1200 hold
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py spawn LAB -- wtype -s 300000
```

The pointer helper takes numeric coordinates and extent followed by `hold`;
it obtains the private socket from the lab environment. It does not take a
socket pathname as a positional argument. All such devices belong to the lab
and are stopped by `lab.py down LAB`.

Private animation SHA256: `34e69935c7942d3c54c33c4f66678521d3f203e4f1ab3eaa57da01e463babb97`.
