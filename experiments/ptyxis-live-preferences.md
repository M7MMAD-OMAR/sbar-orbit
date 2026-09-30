# Live Ptyxis preference bridge experiment

Measured on 30 September 2026 with the installed Ptyxis 50.1 package.
Experimental disposable-owner evidence only, not production or personal integration.

## Mechanism

Two separate `FedoraBackend` displays own separate runtimes, buses and copied
GSettings databases. Both launch the actual installed `/usr/bin/ptyxis` through
Orbit's generic supervised launcher. Their shells print sixteen generated `M`
characters and wait. No personal shell startup or content is used.

Each display has a separate Python GSettings endpoint. It listens for
`Gio.Settings::changed` on the fixed `org.gnome.Ptyxis` schema. As required by
[GIO's signal contract](https://docs.gtk.org/gio/signal.Settings.changed.html),
it reads the keys after registering the handler. A Bun coordinator forwards a
changed value to the peer's endpoint over an owned stdin pipe, waits for an
acknowledgement, and suppresses equal-value echoes. The endpoint calls
`Gio.Settings.sync()` after an accepted write. Disk synchronization does not
prove the app has rendered the change, so the harness separately waits for
visible text size changes on the owned display.

The endpoint accepts only `font-name` and `use-system-font`. Font writes accept
only three fixture strings, `Monospace 18`, `Monospace 30` and `Monospace 36`.
Boolean writes require an actual JSON boolean. Unknown keys, extra fields,
invalid IDs or invalid values are rejected and stop that endpoint. Runtime
checks require an owned private Orbit directory and the corresponding private
bus and configuration paths. These checks are not a complete security boundary
against a same-user process that can construct its own paths or environment.

All fixture settings are written to the two disposable databases. The
person's original dconf database is hashed before and after, with only an
unchanged boolean retained. There is no host bus connection or personal write.
The coordinator terminates its endpoints and closes both displays in `finally`.

## Evidence

Without forwarding, an owner-side font change did not reach the private side.
The private text span stayed at 347 pixels and the harness returned status 1.
This control ran before and after enabling and refining the bridge.

With forwarding enabled:

| Action | Setting check | Actual application evidence |
| --- | --- | --- |
| Owner fixture changes font from 18 to 36 | Private value becomes `Monospace 36` | Private text span grows from 347 to 709 pixels without reopening |
| Private fixture changes font from 36 to 30 | Owner value becomes `Monospace 30` | Owner text span becomes 583 pixels without reopening |
| Close and reopen private Ptyxis | Private value remains `Monospace 30` | Reopened text span is 583 pixels |

The owner window remained running while the private window reopened. The
coordinator forwarded exactly two writes. Separate endpoint controls rejected
an out-of-scope `custom-command` write and a numeric value for the boolean key.
The font remained unchanged after those rejected requests. Those validation
controls have not been run against a guardless endpoint.

An early run correctly propagated both setting values but failed the rendering
checks because capture occurred before repaint. Its reopened frame already
showed the changed font. The harness was corrected to poll actual glyph spans
rather than accepting setting propagation as rendering evidence. The final
enabled run passed all checks. `bun run typecheck` and `git diff --check` passed.
No new full-suite result is claimed for these experiment-only changes.

Artifacts:

- `output/ptyxis-live-preferences-2026-09-30/report.json`
- `output/ptyxis-live-preferences-2026-09-30/{baseline,owner-change,private-change,reopened}.jpg`
- `output/ptyxis-live-preferences-no-bridge-2026-09-30/report.json`

Commands:

```sh
ORBIT_PTYXIS_DISABLE_BRIDGE=1 bun run scripts/limited.ts bun run experiments/ptyxis-live-preferences.ts
bun run scripts/limited.ts bun run experiments/ptyxis-live-preferences.ts
```

The disabled control is expected to return status 1. The enabled run must return
status 0. Image measurements apply only to this generated text fixture, current
font rendering, viewport and software display. They do not validate arbitrary
screenshots or application rendering.

## Remaining work

This demonstrates live bidirectional font changes between two disposable
application owners, including application repaint and private-window reopen.
It does not attach the person's running Ptyxis, share their tabs or commands,
or forward changes to their original database. Boolean propagation, arbitrary
preferences, dynamic profile creation, resets, startup disagreement, concurrent
writes, conflict policy, endpoint or bus restart, write failures, queue limits,
notification loss, crash recovery and personal cutover are not measured.

The coordinator serializes observed events and compares cached values; it has
no durable revision store, transaction protocol or conflict protection. Its
queue is not bounded. Each write acknowledgement has a three-second timeout,
but that does not bound the entire queue. This prototype must not be presented
as a finished shared application authority or a production preference bridge.
