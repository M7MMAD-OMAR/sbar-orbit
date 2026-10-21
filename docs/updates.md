# Safe native broker updates

Updated 22 October 2026.

Preserve active work. Preparing a version and activating it are separate operations. The managed update implementation obtains an idle broker update lease, serializes activation, checks service health, and retains recovery state when shutdown or activation is uncertain. Do not restart a shared broker with an active or starting session. A new process answering doctor proves service activation only, not native application acceptance. See [installation](agent-install.md), [native support](support-tiers.md) and [real results](native-opening.md).
