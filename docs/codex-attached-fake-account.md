# Private Codex fake account projection, September 28, 2026

This is a disposable fixture measurement, not a measurement of the person's Codex account. The owner Desktop, account tokens, project and conversation were synthetic. The owner and Orbit client ran on a private display. The owner network namespace had no external network and served its own loopback account check and model response. The installed Desktop and personal profile were not modified.

The owner `account/read` returned a selected workspace id after the local `accounts/check` response matched the id stored in the fake auth fixture. Orbit projected only `workspaceRouting.chatgptAccountId` with an ASCII identifier check and a 128 character limit. The private Desktop projected that id into `account-info.accountId`; its `hasChatGptToken` remained false. Backend origin, routing override and token fields did not reach the private account projection. The normal owner account-info path remains unchanged in the synthetic test.

## Results

| Check | Observed result |
| --- | --- |
| Unfixed gate and Desktop synthetic assertions | Both failed on the missing account id, as expected. |
| Updated gate synthetic test | Two tests passed. Invalid, oversized and absent ids produced null. The fake token and backend origin were absent from the client response. |
| Updated Desktop account-info synthetic test | Passed. Only the private path received the valid id. Invalid and absent ids remained null; owner mode kept its original behavior. |
| Direct fake owner RPC | ChatGPT auth and account type, email, plan and workspace id were present. Both RPC error codes were null. |
| Public-staged fake UI | The Codex section showed the fake owner email in the footer, one project and a saved conversation title. The private client had no `auth.json`. |
| Open saved conversation | Failed with `Attach-only conversation viewer is unavailable`. The answer text was not shown, so conversation body parity is not measured. |
| Optional `--restrict-tools` fixture | Failed before UI: the mock model saw 12 tools where the fixture expected zero. The later UI run omitted this assertion. It does not prove tool isolation or write authority. |

The fake `plus` plan follows the Desktop's existing local Codex access branch. A real account's plan, workspace policy, entitlement and identifier shape are not measured. The identifier check can reject real formats not covered by this fixture. Managed plans use a separate workspace settings input and were not tested. The existing read-only gate still denies owner writes and conversation read until a separate safe read path is ready.

Private screenshots remain outside Git at `/var/tmp/codex-private-smoke-v/orbit-client-first.jpg` and `/var/tmp/codex-private-smoke-v/orbit-client-opened-first.jpg`. These disposable files are evidence of this fixture only.
