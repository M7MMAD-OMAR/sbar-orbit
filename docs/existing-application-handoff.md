# Existing application handoff

Native control follows the actual loaded plugin source and prepared compositor
ABI. The historical policy hold was retired on 22 October 2026. It is retained
in [the incident record](native-handoff-incident.md), not enforced as current policy.
See [current application evidence](native-acceptance-0.3.0.md).

Select exact address and stableId on a numbered workspace. Ordinary applications
grant their Wayland client's windows. A cross-client parented dialog instead
reports `windowEnrollment: selected-dialog-family`: only the selected dialog and
its transient descendants become input targets. Other windows of a shared portal
service are not enrolled or relocated. Clipboard and seat protocols remain
client-wide; this is cooperative control, not an OS isolation boundary.

If any surface of the selected Wayland client is receiving real owner keyboard
or pointer input, handoff returns `OWNER_BUSY` before changing enrollment or
lease state. This includes ordinary sibling windows and shared portal windows.
Owner focus and physical pointer coordinates remain unchanged. Do not force
owner focus elsewhere to make a claim succeed. One active lease is allowed per
Wayland client. Hand a portal back promptly after its exact dialog closes.
Opening, input acceptance, account UI and normal closure are separate measurements.
Never replace the owner profile or use a hidden substitute desktop.

The shared clipboard is bidirectional. Active leased clients receive the current
clipboard and PRIMARY selection, including later owner copies or text highlights,
even while unfocused. Their Copy actions can replace those same owner selections.
Pause stops agent actions, new lease broadcasts and the lease's unfocused
selection-write exception. Resume refreshes the current shared selections.
Pause does not revoke ordinary OS clipboard access or previously offered data;
this is not a clipboard privacy boundary.
