# Two-client Codex tool owner red fixture

Measured 28 September 2026 with the installed `codex-cli 0.155.0-alpha.9.2` and a source worktree at commit `4607249e430dac1c961df4dc615beae88e33cec8`, the `rust-v0.155.0-alpha.9.2` tag.

The runnable fixture is `experiments/codex-two-client-tool-owner-red.py`. It checks the source worktree commit and executable version, then creates a temporary home, Codex state, project, Unix app-server socket, two WebSocket clients, and a loopback mock model. It does not open Desktop, use an account, read a personal profile, or contact a remote model.

Run from the Orbit repository with its shared resource budget:

```sh
ORBIT_CODEX_SOURCE_ROOT=/path/to/exact-tag-worktree timeout 90s bun run scripts/limited.ts /usr/bin/python3 experiments/codex-two-client-tool-owner-red.py
```

`ORBIT_CODEX_TEST_BINARY` may select a different executable. The default is `/usr/lib/chatgpt/resources/codex`. Its version must match the tag. The executable used here was the installed CLI, not one built from the clean source worktree. Matching version text alone does not prove byte-for-byte source provenance.

## Reproduction

1. The first client starts a persistent thread and completes a plain text warmup turn so the rollout exists.
2. The second client resumes that same thread. The first client starts a turn that asks the model to call one dynamic tool.
3. Both clients receive `item/tool/call` with the same `callId`. The second client replies immediately. The first client waits until the model makes its follow-up request, then replies.
4. The mock model's follow-up request contains `OTHER_CALLBACK`. The safe-contract assertion rejects a nonowner result and exits with code 1.

The first attempt without the warmup turn failed before the target assertion because `thread/resume` could not find a rollout. It is a fixture setup failure and is excluded from the result. After adding the warmup, both the worktree script and the exported Orbit script reached the target assertion. The two results were identical:

```json
{"completed":true,"modelSawOtherResult":true,"modelSawOwnerResult":false,"otherToolCalls":1,"ownerToolCalls":1,"sameCallId":true}
```

The exported script finished in 0.75 seconds and exited at `AssertionError: Model accepted a nonowner tool result`. The worktree script finished in 0.69 seconds with the same evidence. The test includes a bounded wait rather than relying on an arbitrary delay to make the second client's reply win.

In the exact-tag source, `thread_lifecycle.rs:335-342` builds the outgoing recipient list from all thread subscribers. `outgoing_message.rs:172-182` sends a tool request to that list, and `outgoing_message.rs:561-579` accepts a callback response without a turn-owner check for ordinary requests. `bespoke_event_handling.rs:1085-1113` creates the dynamic tool request.

This is a red test of one dynamic tool callback on one saved thread. It does not test a corrected source build, all tools, cross-client `turn/start` steering, account continuity, or Desktop rendering. Orbit's write gate remains closed. A later source change needs to select one turn execution owner, deliver side-effecting requests only to that owner, reject other responses and replay, then run this fixture against the patched executable for a green result.
