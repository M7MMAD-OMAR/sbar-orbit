# Orbit 0.2.1

Prepared 14 October 2026. This patch preserves the owner-authorized desktop
demonstration, its corrected limitations and the approved visual guide.

The optional `desktop/guide.py` preview shows a compact Orbit badge, a cyan
Codex arrow and a soft monitor border. It is click-through, accepts no keyboard
focus, sends no input, and requires an explicitly selected monitor and private
position file. It is not enabled automatically. See [the guide](desktop-guide.md).

The pilot opened four real installed applications and saved a text file. The
initial pointer attempt interfered with the owner's pointer and was rejected.
A later calculator accessibility sequence produced 63 while sampled owner
pointer and focus remained unchanged. Its guide arrow was a separate visual
overlay, not a generic independent input device.

Existing Chrome control on workspace 4 did not complete because the host browser
adapter failed. Opening Telegram through Orbit also failed because native opening
was not configured. The [native handoff hold](native-handoff-incident.md) remains
active. This release does not claim universal application or platform support.

Uncommitted application discovery and Zen changes in the shared development
checkout are outside this patch. Other open draft repairs are not merged by it.
No persisted schema or service contract changes. The standard installer applies;
running sessions must finish before restarting the shared broker.

Local checks, independent review, archive integrity and installation receipts
are retained separately. A published release is a tested source delivery at its
stated scope, not acceptance of unmeasured owner handoff or external platforms.

The first provider run passed eight jobs but failed the Windows suite during
fixture profile removal with EBUSY after the stale-frame rejection assertion
had succeeded. Frame-consistency fixtures now use bounded Windows-only cleanup
waits. Persistent locks and nontransient errors still reject. This fixture repair
does not change production browser cleanup or the capture timeout.
