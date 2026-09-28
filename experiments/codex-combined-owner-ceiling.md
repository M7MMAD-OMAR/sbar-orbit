# Combined Codex owner and tool ceiling candidate

The [source patch](codex-combined-owner-ceiling.patch) combines the opt-in dynamic tool callback owner route, opt-in active turn input owner route, and per-turn `allowedTools` ceiling. It targets exact Codex source commit `4607249e430dac1c961df4dc615beae88e33cec8`, tag `rust-v0.155.0-alpha.9.2`. The source worktree is `/var/tmp/orbit-codex-combined-owner-ceiling`. This worktree was created directly from that commit, then only the three candidate patches and their manual `turn/start` conflict resolution were applied. Legacy read-only RPC and other source candidates were not applied. The combined patch changes 15 source and test files. Cargo updated `Cargo.lock` locally during building, and that generated churn is excluded from the exported patch.

The manual merge keeps these admission rules. A `turn/start` carrying `allowedTools` may start only when Core is idle. With `CODEX_APP_SERVER_TURN_OWNER_EXPERIMENT=1`, an input from the recorded connection may steer its expected active turn only when it carries no new tool ceiling. Other connections use Core's idle-only path. Explicit `turn/steer` also checks the recorded connection and turn ID. With `CODEX_APP_SERVER_DYNAMIC_TOOL_OWNER_EXPERIMENT=1`, the dynamic tool request goes only to the recorded turn connection, and another connection's forged callback cannot resolve it. Both flags default off. The per-turn `allowedTools` route has no separate opt-in flag in this candidate.

## Build and provenance

- `git apply --check --cached --unidiff-zero` of the combined patch against the exact-tag index passed. `git diff --check` passed. The patch uses zero context and has SHA-256 `f22ffa532902f76592c4f37ad921d9f68af65ccb4bfa942b781e57521a3d56ff`.
- One bounded `cargo rustc -p codex-app-server --bin codex-app-server --offline` built and linked the combined source in 2 minutes 38 seconds, using the local extracted mold and mimalloc runtime. The resulting direct app-server executable reports `codex-app-server 0.155.0-alpha.9.2` and has SHA-256 `230e0646b084192ad32ecf1d403ad80007ef48ae2a73dc63a6e020c85a5f182d`. A preserved copy is `/var/tmp/orbit-codex-combined-owner-ceiling-app-server`.
- The build reused a disposable shared target directory. After tests, its prior app-server executable was restored to SHA-256 `c1214554e7ea7412cd9072e8f57f710539226b394260422c8170b5c1e46c4042`. No installed executable, personal Codex profile, window, screen, or pointer was changed.

## Disposable runtime results

All probes used the same combined executable, a temporary home and project, local model endpoint, and private Unix socket. The green probes enabled both owner flags. The two red controls ran the same executable with both flags off. The existing-thread tool ceiling red control was previously measured against a separate earlier candidate, as recorded in [its report](codex-app-server-per-turn-allowed-tools.md). The fixtures verify the actual direct app-server version and require the exact source commit.

| Probe | Red result | Combined green result |
| --- | --- | --- |
| Active turn input | Second client `turn/start` accepted into the owner's active turn with the same turn ID. Assertion failed, exit 1. | Second client `turn/start` and `turn/steer` rejected. Owner `turn/start` and `turn/steer` accepted on the original turn ID. Two model requests before release, exit 0. |
| Dynamic tool callback | Both clients received the same tool request ID; the model saw the second client's result and missed the owner's. Assertion failed, exit 1. | Only owner received the tool request. Second client sent a forged response with the owner's request ID. Model saw the owner result and did not see the forged result, exit 0. |
| Existing-thread model tools | Earlier candidate advertised 8 tools on the private turn, so the zero-tool assertion failed, exit 1. | Owner before: 8 tools. Private resumed turn with `allowedTools: []`: 0 tools. Owner after in the same thread: the original 8 tools. Separate owner control: 8 tools, exit 0. |

The exact JSON lines printed by the three green runs were:

```json
{"cliVersion": "codex-app-server 0.155.0-alpha.9.2", "ownerAfterPrivateInventory": ["create_goal", "exec_command", "get_goal", "multi_agent_v1", "request_user_input", "update_goal", "view_image", "write_stdin"], "ownerAfterPrivateTools": 8, "ownerBeforeInventory": ["create_goal", "exec_command", "get_goal", "multi_agent_v1", "request_user_input", "update_goal", "view_image", "write_stdin"], "ownerBeforeTools": 8, "ownerSeparateControlInventory": ["create_goal", "exec_command", "get_goal", "multi_agent_v1", "request_user_input", "update_goal", "view_image", "write_stdin"], "ownerSeparateControlTools": 8, "privateExistingInventory": [], "privateExistingTools": 0, "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8"}
{"cliVersion": "codex-app-server 0.155.0-alpha.9.2", "modelRequestsBeforeRelease": 2, "otherExplicitRejected": true, "otherRejected": true, "otherTurnId": null, "ownerExplicitAccepted": true, "ownerStartTurnId": "01a0ea5e-ab3a-7ca3-8cf1-78d5b2533231", "ownerTurnId": "01a0ea5e-ab3a-7ca3-8cf1-78d5b2533231", "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8"}
{"cliVersion": "codex-app-server 0.155.0-alpha.9.2", "completed": true, "modelSawOtherResult": false, "modelSawOwnerResult": true, "nonownerForgedCallbackSent": true, "otherToolCalls": 0, "ownerToolCalls": 1, "sameCallId": false, "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8"}
```

The same executable with both owner flags off printed these red control lines before expected assertion failures:

```json
{"cliVersion": "codex-app-server 0.155.0-alpha.9.2", "modelRequestsBeforeRelease": 2, "otherRejected": false, "otherTurnId": "01a0ea5f-4a43-72f1-8a5c-17bb84ffd815", "ownerTurnId": "01a0ea5f-4a43-72f1-8a5c-17bb84ffd815", "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8"}
{"cliVersion": "codex-app-server 0.155.0-alpha.9.2", "completed": true, "modelSawOtherResult": true, "modelSawOwnerResult": false, "otherToolCalls": 1, "ownerToolCalls": 1, "sameCallId": true, "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8"}
```

The green fixture files are [turn input](codex-two-client-active-steer-green.py), [dynamic tool callback](codex-two-client-tool-owner-green.py), and [existing-thread tool inventory](codex-existing-thread-tool-ceiling.py). The red controls are [turn input](codex-two-client-active-steer-red.py) and [dynamic tool callback](codex-two-client-tool-owner-red.py). All five fixtures now accept a direct app-server binary through `ORBIT_CODEX_APP_SERVER_BINARY`; the original CLI path remains available. `ORBIT_COMBINED_EXPERIMENT=1` enables both owner flags in the three green fixtures. The direct-binary fixture adaptations passed Python syntax checks.

## Limits

This is a combined app-server source and disposable runtime result. It does not measure `thread/injectItems`, realtime input, internal turn producers, every app-server RPC, disconnected owner recovery, or every owner registration race. The existing-thread tool fixture covers one saved-thread resume after a server restart; it does not establish all loaded or cold resume behavior, nor account continuity. It does not measure the private executor, Desktop UI, personal account, or other applications. A rejected non-owner `turn/start` may still perform pre-submission client-info or settings work; those effects were not audited. No claim of complete client isolation or user-ready installation follows from these probes.
