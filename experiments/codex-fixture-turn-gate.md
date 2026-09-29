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
