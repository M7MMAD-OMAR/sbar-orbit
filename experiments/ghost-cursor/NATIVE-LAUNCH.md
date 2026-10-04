# Native application lifecycle

Reviewed 4 October 2026. Runtime component, private compositor evidence only.

`src/native/application.py` admits a complete launch request before allocating a
profile or starting a process. Protected mode requires exact one-use approval;
full mode retains durable intent and outcome records. The owner-facing broker
and settings UI are not yet wired to this component.

The supervised worker joins its generated scope before starting private session
and accessibility buses. Registration returns a compositor launch token before
application exec. The launcher acknowledges exec through the kernel process
environment and checks exact scope membership. Each application has its own
HOME, XDG runtime and buses, with an absolute prepared Wayland socket. Host
credentials and activation tokens are not inherited. This is cooperative
same-user ownership, not a hostile-process security boundary.

Cleanup is mandatory in protected mode and still runs when journal storage or
caller budget revalidation fails. Parent EOF triggers audited supervisor cleanup;
the subreaper collects detached descendants. A stopped supervisor is resumed and
asked to terminate after the first five-second wait. A further three-second wait
failure attempts `cgroup.kill` through the captured scope directory, checking its
inode identity before opening the target. Only successful subtree termination
permits force-killing the supervisor. Missing or changed ownership is reported as
failure. Timeouts remain failures even if recovery succeeds. Journal lock
acquisition is limited to half a second; filesystem IO has no hard deadline.
The force-kill fallback is implemented but has not been exercised against a
stalled kernel process. Profiles remain available for caller-managed retention.

## Reproduction and current evidence

Run one bounded command at a time:

```sh
bun run scripts/limited.ts bun test tests/native-cleanup-control.test.ts tests/native-transport.test.ts
```

Three cleanup-controller checks passed. Three real supervised-process checks
passed: budget loss, stopped supervisor and rejected journal storage. The saved
pre-fix close behavior fails the budget-loss and stopped-supervisor checks; the
fixture recovery then reaps its processes. The first test authoring run failed
because it targeted the wrong journal filename and inspected exception text
instead of its type. That failure was retained and the assertions corrected.

For native integration, use `lab.py up --render-node` with a verified local render
node, load the version-matched plugin and hold the private pointer and keyboard
fixtures as documented in `PRE-MAP-PLACEMENT.md`. Run the absolute path to
`native_application_probe.py` through `lab.py run LAB --`, inside the shared
budget, then stop that lab even if the probe fails.

The final private GTK3 run passed nine checks: denial before resource allocation,
one-use approved launch, independent scopes and buses, detached child ownership,
paired cursor/click/text readback, preserved stand-in focus and text, independent
protected cleanup, failed exec cleanup and parent-death cleanup with journal
records. Worker logs and raw requests stay in ignored private evidence.
This run did not capture pixels. It is not visual cursor acceptance.

Runtime source SHA-256 for that successful run:

- `application.py`: `0a5cd473ef7994385e84389dfd1d0ce8993887e2686435382db383419d5cc835`.
- `application_worker.py`: `effade91058654e14a9a9dea72ee540d44dcb36ec67ed47a89f59221bab78d63`.
- `control.py`: `2332734a5d75f443f42616e6a9bdae87f2c1b27b61563456887fbbcc1ac57a27`.
- `transport.py`: `f0d6269d8a940916afa7c1785f897238b0eb68a43735fb958e557a618c05b1fb`.
- `supervise.py`: `675a7004231d00ce7e606bef0a3906b96d8e422a75738584ed8480f01826e5c5`.

The plugin is the unchanged artifact recorded in `PRE-MAP-PLACEMENT.md`.

## Repository validation

Bounded typecheck passed. The full bounded suite passed 586 tests with 45 skips,
zero failures and 3,782 assertions across 631 tests in 137 files. The skipped
platform and native tests remain outside this default gate. Both review axes
have no remaining actionable findings for this component.

## Remaining owner acceptance

Owner desktop activation, production broker routing, owner settings UI and the
full toolkit, clipboard, cursor and simultaneous-input matrix remain incomplete.
Current launcher appearance and comparative CPU, memory and latency are not
measured. Older GTK4 and Dolphin recording evidence covers the experimental
path, not this new launcher. No claim of faster operation or zero overhead is
supported. Final owner acceptance remains governed by `BAR.md`.
