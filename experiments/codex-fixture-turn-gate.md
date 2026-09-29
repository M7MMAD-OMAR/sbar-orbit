# Disposable Codex saved-turn gate

This experiment permits one text `turn/start` request for one specified saved thread in a fake Codex owner. It does not enable writes in Orbit's public Codex attach path. The option requires `allowFixture: true`, a private fixture executable, and a fixture page reader. The public launch passes `allowFixture: false`.

The gate accepts exactly `threadId` and one text input item. It rejects caller supplied tools, approval settings, extra fields, other thread IDs, and other write methods. The forwarded request sets `allowedTools: []` itself. The owner response is reduced to a turn ID, status, empty items, and null error. This guard is for synthetic testing only. A stock owner may ignore `allowedTools: []`, so tool isolation requires a separately verified patched owner binary. The test proves request projection, not the owner's actual model tool inventory.

## Evidence

- The baseline gate denied `turn/start`. The fixture gate denied invalid forms and other write methods, then projected one valid request to a fake owner. The gate test also checked that private owner response fields did not reach the client.
- The copied Desktop bundle showed the fake owner's project and saved conversation in Orbit's private display. The fixture flag exposed a composer, and the typed follow-up appeared in it.
- The UI submit failed with `App-server task is not ready: execution-config-loading`. The gate audit recorded no `turn/start`, and the fake owner's saved rollout did not contain the follow-up. The screenshot is `/var/tmp/codex-private-smoke-write-v/orbit-client-after-write-first.jpg`, the audit is `/var/tmp/codex-private-smoke-write-v/gate-audit-first.jsonl`, and the copied client log contains the submit failure at line 398.
- A fixture-only override made the local `readPermissionRefreshEnabled()` function return `false` in a unit test, while the normal path still returned its original value. A second UI run with this override produced the same submit failure. It did not establish that this function is the active blocker.

Static inspection found three bundle paths that can produce `execution-config-loading`: sidebar settings, queued composer preparation, and execution settings used for a thread session. The thread session path requires a non-null Statsig execution assignment with `defaultEnableFeatures`, plus effective values for `defaultModeRequestUserInput` and `conversationDetailMode`. The current log does not identify which path rejected the submit. Denied `config/read`, `model/list`, and `permissionProfile/list` calls are visible, but their role in this specific failure is unproven. They remain denied.

Tests: the two Orbit gate and launch test files passed, 7 tests and 156 assertions; `bun run typecheck` passed; the Desktop patch suite passed, 55 tests and one existing live integration skip. The copied UI has not submitted a saved turn. No personal profile, app, or installed ASAR was edited.

## Direct private tool client result

A separate disposable Orbit client sent one text turn through the fixture gate while the copied Desktop and fake owner were open. The default gate denied the same request first. The fake owner saved both `Orbit private saved-thread follow-up` and `Orbit private follow-up answer` under turn `01a0eacb-ae18-72e3-837c-483dda7f9597`.

The model requests exposed 13 owner tools immediately before the private turn, zero during the private turn, and the same 13 owner tools immediately afterward. The full owner tool name maps before and after were equal. An earlier initial owner request had 12 tools because the bundled `mcp__codex_app` plugin loaded later. A timed owner-only control, with no private turn, reproduced tool counts `[12, 13, 13]` and the same added plugin. The complete final sequence was `[12, 13, 0, 13]`.

After the owner completed its turns, the harness manually copied its fake saved history into the disposable page fixture and reopened the conversation in the copied Desktop. The private input and answer were visible in that window. This measures rendering after a manual snapshot refresh. Automatic live synchronization is not measured. The Desktop composer still fails at `execution-config-loading`, so this result does not establish UI-originated submission or full personal account behavior.

Final fake evidence: `/var/tmp/codex-private-smoke-write-v/evidence/core-direct-05e2535c.json`, `/var/tmp/codex-private-smoke-write-v/evidence/gate-audit-05e2535c.jsonl`, and `/var/tmp/codex-private-smoke-write-v/evidence/ui-manual-snapshot-05e2535c.jpg`. The owner-only control result is `/var/tmp/codex-private-smoke-write-v/owner-only-control-result.json`. These are disposable local files, not changes to the installed app.
