# Private Codex fixture Orbit tool action

## Scope and provenance

This is a disposable fixture result, not personal Codex support. The test used the copied Desktop at `/var/tmp/codex-private-smoke-write-v/app/ChatGPT`, a fake owner account and project under `/var/tmp/codex-private-smoke-write-v`, and a private Fedora display. Its copied Desktop SHA256 was `3ac47769a211d64007c7dd072142cd32f9cbea0aaeb5d1e632eec507689fa7a2`. The copied CLI wrapper launched the combined owner app server at `/var/tmp/codex-private-smoke-write-v/app/resources/codex-app-server`, SHA256 `230e0646b084192ad32ecf1d403ad80007ef48ae2a73dc63a6e020c85a5f182d`. The source for that binary was `/var/tmp/orbit-codex-combined-owner-ceiling`. No personal app or profile participated.

The gate accepts only one pinned fake thread, one text input, and a fixture opt in. It injects `allowedTools: [{ namespace: "mcp__orbit_private", name: "orbit_act" }]` for that turn. The caller cannot supply `allowedTools`, approval policy, sandbox policy, or other permission fields. The owner must already have that tool configured. The default gate still injects an empty tool list, and the public Codex launch does not set the fixture opt in.

## Red and green checks

The focused gate test failed against the previous gate because it accepted the new opt in without a pinned fixture thread. With this change, the focused gate and native attach tests passed: 9 tests and 220 assertions. Typecheck passed. The test also denies caller supplied tool and permission fields, cross thread IDs, and a nonfixture executable.

## Measured fake run

The final run used a newly started owner loaded saved thread. The owner connection stayed open as a subscriber. Direct owner reads showed `idle` before the private window and again just before submission. The fake model saw exactly `mcp__orbit_private/orbit_act` on the private turn. It requested one pointer action, received the tool result, and produced an assistant reply. The real Orbit fixture broker reported zero allowed pointer actions before the private follow up and one afterward, ending at `(421,319)`. The gate audit recorded one allowed `turn/start` and zero `thread/resume` requests. Both the user follow up and assistant reply were present in the owner rollout and visible in the private window. The owner's `config.toml` stayed unchanged between the settled startup baseline and the completed private turn. Owner SQLite journals and the rollout changed while the owner saved the turn. All disposable child processes exited.

The retained [result JSON](/var/tmp/codex-private-smoke-write-v/evidence/private-tool-result-8e76194a.json) identifies the [model record](/var/tmp/codex-private-smoke-write-v/model-tools-8e76194a.json), [owner rollout](/var/tmp/codex-private-smoke-write-v/owner-codex-orbit-8e76194a/sessions/2026/09/29/rollout-2026-09-29T07-45-29-01a0eb44-7f70-7021-9b02-44122d5a428c.jsonl), [gate audit](/var/tmp/codex-private-smoke-write-v/gate-audit-first.jsonl), [pre send owner status](/var/tmp/codex-private-smoke-write-v/owner-before-send-status.json), and [private window screenshot](/var/tmp/codex-private-smoke-write-v/orbit-client-after-write-first.jpg). Broker counts and the unchanged config assertion were checked live by the bounded harness and copied into the result JSON; the raw broker journal was not persisted separately.

## Limits

This proves one allowed Orbit tool action on one fake owner loaded thread with a copied Desktop and a controlled model. It does not prove personal account parity, all tools, approval prompts, concurrent owner edits, reconnect across owner generations, or safe public attachment. The fixture must keep an owner subscriber alive; without one, the app server unloads the idle thread and the private composer refuses submission. Public Codex attachment remains disabled.
