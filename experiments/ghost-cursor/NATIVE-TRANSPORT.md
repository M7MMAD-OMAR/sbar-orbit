# Prepared native transport

Reviewed 4 October 2026. Runtime component with private compositor evidence.

`src/native/host.py` retains the endpoint preparation and revalidation contract.
The old `native_host.py` command remains a wrapper. `NativeTransport` copies a
prepared plan so later caller mutation cannot rebind it. Before each action it
revalidates the host, then checks the connected IPC peer and current socket inode
before sending. It checks the host again after reading the result. Actions are
not retried after an uncertain or failed response.

Plugin actions pass through the supplied owner-configured controller, including
its durable intent and outcome records. Protected denial and journal failure
occur before an action reaches IPC. The controller remains a separate component;
the transport does not create an agent command for changing its mode. Scoped
enrollment verifies exact process membership before and after registration and
returns the launch token for the exec boundary.

The transport accepts the tested native plugin action names, not compositor
dispatch, window focus, mode changes or multiline requests. Requests and results
have byte limits, require the enforced shared Orbit resource budget, and the
action connection has a three-second deadline. Host
preflight and postflight each have their own bounded version request, so three
seconds is not an end-to-end action deadline. The source is cooperative code
under one OS user, not a security boundary against that user.

The exact Hyprland 0.56.2
[IPC implementation](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/debug/HyprCtl.cpp)
reads 1023-byte chunks until a short read. The transport ends its write half
after sending, so commands of exactly 1023, 2046 or 4092 bytes terminate normally.
The saved unfixed transport times out on the first boundary case against a real
Unix socket fixture. The fixed transport passes all three boundaries. The initial
negative fixture had a shorter server-side timeout and also failed; both failed
logs are retained. The corrected negative fixture allows the actual client
deadline to expire and produces no hidden retry.

## Checks

Run one bounded command at a time:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/native_host_test.py
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/native_transport_test.py
```

Host tests cover real Unix endpoint ownership, stale identity and ABI, unsafe
paths, malformed responses and version deadlines. Twelve transport tests cover
protected denial, full-mode success, durable journal failure, connected peer
mismatch, immutable plan copy, stale ABI, forbidden commands, malformed and
oversized responses, timeout without retry, exact chunk framing and scoped
enrollment checks, structured state-query responses and resource-budget refusal.
They do not connect to the owner's compositor. A bare `ok` is not accepted as
state data in either the runtime transport or the experimental dispatcher.

With a matching plugin loaded in a fresh private lab, run the absolute path to
`native_pre_map_probe.py --transport` through `lab.py run LAB --` inside the
shared budget. This uses real native scopes and the runtime transport to enroll
the GTK3 fixture before exec. It measures protected denial, one-use approval of
the cursor, full-mode cursor hiding and state reading, and refusal after actual
cgroup migration. Initial mapping and new-window mapping after reload preserve
stand-in keyboard focus without transient enter or leave events. Registration,
denial, approved action, hide, state and revoked-target refusal all have matched
journal records, with no unresolved requests. Fixture scopes and processes are
cleaned independently. The report binds the loaded plugin and runtime sources by
SHA-256; raw logs and journal requests remain private.

The historical integration run for commit 7926ff7 passed six requests with no unresolved
journal entries, preserving initial and post-reload mapping and refusing input
after migration. Runtime source SHA-256 for that historical run:

- `host.py`: `d8be87fd3354de860b8de8d351c65a68fc835c9bff30dce44290cbcb95d7d32a`.
- `transport.py`: `1c2185107fb7d117ee6a59fc2a0e8d6217035c0e0060df4cd89d155110c46b9c`.

The mapped plugin source and binary are the final pre-map artifacts documented
in `PRE-MAP-PLACEMENT.md`. The old bare-`ok` state response is also detected by
the saved unfixed-source test: acceptance and journal-outcome assertions both
fail; the fixed transport and experimental dispatcher reject that response.

The first full-suite run failed only the package source tracking check because
the new runtime files had not yet been added to Git's index. Its report is
retained. The intended source files were staged before the corrected validation
run; no package assertion or exclusion was weakened.
The corrected full bounded suite passed: 584 passes, 45 skips, zero failures,
3,776 assertions across 629 tests in 136 files. Bounded typecheck also passed.
These are component and repository gates, not final owner-desktop acceptance.

## Limits

This transport alone does not launch or supervise production application buses.
The new launcher component and its current source-bound evidence are documented
in `NATIVE-LAUNCH.md`. The production integration still does not
install a compositor plugin, expose owner settings, route every broker action,
or enable the feature on the owner's desktop. Those integrations and the full
toolkit, clipboard, simultaneous-input and cursor matrix remain required work.
The cursor-state probe is not visual acceptance or a typing benchmark. Total
CPU, memory and latency versus the previous runtime are not measured here.
