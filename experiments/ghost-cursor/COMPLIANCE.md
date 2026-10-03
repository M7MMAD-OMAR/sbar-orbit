# Ghost cursor compliance and acceptance

Reviewed 3 October 2026. Scope: isolated background application input, visible
agent cursors, owner-selected autonomy modes and measured interference.

## Sources

- Official Wayland pointer protocol, reviewed 3 October 2026:
  https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_pointer
  axis_discrete precedes its paired axis event for clients below version 8;
  axis_value120 replaces it from version 8. Events remain grouped in a frame.
- Official Qt client implementation matching installed Qt 6.11.2:
  https://github.com/qt/qtbase/blob/v6.11.2/src/plugins/platforms/wayland/qwaylandinputdevice.cpp
  Reviewed 3 October 2026. pointer_frame compresses fast adjacent frames;
  pointer_leave invalidates focus and flushScrollEvent needs a focus target.
  Grouped wheel input is verified through Dolphin scroll coordinates and pixels.
- Official GTK input implementation matching installed GTK 4.22.5:
  https://github.com/GNOME/gtk/blob/4.22.5/gdk/wayland/gdkseat-wayland.c
  Reviewed 3 October 2026. A frame with a pending motion event delivers that
  event instead of flushing scroll. Motion and wheel therefore use separate
  frames, and the target client's synthetic pointer focus is retained until
  explicit ghost-release or a later pointer action. This does not move the
  global seat pointer or alter its focus. Unload cleanup skips the client's
  resource when that client currently holds actual seat pointer focus.

- Official Hyprland IPC event reference, reviewed 3 October 2026:
  https://wiki.hypr.land/IPC/
  Updated 26 August 2026. Both screencast and screencastv2 report screencopy
  client state, not a workspace, focus or stacking change. The live watcher
  produces these observation events; other unknown events still fail B4.

- Official Hyprland plugin development guide:
  https://wiki.hypr.land/Plugins/Development/Getting-Started/
  Technical constraint: plugin API and compiled headers must match the running
  compositor. Use the existing extracted development RPMs, without sudo.
- Official advanced plugin guide, reviewed 3 October 2026:
  https://wiki.hypr.land/Plugins/Development/Advanced/
  Documents private-member access. The primary-selection guard uses this
  version-specific pattern for existing target devices and restores their
  original callbacks on unload. No compatibility with other ABIs is claimed.
- Hyprland primary-selection implementation at the running commit:
  https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/protocols/PrimarySelection.cpp
  Reviewed 3 October 2026. Native selection can update the global primary
  selection even when the client lacks the person's focus. This was observed
  by the person's client in the unfixed GTK4 test, not merely inferred.
- BAR.md: owner acceptance criteria B1 through B10, including client-observed
  focus and input, raw background input, visible click-through cursor and two
  agents. Unrun requirements remain not measured.
- AGENTS.md: owner constraints, Bun commands, private displays, resource bounds,
  English repository text, no long dashes and no interference with the live seat.
- Official wlr virtual pointer protocol:
  https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml
  Technical reference for the simulated person's click-through test. The XML
  retains its permissive copyright notice in the ignored local dependency tree.
  The helper refuses display sockets outside /tmp/gl-* and never opens uinput.

## Current checks and scope

Reviewed 3 October 2026. This is a private-lab research prototype, excluded from
the normal runtime and package. No owner desktop integration is delivered.

- Mixed-client input: the old plugin accepted a target whose client also owned
  a window outside the agent workspace. The new plugin refuses that exact case
  before input delivery. The same fixture proved failure before and success
  after the correction.
- Compositor process cleanup: the old harness passed while a compositor-launched
  fixture remained alive. The updated B12 gate detects that fixture, reports
  failure and terminates it using its process identity. Cleanup never changes
  the failed measurement to a pass.
- Failed launch cleanup: a no-window command times out as expected. Its owned
  process and temporary markers are absent afterward.
- Concurrent clipboard regression: two native GTK3 clients copied and pasted
  distinct text with a measured overlap of 0.952 seconds. B1, B2, B3, B4 and B12
  passed while all 171 simulated-person characters arrived.
- A fresh GTK4 editor also passed multiline text readback, selection,
  deselection and scrolling with B1, B2, B3, B4 and B12 passing.
- The plugin built and loaded against the matching Hyprland ABI. Ordinary and
  primary selection guards share installation and restoration mechanics.
- The cached antialiased cursor passed a current-build click-through check:
  a real private-lab pointer click inside its arrow reached the underlying
  canvas. Its private screenshot was inspected. The complete visual matrix and
  reference comparison remain not measured.

Exact local source hashes, reports, screenshots and failed attempts are retained
in ignored evidence storage. They are not distributed as raw workstation data.
These results cover the isolated Fedora Hyprland lab only. Existing lab copies
of the owner's input settings do not establish live-session acceptance.

## Acceptance and outstanding requirements

Project diagnostics passed: typecheck and the full bounded suite, 572 passed,
45 skipped, zero failed. The skips do not establish native coverage.

To reproduce project diagnostics, run `bun run scripts/limited.ts bun run typecheck`, then
`bun run verify`. These checks do not establish native release acceptance.
Use `lab.py run LAB -- /usr/bin/python3 harness.py --agent COMMAND` for a bounded
private-lab task measurement. The full native acceptance runner remains pending.

Not measured or incomplete: actual owner-session integration and theme matching,
protected/full system settings, durable action journal, complete toolkit matrix,
owner-focus clipboard transitions, primary middle-button paste, pending-input
unload, XWayland and a comparative performance benchmark. Writer bulk input
previously crashed; paced input passed, but a general backend fix is pending.
No zero-cost or faster-than-current-runtime claim is made. A failed, missing or
stale required check prevents release acceptance. This change can be reviewed
as experimental source without being presented as a completed product release.

## Source binding

- `plugin/ghostinput.cpp`: `3ebaa36827ca7ee559fb7b3715e58545deb81add231442bfc3e0f21d8beb82ce`
- `ghost.py`: `f83449c4af3d1fad5fdbe35ee1d989c3ba71054c543dc5a7f166462d6b7fd4e3`
- `harness.py`: `cd3ecefa7ba1477cad380d7b8a7d0e446aa43c2ec3aa7c9acb84a3c00cd868c0`
- `process_scope.py`: `6e2282149954a64741cb62f7b7fa8962808955a86ba51872301731ddc3e48afa`
- `agent_launch.py`: `93d2cec4df05d3858e6b91a7856e3ab6d5d6c3f611ce6339cef8680c3ae0faa4`
- `clipboard_task.py`: `4a90cf44e7ec9fedf07df912eeff77ec97621a3aac4743bae9031ce52af20b6f`
- `native_fresh_task.py`: `96d2f01f32794501c50b8ae1ff670a4f1ab8bd06c0e67977e2f4bef11428d69a`

## Action control development

The next controller stores mode and one-use approvals outside action requests,
with a private durable journal. Journal synchronization runs in the requesting
process, never in the compositor rendering thread. The first implementation
covers calls made through this controller only. Direct experimental Hyprland
IPC and imported accessibility helpers still require integration before all-action coverage
can be claimed. Same-user files are configuration, not a security boundary
against arbitrary code running with the owner's account. No live-seat use is
authorized by the controller's existence.

The real GTK3 fixture passed protected denial, exact one-use approval, replay
refusal, full-mode input, error recording and refusal when its journal path was
unwritable. B1, B2, B3, B4 and B12 passed with all 171 stand-in characters.
The initial run failed because the successful text response includes a key
count; that protocol parsing error was corrected and the failure is retained.
The earlier five behavioral checks passed, including eight concurrent actors and journal
reopen. Deliberately bypassing approval made the protected-mode test fail.
An interrupted begin remains unresolved when inspecting the ledger, never a
reported success. Hardware power-loss behavior remains not measured.

Technical references, Python 3.14.8 documentation reviewed 3 October 2026:
[os.fsync](https://docs.python.org/3/library/os.html#os.fsync) requires flushing
the buffered stream before synchronizing its descriptor.
[fcntl.flock](https://docs.python.org/3/library/fcntl.html#fcntl.flock) provides
the exclusive advisory lock used to serialize cooperative controller writers.
These are implementation references, not a security claim about same-user code.

Current controller gates: typecheck passed; complete bounded suite 572 passed,
45 skipped, zero failed, 3734 assertions across 130 files. The five controller
behavioral checks also passed with temporary storage rooted on persistent btrfs.

A 100-query microbenchmark on persistent btrfs measured median native state
query latency of 0.016 ms and controlled query latency of 1.114 ms, with the
controlled p95 at 1.773 ms. This measures journaling around hidden-window state
queries only. It is not a comparison with the old desktop runtime or a typing,
rendering, memory or owner-session benchmark. The earlier tmpfs measurement is
retained with its storage limit and is not used as disk-journal evidence.

## CLI controller integration

The native CLI now routes every command through synchronized intent and outcome
records, including launch, accessibility edits, reads and captures. Protected
mode requires the canonical `ghost-cli` JSON argument request. Zero-exit legacy
commands become success outcomes; nonzero exits become error outcomes.

The real GTK3 CLI regression failed before this integration because an
unapproved protected launch succeeded. It now passes protected launch refusal,
approved launch and edit, replay refusal, full-mode text readback, invalid-ref
error recording, refusal of a stand-in outside the agent workspace and refusal
to launch when journal storage is unavailable. B1, B2, B3, B4 and B12 passed,
with all 171 stand-in characters intact. Reports remain local.

Accessible app lookup and window capture now require mapped windows belonging
to the agent workspace, with no other mapped window of that PID outside it.
Refs additionally require the resolved accessible element's PID to match the
requested process. Cross-process client relationships remain a coverage limit.
Direct experimental IPC and imported helper calls are not yet universally
controlled. The CLI integration does not establish complete all-action coverage.
Current project gates passed after these source edits: typecheck and the full
bounded suite, 572 passed, 45 skipped, zero failed, 3733 assertions across
130 files. Skips remain explicit native/platform coverage limits.

Controller concurrency correction: the original lock covered operation execution
and blocked a second actor behind a long action. The new sixth behavioral check
failed on that source. After shortening the lock to intent/approval and outcome
writes, all six checks passed and the short actor completed while the long actor
was still active. Configuration changes affect later requests; they do not
retroactively cancel an operation whose intent was already approved.
Earlier controller latency evidence is stale after this lock-scope edit; current
latency and persistent-storage verification are pending. Unresolved inspection
includes in-flight intent until its outcome arrives and must not be read as a
completed result.

Current private regression after shortening the lock passed controlled CLI launch
and accessibility again. Two concurrent GTK3 clipboard workers with controlled
launches passed B1, B2, B3, B4 and B12, with a 0.813-second process lifetime
overlap. Their direct raw test-helper input is still outside controller coverage.
All six controller behavior checks also passed on persistent btrfs storage.

Fresh GTK4 launch, CLI accessibility snapshot and target/ref ownership checks
also passed with the current source. Multiline text, selection, deselection and
scrolling passed B1, B2, B3, B4 and B12. Direct raw input in this measurement
remains test-helper input, so this is toolkit regression evidence rather than
universal controller coverage.

Current controller source binding:
- `action_control.py`: `08d448aca25846f7fc7742efe32613bc8eb742eb074656e8dab64d4c7b0a48a1`
- `action_control_test.py`: `a609bc9e296df174479f41b1e1895352304394ef5c089824ed3c4b575ca8086d`
- `ghost.py`: `f83449c4af3d1fad5fdbe35ee1d989c3ba71054c543dc5a7f166462d6b7fd4e3`
- `control_task.py`: `263c1099a2cdf68799e0bf5742aab9c4b0523dd25a386624fa99ba6b9f5caae1`
- `cli_control_task.py`: `c3f2eb2ee59e9f7bc8b18daa8936fb1d95707b9b7d34b4fdd41d9aafdfc51a84`

## Shared raw-input API integration

The shared ghost.hypr helper and GTK/Qt/Writer/canvas worker commands now route
native requests through protected/full decisions and synchronized intent/outcome
records. The transport primitive is separate to prevent recursive journaling.
Compositor IPC has a finite timeout and closes its socket on success or failure.
The native shared-API regression failed on the original helper because protected
input succeeded without approval. Corrected shared-API input passed protected denial, exact approval, replay
refusal, full-mode input, native error recording and prevention of input when
journal storage was unavailable. B1, B2, B3, B4 and B12 passed.
Direct compositor IPC remains an experimental escape surface, not a supported
security boundary. Observer-side accessibility reads and direct imported actions
still need complete audit coverage before universal logging is claimed.
Previous worker and controller source-bound evidence is stale after these edits.

Two concurrent native GTK3 clipboard clients passed after shared raw integration,
with 0.818 seconds of lifetime overlap. All 12 native action requests had matched
successful outcome records and no unresolved intent. B1, B2, B3, B4 and B12
passed while all 171 stand-in characters arrived. This proves these workers,
not the complete toolkit or owner-session acceptance.

Qt/Writer pair: an initial run failed B12 because five kioworker helpers remained
alive. The shell wait also did not prove each worker exit, so that report is
retained as failed evidence. A dedicated pair driver now verifies both return
codes, reads matched successful native journal outcomes and reaps new private-lab
job helpers using process identities. The corrected pair passed B1, B2, B3, B4
and B12, with 11 Qt requests, 89 Writer requests and 0.799 seconds of overlapping
native request intervals. Five private kioworkers were reaped. No process
exclusion was added to the harness. Writer still uses measured 16-character
chunks; a general bulk-input fix remains pending.

Fresh GTK4 launch, raw multiline input, selection, deselection and scrolling also
passed with the shared controlled API. B1, B2, B3, B4 and B12 passed. The job
pair cleanup is valid only for its exclusive private lab; production owner-session
process leases remain incomplete. Current project gates are pending.

Current B8 regression: two fresh raw GTK3 DrawingArea canvases, with no editable
text accessibility path, received distinct known text, one click and one scroll
per client. Both workers succeeded with 0.367 seconds of lifetime overlap.
All 12 native requests had matched successful journal outcomes. B1, B2, B3, B4
and B12 passed while all 171 stand-in characters arrived. This proves the canvas
fixtures, not a universal raw-input toolkit claim.

Final shared-raw project gates passed: typecheck, complete bounded suite 572
passed, 45 skipped, zero failed, 3734 assertions across 130 files. Native and
platform skips do not close their coverage rows. The private lab mode was reset
to protected after owner-side full-mode test setup. No owner-session activation
or release acceptance is claimed.

Shared-raw publication source binding at df3bc11, historical after launch edits:
- `ghost.py`: `f6041274b9302aa2149a9fb3b9cbff18027b6efac99c7d31a90758b205c2b7c2`
- `action_control.py`: `e2afb76247dff996a31d720833d603ef123dee95a00c5aeabd7906b37271a26b`
- `raw_task.py`: `00ea37a66cfe2a11367fbd81ffb4cf43105de3435505f2556ef7a85b3539a423`
- `native_text_task.py`: `055fa5e32e9887f43b4a42a4b41782e838e99d7f3528541ed538abeba57413e8`
- `qt_task.py`: `a8c4954c61f38274de73bef3809a3eca33f3a455140b24d241c1e7e16a36964f`
- `writer_task.py`: `dd72ca69f09c71922b8b5d4ba40135184dd86b5164118673040d3376af3e1e62`
- `clipboard_task.py`: `60bcdc15bd320395d00b431fc1b316d7a0133e6beb3f64c9e586cc125cfea742`
- `two_clipboards.py`: `b9a304bc9f0dfebd05709eb639d313a68a1027b8e506ddde30ce1da6389f4afe`
- `two_toolkit_tasks.py`: `cdc0960061c2347b51a250353ca6c762fd6afd6b22ae4ac0cf5855c0fffb22ce`
- `two_canvas_tasks.py`: `023048717389451a179a5f442258f35567d26c2c83222871c638e545ced8344c`

## Native settings preview

Scope: owner-side GTK4 settings window in the private lab, English prototype.
Sources: owner protected/full settings request;
[Gtk.ApplicationWindow](https://docs.gtk.org/gtk4/class.ApplicationWindow.html)
and [GLib.idle_add](https://docs.gtk.org/glib/func.idle_add.html) official API
documentation, reviewed 3 October 2026.
The UI must show the applied mode, exact one-use approval, recent journal
outcomes and errors. Disk work must run outside the GTK main thread; refresh
is on demand with no polling service. Normal GTK widgets inherit the lab theme.
No actual owner display integration or owner theme match is claimed.
Same-user cooperative policy remains the controller limit.

Native probe passed against these sources: mode roundtrip, exact one-use
approval, replay refusal, visible journal parse error with disabled write
controls, recovery, close while storage is locked and agent-targeting refusal. The probe uses a temporary
controller state directory and private lab keyboard navigation, not owner input.
Initial probe failures are retained locally: GTK4 labels exposed clipboard
actions and radio controls exposed no Action method. The corrected probe uses
button actions and normal keyboard navigation, then checks checked state and
persisted controller behavior. An initial fixture cleanup argument was wrong;
that process was explicitly reaped and subsequent runs reaped the UI normally.
Review found two UI defects: JSON-valid incomplete records escaped the visible
error path, and a running worker could keep the process alive after close while
waiting for a lock. Both regressions failed against a locally reconstructed
pre-fix UI snapshot, then passed on the corrected source. Display fields are
validated before settings writes, and render failures also disable write
controls. UI lock waits have a three-second deadline and a close cancellation
event. A transaction already holding the lock may finish; closing cancels waits,
not an in-progress atomic storage write. An out-of-range timestamp is also
rejected visibly before writes. The base action controller is unchanged.

The final private screenshot was inspected: readable controls and activity,
without clipped text at 1920 by 1200. Other sizes, complete screen-reader
behavior, localized UI and actual owner theme matching are not measured.
The lab logged missing Settings/Inhibit portal interfaces and an AT-SPI cache
warning. These are retained, not suppressed. The lab disables portal use and
does not establish production portal integration. Native UI acceptance remains
limited to the explicit interaction and error checks above.

Final typecheck and complete bounded project suite passed: 572 passed, 45
skipped, zero failed, 3733 assertions across 130 files. Opt-in and platform
skips retain their original scope and do not establish native release coverage.
Public publication audit passed over 786 files with no findings; staged
Gitleaks found no leaks. Raw private probe logs and reconstructed pre-fix
sources remain excluded. Source binding:
- `native_settings.py`: `f6accd9fd31626d649fed6cffce1f3b31b849e8b59fdb3a1a5d6c636b339d41c`
- `native_settings_probe.py`: `685f155bebca33daaaca4dc9496d4e1119d220f678a337b764855452334c9b6b`

## Native Chromium toolkit check

Source: BAR.md B5, B6 and B7 task matrix. Scope: installed Chromium 153 on
Wayland, fresh private-lab profile and offline local fixture. No owner profile,
account, screen or input is used. A browser toolkit check does not substitute
for the required owner-session native application integration.
Required evidence: controlled launch, accessibility state, native press/text/
selection/scroll, fresh background pixels, matched native journal outcomes,
private process cleanup and B1, B2, B3, B4, B12 harness isolation.
The original launcher failed on a mapped Chromium window because the launch
environment tag was not observable. Root PID plus kernel start time now
complements that tag, only inside an already-proven private lab scope.
Two identity checks passed, including rejection of a reused PID's different
start time and malformed/PID-only markers. A no-window process with its tag
removed survived failed launch cleanup on the f52ef6b source snapshot. The
same regression passed after correction, with no leftover process or marker
and a durable error outcome. B1, B2, B3, B4 and B12 passed on the fixed run.
The failed snapshot run is retained and its process was reaped by the fixture.
Ownership of every untagged descendant and production process leases remains
incomplete. No process-scope allowlist was added.

Current Chromium fixture passed accessibility initial/final text, one native
button press, 927 English/Arabic characters, full selection, caret reset and
wheel scrolling. All eight native requests had successful journal outcomes.
B1, B2, B3, B4 and B12 passed, including launch while the stand-in typed and
complete private-job process cleanup. Initial-vs-final pixels changed, and a
strict wheel-frame check observed changed text-row pixels and a post-scroll
rendered stamp in 0.311 seconds, across three captures. The stable pre-wheel
baseline and stamp exclude deselection repaint and caret/arrow changes.
This observation interval is not a general latency or performance result.

Initial task failures are retained: accessibility method/name selection errors,
observer text lag, an overly strict zero-scroll expectation, and unchanged
immediate wheel pixels. Fixture reports now coalesce event-triggered updates
and retain a sequence number. The wheel check waits only within a strict
two-second deadline and still fails if fresh pixels never arrive. These are
measurement corrections, not a claimed general bulk-input backend repair.
Earlier weak initial-vs-final images do not establish wheel-frame freshness.
The new root marker also passed the two-canvas raw launch regression: distinct
text, click/wheel, twelve successful native outcomes, 0.366 seconds of overlap,
and B1, B2, B3, B4, B12. Other older launch-bound native results are historical
after the ghost.py and launcher changes; they are not current-source evidence.

Firefox is absent from the current PATH and is not measured. XWayland,
Chromium clipboard edge cases, complete owner integration, theme inheritance,
whole-system comparison and final owner acceptance remain incomplete.
Final typecheck and complete bounded project suite passed: 572 passed, 45
skipped, zero failed, 3733 assertions across 130 files. Native/platform skips
remain opt-in and do not close unmeasured coverage. Public audit passed over
790 files with no findings; staged Gitleaks found no leaks. Private reports,
diagnostic frames and old-source snapshots remain excluded. The private lab
was returned to protected mode after each fixture.

Current source binding:
- `ghost.py`: `9c3aadf393291f1e53db81143d33739d7f19b5a3c872a8dfe5cb84e544505ae5`
- `agent_launch.py`: `d0fa2ddd20b827caeea7bb133c130c7adcde3e5374ffe7df4a707f6d422ca0dc`
- `process_scope.py`: `c598c523e85301f34c65f0997f00f56c65b17a356bd720b8fcc83d99f7eeba6f`
- `browser_task.py`: `f00f1bc8753130eb46b0372231355d27afa061d78011e9299838517a0c28072d`
- `browser_fixture.html`: `31e1fe94a893fe3aa5d1e7e3785bb59d3ccda6544408b864cad6638b33095187`
- `process_identity_test.py`: `3ad08e36692837e621b1fa266057feaac0ff7c3f9c14a890e44e330949897f62`
- `launch_cleanup_task.py`: `9636530207ca0af51bdc1beaffb809e77d939b0faca037114d95953e8aad8dbf`

## Owner-native preparation

Scope: read-only Hyprland endpoint preflight. No owner display capture, window
query, input, plugin load or service restart is performed by this command.
Filtered GTK/KDE appearance preparation is documented below; wiring it into
the native session remains pending. The existing broad dconf copy is not
evidence for owner-native theme matching.

Sources reviewed 3 October 2026:
- [Linux unix(7), SO_PEERCRED](https://man7.org/linux/man-pages/man7/unix.7.html):
  Linux-specific peer credentials on Unix stream sockets, applicable here.
- [Hyprland plugin usage](https://wiki.hypr.land/Plugins/Using-Plugins/):
  plugin version compatibility guidance. Observed installed compositor version
  is 0.56.2, commit `efb50993780079460b0cbed1363e2166a2de1d9f`.
- [BAR.md](BAR.md): the owner-imposed final acceptance boundary. Endpoint
  preparation does not authorize or satisfy actual owner-session activation.

`native_host.py plan` binds IPC and Wayland endpoints to one live peer PID,
kernel start time, UID, socket identities and reported ABI. `check --plan PATH`
repeats the read-only check and refuses stale identities. Only `j/version` is
sent; no Wayland protocol requests are sent. Directories and sockets must be
owned by the current UID and not writable by group or others. Directory and
socket identities are rechecked after the response. Version replies are
bounded to 32 KiB and three seconds; plan files are regular, not symlinks, and
bounded to 64 KiB. These are cooperative same-user checks, not authentication
against a malicious process running as the same user or an OS security boundary.

Nine synthetic checks pass using real Unix sockets: stable plan, stale process,
ABI and socket identities, unsafe paths/permissions, socket symlinks, malformed
and oversized version replies, distinct peer rejection, stalled-reply deadline,
bounded regular plan files, and unknown schemas. The distinct-peer branch uses
a controlled credential stub; separate compositor processes are not exercised.
A condition synchronizes server request observation before the assertion.
Private-lab and read-only owner metadata plans both passed, and owner plan
revalidation passed. Raw endpoint identities stay in ignored evidence files.
No owner applications were started and no screen or input was accessed.

Endpoint identity is preparation state. Theme matching, isolation, owner
activation and comparative performance remain not measured. Full project
acceptance remains incomplete. Scoped publication gates passed: typecheck; complete bounded suite, 573 passed,
45 skipped, zero failed, 3736 assertions across 131 files. Native opt-in skips
do not count as measured owner coverage. Publication audit passed over 793 files with no findings. Staged Gitleaks
found no leaks. Both reviewer findings were corrected: bounded observation
synchronization in the socket test and direct official source links here.

Current source binding:
- `native_host.py`: `e0e74fbdb23e38c47db9c85322e29c133222b84d4957cb9a65c152520256dd53`
- `native_host_test.py`: `51943268d9fc5212a9a8cfb42716366adb39b6d70f03841d70f8a47d5be57d2b`
- `tests/native-host.test.ts`: `48f225ed4636e3346297272db0a891dbd217a4cc61070e0e58a47994d93ff920`

## Filtered native appearance preparation

Scope: stage only named GTK/KDE visual settings into a fresh private directory.
Do not copy dconf, bookmarks, histories, executable settings or session state.
This preparation does not activate the owner session or prove visual parity.
Sources reviewed 3 October 2026:
- [GTK4 Settings](https://docs.gtk.org/gtk4/class.Settings.html): settings.ini
  properties, including theme, icons, font and cursor. Desktop-provided settings
  can override files; libadwaita has separate color-scheme behavior.
- [KDE themes](https://develop.kde.org/docs/plasma/): color schemes populate
  kdeglobals and can include separate GTK CSS. CSS/assets are outside this
  initial metadata staging scope, so their visual effect remains not measured.
- [KConfig introduction](https://develop.kde.org/docs/features/configuration/introduction/):
  group/key configuration and global settings. The allowlist is an owner privacy
  choice, not a platform mandate. No KConfig expansion suffixes are propagated.
Implementation: `src/native-appearance.ts` is a separate preparation helper.
It is not wired to the old broad private-display copy. The CLI is:
`bun experiments/ghost-cursor/native_appearance_stage.ts SOURCE_CONFIG PRIVATE_PARENT`.
Only GTK3/GTK4 settings.ini and kdeglobals are read. Unknown keys/groups,
KConfig expansion/lockdown suffixes, bookmarks, dconf and session state are
excluded. Source files must be regular, final-component nonsymlinks, valid
UTF-8, at most 1 MB and stable during reading. The source root must be a real
directory. Staging creates a fresh 0700 directory and 0600 files, removes its
partial output on error, and reports absent or empty optional settings.
This is cooperative filesystem preparation, not a same-user security boundary.

Seven behavioral tests pass. The prototype-named group and missing-root tests
failed on a reconstructed pre-fix helper before passing after correction.
Failure logs and that helper remain ignored evidence. The standard reviewer
found the prototype lookup issue; the spec reviewer also found missing-root
success. Both findings were corrected and verified.

Final-source staging of owner-selected GTK3/GTK4/KDE files passed into the
private lab. A GTK4 process on the lab display read back all five selected
properties exactly: theme, icon theme, font, cursor theme and cursor size.
The inherited file did not request gtk-application-prefer-dark-theme. Reading
a theme name does not prove installed compatible assets, CSS, libadwaita color
scheme or rendered parity. No owner display/window was queried or captured.
The lab Settings portal warning remains in the evidence log and prevents
claiming a complete portal/theme integration result. Qt readback was not run:
PyQt6 is absent and Qt6Widgets development metadata is unavailable; no packages
were installed for this check. Existing Dolphin/cursor visual evidence remains
separate and historical, not proof of the staged appearance on owner apps.

Current source binding:
- `src/native-appearance.ts`: `9bf5e4b9da51eefd6af07b5a792500011930c0ff1e20b598db965739441a2814`
- `tests/native-appearance.test.ts`: `a318f8389b3d99aabd75a68b960fab1ecfe2ec324967318ddc95161b34b3b9ad`
- `native_appearance_stage.ts`: `0afb4b4e2de98d80867c010c49cff903df1003e45980658bb0d146ee65777815`
- `native_appearance_probe.py`: `8f3ad471dd7809a6fae5f5ab0a907be5d89d0450aeea6073602de3aca8a11b8f`

Typecheck passed. The first full suite failed its tracked-source packaging
check because the new src helper had not been added to Git. That failed log
is retained. After explicit staging, the complete suite passed: 580 passed,
45 skipped, zero failed, 3761 assertions across 132 files. Public audit passed
over 797 files with no findings, and staged Gitleaks found no leaks. Native
opt-in skips do not close unmeasured coverage. Owner-session activation,
universal audit coverage, CSS/assets/portal integration, complete native
toolkit matrix and comparative performance remain incomplete.

## Native process unit identity

Scope: identify a generated native process unit by its systemd invocation,
exact budget-contained cgroup directory identity and member kernel process
identities. This does not enroll a process for input, launch owner applications,
modify the compositor, or authorize cleanup of an owner session.
Sources reviewed 3 October 2026:
- [systemd-run source manual](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml):
  transient user service units and explicit slice selection. Installed systemd
  is 259.9 on Fedora 44. The rendered freedesktop manual returned HTTP 403;
  the upstream source manual was used instead.
- [systemd resource control](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml):
  cgroup membership and slice hierarchy. Shared Orbit budget enforcement remains
  mandatory. An agent unit cannot adopt the whole lab or shared slice.
- [D-Bus dbus-run-session](https://dbus.freedesktop.org/doc/dbus-run-session.1.html):
  private session bus for one command. The probe will verify distinct buses,
  not infer isolation from the launch command alone.
This is cooperative same-user ownership, not a malicious same-user security
boundary. The read-only `src/native/lease.py` inspector requires a generated unit name,
an active valid InvocationID, the exact direct child of the caller's enforced
shared-budget slice, a canonical cgroup directory dev/inode, and PID with
kernel start time. It refuses the shared slice and sibling units. Membership
is a current snapshot, not retained pidfd authority or complete future-child
tracking. Batch member reads query the manager before and after the census;
they do not spawn a manager query per PID. Production callback cost is not
measured. No process environment is read and no process is killed by this API.
A caller inside its own unit is a legitimate member; the probe refusal covers
an outside caller, not unconditional self-exclusion.

Eight synthetic tests passed: changed invocation/directory, foreign cgroups,
path boundary, PID start time, malformed identities, restart during check,
legitimate same-unit caller, invalid names, and cleanup after stop failure.
Several cases share a test method. The two-unit lab probe passed with a distinct
private D-Bus socket for each worker. Each bus peer's actual kernel identity
belonged to its own lease. A child that cleared its entire environment and
called setsid remained identifiable by its cgroup. Each worker refused the
other's processes and an outside caller. Stopping one created unit killed its
root and detached child while the sibling stayed live; final cleanup left no
worker roots or detached children, and no generated units remained active.
No GUI application or compositor plugin was launched by this probe.

The first-stop-failure regression failed on a reconstructed old cleanup loop
before passing on the corrected implementation. Its first diagnostic run
failed an import setup, which is retained separately and is not regression
evidence. A separate live probe injected a timeout immediately after successful
unit creation: the error remained visible, and the exact created unit was
cleaned despite the incomplete launch response. Generated units are tracked
before the request. Cleanup attempts every tracked unit and preserves original
and cleanup failures together. Workers publish reports by atomic rename to
avoid a partial JSON startup race. Their 15-second RuntimeMaxSec is a fallback,
not the cleanup measurement. Raw reports and reconstructed fixtures stay ignored.

Current source binding:
- `src/native/lease.py`: `4437f27eb9a8b9053c580eac27e5329c3d74c605d4a15ce7c1f824a9cdd02c4e`
- `native_lease_probe.py`: `65d28c6b131292de1847906a080e2a3a4c3de2822afbc5c342532b43a549207d`
- `native_lease_test.py`: `2e584ec3945076d304f6cef793ea745781072f2f3b20f9a9cdc202de73a4c799`
- `tests/native-lease.test.ts`: `66ee9e125d343a666f1223d5a5e733549a9a2f5fe0ab818e0f50d3642ecf3d5f`

Typecheck and complete bounded suite passed: 581 passed, 45 skipped, zero
failed, 3764 assertions across 133 files. Native opt-in skips do not close
unmeasured coverage. Public audit passed over 801 files with no findings;
staged Gitleaks found no leaks. Owner input,
production plugin registration, real application/private accessibility bus
integration, full appearance parity and comparative performance remain pending.

## Native application scope launch

Scope: attach a compositor-spawned lab launcher to its own generated systemd
scope before it creates application clients. Keep Hyprland's existing silent
spawn rules, and provide private session and accessibility buses plus fresh
application profiles. This remains lab-only development, not owner activation.
Sources reviewed 4 October 2026:
- [systemd manager API](https://github.com/systemd/systemd/blob/main/man/org.freedesktop.systemd1.xml):
  StartTransientUnit, explicit PIDs and Slice properties. Scope membership must
  be verified after the start job, before client creation. The rendered manual
  returned HTTP 403; upstream source was used.
- [Hyprland rules](https://wiki.hypr.land/configuring/core/rules/window-rules/):
  matching/rule behavior. Installed 0.56.2 also supports the existing measured
  dispatch-exec rule syntax. Applying exec rules to a separate systemd service
  is not assumed to work, since it is not the compositor child process.
Session and accessibility bus sockets must belong to the exact generated scope.
Native applications must have new PIDs and private profiles, must not reuse
baseline instances, and must be cleaned by their exact scopes. Native scope,
application, input and noninterference checks are measured only in the private
lab, with the limits below.

The lab scope was outside the enforced shared slice despite its individual
memory cap. A real child budget check failed against the prior lab source and
passed after adding the shared slice. Initial missing-HOME setup diagnostics
are retained separately. New native application scopes support the same exact
InvocationID/cgroup/PID-start identity checks as services, without widening
membership to the shared slice or sibling units.

The launcher attaches its original compositor child PID before application
clients exist, then directly execs the application wrapper at that same PID.
A separate dbus-run-session child lost the existing exec rule/root identity;
that failed experiment is retained. Each worker has its own session and
accessibility buses, registry, profile and exact scope. Actual socket peer
identities must belong to the worker lease. Scope stop cleans activated helpers
and application children; RuntimeMaxSec is a fallback, not measured cleanup.

Review found that daemon activation inherited the shared lab profile. The
corrected launcher creates the private environment first and passes it to both
daemons. An actual D-Bus-activated Gio helper reports HOME, four XDG/profile
values, session/a11y addresses and PID/start identity. Its session address may
contain the daemon-generated GUID, which is verified against the same socket
path rather than rejected as a different bus. A reconstruction with omitted
daemon environments activated this helper and failed on shared HOME/XDG values
and absent private accessibility address. The fixture service directory was
made explicit in that reconstruction to isolate environment inheritance from
service discovery. The corrected source passes the activation profile and
scope checks. The initial import setup and overly strict GUID comparison
failures remain private diagnostics, not successful regression evidence.
Bus startup now has its own deadline after scope readiness.

Fresh GTK4 Text Editor and Qt Dolphin use distinct scopes/private buses and
perform real native text, selection, clicks and scrolling concurrently.
GTK4 verifies 1525 characters, selection and first-character geometry;
Dolphin verifies path entry, item selection and scroll geometry, with fresh
captured pixels. Native journal outcomes are balanced and successful.
The driver stops both exact scopes, restores its original controller mode,
and checks root process identities disappeared. This is a lab fixture with
cooperative same-user identity, not production enrollment or an OS security
boundary. A preexisting single-instance Dolphin scenario is not measured.

Appearance staging still does not prove visual parity: the captured Qt window
remains light while the owner theme is dark. Private portal/PipeWire warnings
remain in launcher logs. No owner windows or input were accessed. Production
owner integration, universal audit integration, all toolkit/clipboard cases,
cursor reference comparison and whole-system comparative performance remain
incomplete. This publishes reviewed experimental source, not release acceptance.

Current source binding:

- `lab.py`: `68359d54432e8736362256f1b9b48fefe43406f7b7cefdce33e07a1701f798ba`
- `native_scope_launch.py`: `ddb60eaa6c1fcb5f5c10d48a5113fc54cdc2cce7407baaf5ef15fa6407808ad2`
- `native_activation_fixture.py`: `4983e607aba282d463bbb7f99fa699b95ea9acce5ebdec03e006dc193d4c08a1`
- `native_scoped_apps.py`: `a122bc928a8252010ed5dd839e094fe3c931474466c852bf84b1460da7adccd2`
- `native_budget_probe.py`: `65dbfc7a319dc455549b61e0bd0e08c96d1519dc99a1c56690718eedca72a9db`

Final current-source scoped application run passed B1, B2, B3, B4 and B12,
with zero agent diagnostics, 20 successful native outcomes and 1.787 seconds
of overlapping native action intervals. Both activated profiles and bus peers
passed, and both scopes cleaned their root identities. The two-service lease
probe also passed on the current inspector, including untagged detached
children, sibling refusal and exact stop cleanup. Both private development
labs were stopped after preserving evidence.

Typecheck passed. The complete bounded suite passed: 581 passed, 45 skipped,
zero failed, 3764 assertions across 133 files. Skipped native opt-in cases are
not acceptance evidence. Publication audit passed over 805 files with no findings; staged Gitleaks
found no leaks. Full owner-session release acceptance remains incomplete.

## Native Qt appearance environment

Scope: supply the installed KDE platform theme to the scoped private application
when filtered kdeglobals has been staged. Qt's native platform-theme selector
is distinct from its Wayland platform plugin. Reviewed 4 October 2026:
[Qt application source and documented options](https://github.com/qt/qtbase/blob/dev/src/gui/kernel/qguiapplication.cpp)
confirm QT_QPA_PLATFORMTHEME and child inheritance. Installed Fedora provides
KDEPlasmaPlatformTheme6.so. The owner's named KDE style is Darkly and the color
scheme is MaterialYouDark. Values are read only through the visual filter;
application/session state stays private. No owner capture/input is authorized
by this preparation. Current Qt visual correction and visible cursor recording
remain pending, and no performance parity is claimed.

The KDE platform theme is now selected only when filtered kdeglobals exists
and the installed theme library is a regular root-owned file without group or
other write access. A missing or unsafe installed library fails explicitly.
The resulting Dolphin capture is dark, with the owner-selected palette/style
and icons visibly applied. No owner screenshot was taken; this is private-lab
visual inspection, not exact full-theme parity. GTK4 remains light, and its
supported color-scheme/settings delivery remains pending.

A new visible recording runs the same scoped GTK4/Dolphin input tasks with two
independent compositor cursors. It deliberately arranges only the private lab
windows and keeps seat focus on a fresh simulated-person window. That window
continues typing while the agent cursors move. The owner pointer check uses the
simulated pointer, not the person's actual device. A separate hidden-workspace
harness measures B1/B2/B3/B4/B12; the recording is not substituted for it.

The first unanchored recording failed when Dolphin acquired the lab seat focus;
the plugin refused input and the failure remains in evidence. A following
setup refused the leftover private special workspace. Cleanup now reconciles
its actual state rather than toggling an already-closed workspace back open.
A Path.open opener mistake failed before launch and remains diagnostic evidence.
Review also found setup outside cleanup and SIGTERM bypassing worker finally.
Setup is protected, cleanup attempts are independent with aggregated errors,
SIGINT lets the worker execute its finally, and exact published unit names are
reconciled even if the actor already died. Not-found/inactive and loaded/inactive
are distinguished from manager errors. Unexpected failed states remain errors,
and surviving units are stopped and checked. Workspace restoration and mode
restoration are independent. These are cooperative lab controls, not a
malicious-same-UID boundary or production owner-session supervisor.

Two pure failure tests reconstruct setup outside cleanup, fail on the faulty
fixture, then pass corrected source: setup failure releases the simulated
person, and a stop failure does not skip wait, mode restore or metadata cleanup.
Initial harness import/setup failures were retained separately. Fixture imports
are mocked; these tests never open or capture a display. A real SIGTERM probe
observed 13 surviving scope members, then cleaned those exact units explicitly.
The corresponding SIGINT probe cleaned every captured PID/start identity and
restored the original controller mode. A separate live injected SIGKILL after
two scopes existed left the actor error visible, while the recording supervisor
reconciled both exact scopes and cleaned all captured members and stand-in
windows. Raw fault probes stay ignored.

The lossless APNG encoder retains original screenshot PNGs, merges only equal
consecutive pixels, and verifies every decoded frame plus its duration. Its
recording overhead is not production performance evidence. Final-source hidden-workspace run passed B1, B2, B3, B4 and B12 with 20
successful native outcomes and 2.321 seconds of native input overlap. The
final visible recording has 43 encoded frames, 2.439 seconds of native action
overlap, exact continued stand-in typing and one simulated pointer position.
All decoded pixels and frame durations are preserved. Original PNG data totals
3,654,027 bytes, compared with 1,575,724 bytes for APNG; raw originals remain
private. Both cursor overlays were visually inspected in actual compositor
frames, without adding labels or drawing substitute pointers. APNG SHA-256:
`aa4fdf06083fdadc6f790719c832980512e10d150468366541de1f00b2514bd6`.
The already-dead-actor probe also passed on final source, keeping its error
visible while cleaning both scopes and the stand-in. The private lab was
stopped after evidence preservation. Typecheck and complete bounded suite passed: 582 passed, 45 skipped, zero
failed, 3768 assertions across 134 files. Native opt-in skips do not close the
remaining toolkit/owner coverage. Publication audit passed over 808 files with no findings; staged Gitleaks
found no leaks. This is experimental publication, not full owner-session acceptance.

- `native_scope_launch.py`: `ddb60eaa6c1fcb5f5c10d48a5113fc54cdc2cce7407baaf5ef15fa6407808ad2`
- `native_scoped_apps.py`: `a122bc928a8252010ed5dd839e094fe3c931474466c852bf84b1460da7adccd2`
- `native_scoped_cursor_demo.py`: `d06b8cf78841352c612ce3ead095f305350a15d4b5eb4b4691dbd9846cf90b81`
- `native_cursor_cleanup_test.py`: `e071a57f37c447853364a70ae18513fdfd43cd574758b9f8ca67850b3d39397b`
- `tests/native-cursor-cleanup.test.ts`: `1386f3377eea681514a6db31fe6293f1cf1613959b0f3ced8e8491103250486b`
