# Native action controller

This private-lab controller supplies two modes and a synchronized local journal.
It is a foundation for owner settings and the native backend. It does not yet
cover direct plugin IPC, accessibility actions or launches, and it is not an OS
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
lock serializes cooperative writers. Intent is flushed and synchronized before
input; outcome is synchronized afterward. No journal write means no input.
Synchronization takes place in the controller process, outside compositor
callbacks. A 100-query persistent-btrfs microbenchmark measured a 1.114 ms
median and 1.773 ms p95 for controlled hidden-window state queries. Direct
queries had a 0.016 ms median. Whole-system performance remains not measured.

`status` inspects settings and records. It exits nonzero if a begin has no
outcome, including interruption or an outcome write failure. That state is
unresolved, not success. Raw journal contents stay local and are not published.
Hardware power-loss guarantees and malicious same-user tampering are not tested.

Behavioral checks: `bun run verify tests/native-action-control.test.ts`.
Real native check: run `harness.py --agent COMMAND` inside the lab, with COMMAND
running `control_task.py`. This exercises a GTK3 fixture while the stand-in types.
The fixture's launch is test setup and does not establish logged launch coverage.
