# Scoped raw canvas acceptance

`native_raw_task.py` exercises the production NativeSession path inside a guarded
private lab. It launches the existing GTK3 DrawingArea fixture in a generated
application scope. The actual AT-SPI tree must contain the drawing area and no
editable text interface. All input is then delivered through pixel coordinates
and the scoped native key/text protocol, without an accessibility mutation.

The task requires a fresh empty fixture, one click at250,150, exact labelled
English/Arabic text after BackSpace and replacement, and one wheel event.
Fixture readback comes from its own supervised output, with application scope
validation before and after the read. Target-only PNGs must be fully opaque.
The comparison uses only the rendered text region at y65..120; the requested
cursor at y150 is outside it. A changed cursor cannot satisfy the application
repaint assertion. Launch, input, capture and reads have matched durable action
outcomes, and application closure preserves diagnostics.

Run through `bun run scripts/limited.ts` and `lab.py run LAB --` after the lab
has a matching source-bound plugin and its simulated pointer/keyboard devices.
Invoke `/usr/bin/python3` with the absolute path to `native_raw_task.py`.
The optional ASCII `--label` distinguishes actors; `--barrier-fd` accepts one
readiness byte from a test coordinator. The final JSON names the private report.
This command refuses the owner's display. BAR acceptance uses the separate
unchanged person-interference harness, rather than treating task success alone
as evidence about the person's focus, pointer or windows.

Negative controls cover stale complete captures, frozen canvas repaint with only
cursor pixels changing, and transparent images preserving the exact background
sample. The previous crop and alpha-maximum predicates accept the latter two
bad controls; the corrected assertions refuse them. Failure tests separately
prove setup cleanup, combined primary/cleanup/report errors and preservation of
recovery files after an uncertain launch without a returned application handle.

This is private raw-input evidence. It does not establish owner activation,
complete toolkit or clipboard coverage, two visible cursor acceptance, the
reference cursor comparison, theme parity or performance improvement. Exact
reports, source bindings, retained failures and cleanup are in COMPLIANCE.md;
raw workstation captures remain private.
