# Native action controller

This private-lab controller supplies two modes and a synchronized local journal.
It is a foundation for owner settings and the native backend. It does not yet
cover direct plugin IPC or remaining imported accessibility actions, and it is not an OS
security boundary against arbitrary code using the same account.

Run commands inside a lab through `lab.py run LAB -- /usr/bin/python3 SCRIPT`.
Use the absolute script path because lab commands start from the private home.
The script is `action_control.py` in this directory.

The owner settings entry point selects `mode protected` or `mode full`. It is
separate from `act REQUEST`; action content never changes settings. Mode changes
clear any old approval and are themselves recorded. The default is protected.

In protected mode, the owner supplies `approve REQUEST`. The exact request is
matched using its UTF-8 SHA-256 fingerprint. The following matching `act REQUEST`
consumes the approval before sending input. A failed operation also consumes it.
Another request or a replay is refused. Only one pending approval is supported.

In full mode, `act REQUEST` executes without individual approval and records its
intent and outcome. Both modes retain workspace, target and mixed-client checks
in the plugin. Full mode does not permit mode changes through action content.

Supported requests are `ghost-key`, `ghost-type`, `ghost-texthex`, `ghost-click`,
`ghost-move`, `ghost-scroll`, `ghost-cursor`, `ghost-hide-cursor`, `ghost-release`
and `ghost-state`. Successful text replies include the transmitted key count;
other successful input replies are `ok`. Invalid targets are recorded as errors.

Settings and `actions.jsonl` live under the lab's XDG state directory in
`orbit-native-control/`. Files are private, use no-follow opens and reject
unexpected ownership, hard links and nonregular files. An exclusive advisory
lock serializes decisions and journal writes, while actions execute concurrently.
Intent is flushed and synchronized before
input; outcome is synchronized afterward. No journal write means no input.
Synchronization takes place in the controller process, outside compositor
callbacks. The previous latency microbenchmark is stale after the lock-scope
change. Current latency and whole-system performance remain not measured.

`status` inspects settings and records. It exits nonzero if a begin has no
outcome, including an in-flight action, interruption or an outcome write failure. That state is
unresolved, not success. Raw journal contents stay local and are not published.
Hardware power-loss guarantees and malicious same-user tampering are not tested.

Behavioral checks: `bun run verify tests/native-action-control.test.ts`.
Real native check: run `harness.py --agent COMMAND` inside the lab, with COMMAND
running `control_task.py`. This exercises a GTK3 fixture while the stand-in types.
The fixture's launch is test setup and does not establish logged launch coverage.

## Native CLI integration

Running `ghost.py` as a CLI now uses the controller for its complete command.
Launch, accessibility methods, observations and capture each record intent and
outcome. In protected mode, use `cli-request -- ARGS...` to print the canonical
approval string for the corresponding `ghost.py ARGS...` command, then approve
that exact string through the owner settings entry point. No CLI action argument
changes the mode. Successful legacy zero-exit commands are recorded as success;
nonzero exits are errors. Output formats stay compatible with the native drivers.

A CLI target must have mapped windows only in the agent workspace. Accessibility
refs must resolve to that target PID. An approval for an action outside this
scope does not remove the scope checks. Shared native requests through `ghost.hypr` now use the controller. The Qt,
GTK, Writer and canvas workers use that helper. Direct plugin IPC, low-level
supervisor transport and imported accessibility actions remain outside this
cooperative API. Bounded tests that use the existing full-mode native
drivers must explicitly select full mode in the private lab as an owner test
setup step. The real protected-mode regression is `cli_control_task.py`, run
through `harness.py` inside the lab.

The shared native regression uses `control_task.py --shared-api`. It first failed
on the unwrapped helper because unapproved protected input succeeded. The
corrected helper passes denial, one-use approval, full input, error outcomes and
refusal when journal storage is unavailable. `two_clipboards.py` verifies all
12 copy/paste worker requests against matched successful outcome records.

`two_toolkit_tasks.py QT_PID WRITER_PID` verifies both worker exits, overlapping
native request intervals and private helper cleanup. It assumes an exclusive
private lab job. Its whole-lab process census is test-job cleanup and must not be
used as a production owner-session cleanup mechanism. No harness process
allowlist or success-after-repair rule was added. Writer uses 16-character paced
chunks because general bulk typing remains unresolved.

`two_canvas_tasks.py` launches two fresh raw canvases, measures their independent
text/click/wheel results through `two_tasks.py`, verifies all 12 native journal
outcomes and reaps both process identities. Run it through the lab harness with
full mode selected as an owner-side test setup. The DrawingArea fixture has no
editable accessibility path, so this checks raw input rather than editable-text
method substitution.

## Native owner settings preview

Run `native_settings.py` as an owner-side command inside the private lab. It opens
a normal GTK4 window outside the agent workspace. Choose Protected or Full
access, then Apply mode. Refresh reads the current settings and recent activity
on demand. There is no polling timer or persistent service. Storage operations
run in a single worker thread, outside the GTK main thread.

The most recent denied request can be approved exactly once. The UI shows its
readable command or decoded text and retains the original request for approval.
A consumed approval is not rearmed by Refresh. Failed journal reads disable
mode changes and approvals, show the error and allow Refresh after storage is
repaired. This preview inherits the private lab's GTK theme; actual owner-theme
matching and owner-display integration are not measured.
Lock waits stop when the window closes and otherwise time out after three
seconds with a visible storage-busy error. An atomic write that has already
acquired the lock may finish; closing does not roll it back.

Run `native_settings_probe.py` inside the private lab for the native acceptance
check. It uses a temporary state directory, AT-SPI button activation and private
lab keyboard navigation for GTK4 radio choices. It checks mode roundtrip,
one-use approval, replay denial, visible journal error, recovery and refusal of
the settings window by the agent targeting API. It also checks JSON-valid
damaged records, an out-of-range timestamp and process exit while the journal
lock is held. The probe changes only its
temporary controller settings. It is an owner fixture, not an agent action API.
It does not establish a complete screen-reader or localization acceptance.
