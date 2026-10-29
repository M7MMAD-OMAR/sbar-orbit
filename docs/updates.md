# Safe native broker updates

Updated 22 October 2026.

Preserve active work. Preparing a version and activating it are separate operations. The managed update implementation obtains an idle broker update lease, serializes activation, checks service health, and retains recovery state when shutdown or activation is uncertain. Do not restart a shared broker with an active or starting session. A new process answering doctor proves service activation only, not native application acceptance. See [installation](agent-install.md), [native support](support-tiers.md) and [real results](native-opening.md).

## Desktop About page, measured 29 October 2026

`desktop/panel_about.py` shows the version, the loaded plugin source against this installation, the compositor ABI, broker health and uptime, and the update state. Check for updates reads the registry through `update check` and sends no owner data. Update now prepares the eligible version and calls `update activate` only when no session is open. Otherwise it names the open sessions and offers Stop idle sessions, which stops sessions that are not working and never a working one.

Real run on the live broker, rendered in a headless compositor: a real Calculator session on workspace 7 and another agent's Firefox session were listed as the blockers, with nothing restarted. Stopping the Calculator session through the CLI left only the other agent's session, and the page still refused, correctly. The registry check answered that 0.3.3 is the newest version the feed has, so no real update was applied. The apply path (`stage`, then `activate`) is covered against a fake feed in `tests/about_data_test.py`. This checkout is a source checkout, so `update status` reports it as not managed and the page disables Update now with that reason; the blocked frames use a fake feed that says managed and a real session list.

