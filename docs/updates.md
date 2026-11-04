# Safe native broker updates

Updated 4 November 2026. Historical measurements below retain their original dates.

Preserve active work. Preparing a version and activating it are separate operations. The managed update implementation obtains an idle broker update lease, serializes activation, checks service health, and retains recovery state when shutdown or activation is uncertain. Do not restart a shared broker with an active or starting session. A new process answering doctor proves service activation only, not native application acceptance. See [installation](agent-install.md), [native support](support-tiers.md) and [real results](native-opening.md).

## Published 0.4.2 and eligibility, checked 4 November 2026

GitHub v0.4.2, npm latest 0.4.2 and the English/Arabic website were verified separately. See [the dated release evidence](release-0.4.2-verification.json) for exact source/build/deployment identities and archive digests. SDK-cached metadata initially returned stale 0.4.1/404; fresh direct HTTP and actual downloaded bytes established publication. A zero publish exit code or a cached latest response alone is not publication proof.

The npm publication time was 3:51 AM on 4 November 2026 in Asia/Dubai. The 72-hour maturation floor is 3:51 AM on 7 November 2026 in that zone, not immediate automatic activation. Actual eligibility still depends on compatible version line, managed Linux installation and explicit opt-in; activation additionally requires the safe idle/health boundary. No owner broker or plugin was restarted or activated by publication or site verification.

## Windows updater development: cleanup remains unsupported

This is a source-development boundary, not a shipped Windows update/native-control claim for 0.4.2. Manual Windows version pruning fails closed with `supported: false` before deleting anything: "Windows version cleanup is disabled until kernel-qualified whole-directory quiescence can be proved; all versions are retained". Origin pinning or a process census cannot close the check/delete race, including an intermediate version still loaded by a GUI or MCP process.

The Windows updater design can retain side-by-side GUI/CLI/runtime versions without automatic pruning. Do not describe full component cleanup as implemented or delete retained versions to force progress. A real kernel-qualified whole-directory exclusivity gate and Windows runtime acceptance are still future obligations.

## Desktop About page, measured 29 October 2026

`desktop/panel_about.py` shows the version, the loaded plugin source against this installation, the compositor ABI, broker health and uptime, and the update state. Check for updates reads the registry through `update check` and sends no owner data. Update now prepares the eligible version and calls `update activate` only when no session is open. Otherwise it names the open sessions and offers Stop idle sessions, which stops sessions that are not working and never a working one.

Real run on the live broker, rendered in a headless compositor: a real Calculator session on workspace 7 and another agent's Firefox session were listed as the blockers, with nothing restarted. Stopping the Calculator session through the CLI left only the other agent's session, and the page still refused, correctly. The registry check answered that 0.3.3 is the newest version the feed has, so no real update was applied. The apply path (`stage`, then `activate`) is covered against a fake feed in `tests/about_data_test.py`. This checkout is a source checkout, so `update status` reports it as not managed and the page disables Update now with that reason; the blocked frames use a fake feed that says managed and a real session list.

