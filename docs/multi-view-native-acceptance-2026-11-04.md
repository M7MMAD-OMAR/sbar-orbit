# Passive native observation: owned Calculator acceptance

Date: 4 November 2026, Asia/Dubai. Native run: 12:42 PM to 12:52 PM.
**Narrow single-window evidence, not a multi-view gate pass or release.**
[Content-free exact record and samples](multi-view-native-acceptance-2026-11-04.json).

## Scope and provenance

The owner requested full implementation and verification. The actual host
conversation was enabled; it was not re-enabled or replaced. Native readiness
was checked without refresh/reload. An unrelated paused shared-broker session
was preserved. Calculator registration discovery reported no running Calculator
PID before opening. A private controller opened only the exact original
`org.gnome.Calculator.desktop` registration on already visible workspace 4, on
unfocused HDMI-A-5. eDP-1 remained focused on workspace 1 throughout the run.
There was no workspace presentation, profile copy or substitute desktop.

The source baseline was `1985b1b196d1495c102e6c6c4759dc75f503ffb0`, with the
manual harness and framed error-message repair in the inspected working tree.
The JSON record pins each relevant source file SHA-256; these changes did not
modify the compositor plugin. The prepared real plan path was frozen so stale
readiness would refuse rather than auto-reload. Runtime identities:

| Component | Measured identity |
| --- | --- |
| Host | Fedora Linux 44, Linux 7.2.15-200.fc44.x86_64, x86_64 |
| Bun / Python | 1.3.14 / 3.14.8 |
| Application | gnome-calculator-50.0-1.fc44.x86_64 |
| Toolkit/provider | GTK 4.22.5, libadwaita 1.9.4, at-spi2-core 2.60.7, python3-gobject-base 3.56.3 |
| Hyprland | 0.57.1, commit acc1aa0bfd4bd575dcb0f76c35ccf12b660a1ab9 |
| ABI | acc1aa0bfd4bd575dcb0f76c35ccf12b660a1ab9_aq_0.16_hu_0.14_hg_0.6_hc_0.1_hlg_0.6 |
| Plugin binary | 3632960 bytes, SHA-256 31e6892227f58c98003bb147ed08b49dd9b3b5163840f58c4ab525bf2077b3cd |
| Plugin source | SHA-256 beb3024586ce1e7f07735bd5f6cdf4cc129424f4e72ee1ee5491d60b7aff9a67 |

Both prepared and recorded plugin binary files were hashed and matched the
receipt. Readiness confirmed loaded plugin/source/ABI agreement, not compiler
attestation or general application compatibility. Opening returned live launch-
ancestry evidence with matching launch/window PID and a fresh address/stable-ID
pair absent from the baseline. The numeric application PID birth token was not
retained, so this is not a complete future ViewBinding process-birth record.

## Actual operations and verification

[Manual harness](../experiments/efficiency-native-acceptance.ts) uses existing MCP
for setup, input and normal exact closure. Its manual internal passive command
uses the current production NativeBackend and Python worker after validating
its own exact private session, caller, read policy and conversation state. This
is **not** a newly enabled MCP/CLI multi-view tool or host-issued read grant.

| Step | Receipt and actual observation | Limit |
| --- | --- | --- |
| Open and handoff | Fresh attributed Calculator; requested 680x520 logical, initially matched; GTK later imposed 680x616. Entire-client handoff selected only the new exact window | Setup is effectful, not part of passive grant |
| Initial passive image | 1020x924 PNG, 38264 bytes, visually inspected; correct blank Calculator interface | One current original-app surface, not a whole-monitor screenshot |
| Initial passive text | 36 nodes, complete=true, cold-process; no image bytes | No retained semantic action authority |
| Initial both | Correct image plus 36-node tree, mode=passive-v1, cursorRefresh=omitted | Tree/pixels are separate, non-atomic acquisitions |
| Single arithmetic input | One request, text 1+2 and Return, 2 acknowledged receipts, no replay | Receipts alone were not counted as effect |
| Passive read after input | Visually inspected pixels show 1+2=3; tree has the expression label, result label and text value 3; 40 nodes complete=true | Initial after-input image 1020x961; later steady images 1020x962 |
| Finite repeated observations | 20 serial images then 20 serial cold-text reads; all succeeded, no extra input | Descriptive costs only, not a paired/counterbalanced productivity experiment |
| Cleanup | Normal close-window sent once; fresh candidates excluded the exact test address/stable ID and matched the two pre-existing candidate identities; own session handed back, private controller exited 0 with no errors | No application/process kill or shared broker restart |

There were 44 successful passive observations in total and no failed passive
requests. Every response acknowledged passive-v1 / omitted refresh and every
manual TS backend-state snapshot was unchanged. This does not directly inspect
Python heap state; that guarantee has separate production-method fixtures.
Three images were actually viewed, including the initial frame, first result
frame and last sampled image. Raw images, tree content and owner-window IDs
remain in the private cache; only hashes and content-free metrics are committed.

## Owner preservation and measured limits

Title-free compositor snapshots bracketed each initial passive read, the input
plus read-back, the 40-read sample block and cleanup. Focus identity, physical
pointer coordinates and output/workspace selection were identical at the read
brackets. The sample block ran from 12:49:55 PM to 12:50:00 PM. This is sampled
preservation, not a continuous input trace or proof that human input was blocked.

Pointer coordinates changed across opening/handoff snapshots and between early
operator pauses. Cause was not established, so **opening/handoff pointer
preservation is not passed by this run**. Focus and outputs stayed the same.
The later read brackets were stable. No unrelated window was moved, closed or
used as an input target; unchanged candidate identities do not prove the
contents/unsaved state of unrelated applications. No clipboard bytes were
inspected and no Copy/Paste action was sent; normal handoff still has its
existing shared-selection semantics. Clipboard preservation/isolation was not
a new measured result.

The proposed initial read-cohort image envelope is 1280x960. The result frames
reached height 961 then 962. **That proposed admission policy would refuse these
post-arithmetic images.** No limit was raised and no window was silently resized
to make the example pass. Physical rounding, GTK minimum geometry and raster
scratch reservations need explicit handling before a feature image profile is
qualified. The manual native seam has existing capture limits, not the future
cohort memory/admission implementation. No peak memory/CPU or global capture
reservation compliance is claimed here.

## Descriptive serial costs

Native worker-reported milliseconds, 20 samples each on the same owned result:

| Format | Minimum | Median | Empirical p95 | Maximum | Payload evidence |
| --- | --- | --- | --- | --- | --- |
| Image | 61.840 | 67.980 | 78.171 | 79.746 | 44614 PNG bytes, 1020x962 |
| Cold text | 147.952 | 174.252 | 197.752 | 290.364 | 0 image bytes, 40 nodes, complete=true, 680x641 logical |

The empirical p95 is nearest rank 19/20, not a stable tail estimate. Images were
sampled before text; no order counterbalancing, warm-host test, baseline versus
candidate comparison, model/token accounting or equivalent completed-task
comparison was performed. Manual controller duration also includes private
artifact IO, whereas workerMs does not. No speedup, 80 percent gain or provider
cost reduction follows from unequal image/text outputs.

## Harness safety and remaining gates

Independent review found that the prior manual harness warned about uncertainty
but did not prevent later queued mutations or automatic close. It now latches
failed/partial/uncertain setup/input, blocks more mutations and automatic closure,
and permits read-only inspection plus own pause/stop. A successful read cannot
clear quarantine automatically. Acknowledged exact identities are tracked before
artifact IO; lost opening/handoff outcomes are explicitly unresolved rather
than recovered by a guessed title/PID, relaunch or blind closure. Pure barrier
tests and early guard tests do not establish native endpoint fencing/drain.

A raw-TTY startup attempt did not become interactive; no application operation
was sent, its owned process tree was closed, and a metadata-only piped probe
exited cleanly. The measured run used piped stdin and an owner-private transcript.
Both tracked terminals were closed after controller exit. Do not replay this
transcript: its identities belong to a now-closed window.

The shared paused session remained present. A separate active foreign session
and lease appeared by the post-run check; it was neither released nor restarted.
Only the test client/session was handed back.

No multi-view gate passed. Two approved views, enrolled connector authority,
broker-side revocation, bounded global observation memory/scratch/queue, owned
reader drain, topology/document epochs, coordinated input fencing and rollout
remain unfinished. The earlier [failed settled capture report](efficiency-native-acceptance-2026-11-04.md)
remains historical evidence, not silently replaced by this distinct passive run.
