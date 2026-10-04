# Native target view

Reviewed 4 October 2026. This is a privately measured native GTK component.
It does not complete owner activation or public broker integration.

`src/native/view.py` consumes bounded newline JSON frames on stdin. It creates
a GTK 3 window using the current GTK theme. It neither captures a display nor
forwards pointer or keyboard input. The source sends updates; the viewer has no
capture timer. Its reader decodes off the GTK thread, retains at most one pending
frame, and invalidates the drawing area through the main loop. EOF is retained
separately so it cannot replace the final pending frame. The view closes after
that final draw. Invalid frames produce a nonzero exit and retained stderr when
supervised by the probe. Native theme inheritance on the owner's desktop is
still unaccepted.

Frames require logical `surfaceWidth` and `surfaceHeight` separately from PNG
pixel dimensions. The cursor transform applies both logical-to-image and
image-to-view scaling, including letterboxing. The path, hotspot, outline and
blue/teal variants match the compositor plugin. This is an acknowledged cursor
overlay in the native preview, not proof that the hidden application itself is
visible on the owner's desktop. The session refuses a capture if the observed
logical surface dimensions change during it.
When a resize before capture puts the last acknowledged point outside the new
surface, session metadata hides that cursor instead of returning an invalid
frame. This metadata fix does not prove compositor cursor clipping on resize;
the current cursor regression matrix remains required.

Input lines are bounded to 24 MiB, encoded PNGs to 16 MiB, dimensions to 16,384
per axis and decoded images to 16,777,216 pixels. These are representation
limits, not an RSS or latency measurement. Draw acknowledgements are explicitly
opt-in for probes; the ordinary UI does not write stdout. GTK accessibility
identifies this as a visual preview; it does not expose the target application's
semantic accessibility tree. That routing remains required work.

## Evidence

Six rendering/validation checks passed on the system Python with Cairo and
GObject bindings. They cover cursor placement at doubled image scale with
letterboxing, movement and hide, invalid frame metadata, truncated image
decoding, final pending-frame preservation and session resize-to-frame handling.
Loading the saved pre-fix `_owned_windows` implementation, SHA-256
`ed6a84409b4d945819c0fd5c36a5a0236df91e9526093f68b635f64a2898e585`, fails
the resize check by retaining the out-of-bounds cursor. Deliberately confusing logical
and image dimensions fails the placement assertion. Deliberately replacing the
pending frame with EOF fails final-frame preservation. These are negative
policies, not unchanged historical implementation runs.

The actual private GTK probe passed the ten native session routing checks and
displayed two frames from that session with different acknowledged cursor
positions. The captured GTK window visibly shows the arrow and its accent dot
moving. Both normal source EOF and immediate EOF after a single frame drew and
exited successfully. The view is opened only after the stand-in focus/text
checks finish; it does not widen those checks to prove viewer focus invariance.
All successful private labs were stopped after their terminal runs. The first run exposed
the pending-EOF and palette issues during static review; it is historical.
The final run includes the palette, EOF and resize metadata fixes. A further
pinned-GPU lab startup failed buffer allocation and produced only a zero-sized
fallback output. Its initially delayed process cleanup was rechecked, all three
recorded processes had exited, and a final owned teardown succeeded. The next
explicitly changed launch used the default render-node selection and passed the
current probe. This does not establish a GPU performance result. The first full
suite failed packaging because the new source file was not tracked yet; intended
paths were then staged. The initial resize fixture also lacked a prepared runtime
path; that terminal fixture error was corrected before the changed test passed.
Screenshots and raw logs remain ignored.

Final runtime source SHA-256:

- `session.py`: `bbed8ff8d6ef4c4432cb80d000bbaee6e58367f68622850917840cf3118d71b9`.
- `view.py`: `4930ccbf43da8415b16594e4737740fd0b5080d961706746ef84dbf3515e0af9`.
- Plugin source: `a4832255168eea579cc46e6babcf83bfd2dd6409aab98085354a755c59a15513`.
- Mapped plugin binary: `4bf1b21a3bb7ece3a10ad4f32a75b16cda6a7647bb3638a2757c733ca704acf6`, O0 prototype.

## Reproduction

Run one bounded command at a time:

```sh
ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun test tests/native-target-view.test.ts tests/native-session-routing.test.ts tests/native-transport.test.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/native_view_test.py --wrong-dpi
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/native_view_test.py --drop-last-frame
```

The last two commands must fail. The native view wrapper is opt-in because its
pixel checks require the Fedora native Cairo/GObject runtime; a default skip is
not accepted evidence. Start a private lab and load the matching plugin as in
`NATIVE-SESSION.md`, hold its pointer and keyboard fixtures, then run the absolute
`native_session_probe.py --native-view` path through `lab.py run LAB --` inside
the shared budget. Always stop the owned lab after the probe terminates.

## Remaining acceptance

The final bounded typecheck passed. The full bounded suite passed 587 tests,
with 46 skips, zero failures and 3,784 assertions across 633 tests in 139 files.
Native view pixel checks were also explicitly enabled and passed with the session
and transport wrappers. Default native/platform skips do not close acceptance.
Both review axes have no remaining actionable component findings.

Public broker supervision and UI routing, the owner's native activation/theme,
accessibility routing, child-client enrollment, current toolkit matrix, B1 to B4
and B10 measurements, click-through and comparative CPU/memory/latency remain
incomplete or not measured. This component is research source and does not raise
the project's native support tier.
