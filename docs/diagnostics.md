# Native diagnostics

Use `sbar-orbit doctor`, `sbar-orbit doctor --report` and `sbar-orbit diagnostics`
for the current broker and environment report. Installation and capability
metadata are separate from real application acceptance. A healthy service is not
evidence that input or capture works.

For a failed original opening, retain the request identity and private worker
journal. Do not blindly retry uncertain delivery or close an unrelated window.
Report the exact operation, source, host class and failure reason. Public reports
must omit account names, document text, personal paths, tokens and raw owner logs.

See [the application results](native-opening.md), [platform support](support-tiers.md)
and [the historical compositor incident](native-handoff-incident.md).

`APPLICATION_BUSY` means the selected Wayland client already has a lease or the
legacy plugin reached lease capacity. A new window in the same client does not
create an independent lease. Inspect active sessions and arrange an explicit
handoff; do not infer that a session is abandoned or stop another task automatically.
When the holder is an Orbit session the message names its label, task, state, idle time and
whether its adapter is alive, and `wait` queues for it (see
[multi-agent sessions](agent-interface.md#several-agents-on-one-broker)).
`SESSION_NOT_OWNED` means the session belongs to another agent connection; the message names
that owner. Stop only your own sessions with `scope: "mine"`.
`OWNER_BUSY` instead describes current physical owner input and its bounded wait.
`SESSION_CLOSED` describes ended control, not proof that a window closed. See
[handoff](existing-application-handoff.md) and [current acceptance](acceptance.md).
