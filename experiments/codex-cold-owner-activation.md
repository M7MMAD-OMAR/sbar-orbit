# Fixture-only Codex cold owner activation

Status: measured on a disposable account on 29 September 2026. This does not
enable a public or personal Codex attach route.

## Source and fixture

The isolated Codex worktree `/var/tmp/orbit-codex-owner-cold-activation` starts
at exact tag commit `4607249e430dac1c961df4dc615beae88e33cec8`. It applies,
in order, `codex-thread-readonly-metadata.patch`,
`codex-readonly-metadata-cli-fix.patch`, `codex-cold-read-subscribe.patch`, and
`codex-combined-owner-ceiling.patch`. The zero-context patch combination placed
one `allowed_tools: None` on the `ClientRequest::TurnStart` variant in
`tui/src/app_server_session.rs`. The isolated source moved that field into its
`TurnStartParams` initializer. No installed Codex binary or source was edited.
The resulting source diff SHA-256 is
`12d114def1fe9457d26e0a6ad4e8a0db2dc6cb9110a8ac6dae33bd511678a417`.
The bounded incremental link exited zero in 51.48 seconds. Its copied fixture
binary at `/var/tmp/orbit-codex-owner-cold-activation-bin/codex` has SHA-256
`295c8d58012922d1cd6a1ebb870b2544cd33c51cf0d56e2c430998ae1d637f47`.
The combined source was subsequently committed on the isolated branch
`agents/codex-owner-cold-combined` at
`d5653e0da34e7e3fbbe69a4a70b5ee07f79d20ea`. The reproducible
[combined patch](codex-owner-cold-combined.patch) against the exact tag has
SHA-256 `8dddd58b53798e2d6948d994d1fe571e71be4fb243b627d5dd3a52724f09bd88`.
It excludes unrelated Cargo lockfile drift. Reverse application was checked
against that committed source, and forward application was checked in a clean
worktree at the exact tag. The patch is an experimental build input, not
an installed candidate or a public feature.

The standalone [backend fixture](codex-cold-owner-activation.py) creates a
temporary `CODEX_HOME`, local mock Responses API, and one saved conversation.
It starts an owner app server, saves a turn, stops that server, and starts a new
owner process with the same disposable account. A separate private client
reads the cold thread without loading it. Its direct cold `turn/start` fails.
Only the owner then calls `thread/resume` with the thread ID and
`excludeTurns:true`, with no model, cwd, approval, sandbox, or other overrides.
The private client sends the first follow-up with `allowedTools:[]`.

Run the backend fixture through the shared resource budget:

```sh
env ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-owner-cold-activation \
  ORBIT_CODEX_TEST_BINARY=/var/tmp/orbit-codex-owner-cold-activation-bin/codex \
  bun run scripts/limited.ts timeout 120s \
  /usr/bin/python3 experiments/codex-cold-owner-activation.py
```

It exited zero in about 51 seconds. The two owner PIDs differed. Cold metadata
reported `notLoaded`, and cold read changed no tracked state, history, rollout,
or writer lock files. The owner resume returned the same model, provider, cwd,
approval policy, sandbox, and reasoning effort as the saved start response.
The `config.toml` digest matched after owner activation and after the private
turn. The private client got one completion, the saved rollout contained its
input, and the local model saw two requests with tool counts `[8, 0]`.

## Copied Desktop admission

A separate CoW copy of the previously patched disposable Desktop ran from
`/var/tmp/codex-private-smoke-c/app`. Its `app.asar` SHA-256 is
`31a6f56fffb65d7dd3de01e01071016b1688af1591d2bdbcd7ec7a38c84deb33`,
different from the installed application. The fixture owner had a fake ChatGPT
account, fake project and local model. A private Orbit display used the copied
Desktop and the fixture-only Codex gate. The adapted runner at
`/var/tmp/codex-private-smoke-c/evidence/run-orbit-switch-codex.py` has SHA-256
`06bef672707d271160901f8b5a0bc8adc736adada9db60404d23ad4f7686073f`.
It explicitly stopped and restarted the fake owner, observed cold thread
status, then had only the owner resume the saved thread and compare its saved
settings. It did this before launching the private Desktop.

```sh
bun run scripts/limited.ts timeout 180s /usr/bin/python3 \
  /var/tmp/codex-private-smoke-c/evidence/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-c \
  "$PWD"
```

The first UI attempt stopped before owner startup because Chromium rejected an
overlong disposable socket path. The fixture root was shortened and the bounded
retry exited zero in about 59 seconds. The copied UI displayed the saved
conversation and submitted one text follow-up. Its
[private screenshot](/var/tmp/codex-private-smoke-c/orbit-client-after-write-first.jpg)
shows the user bubble and `Thinking`. The gate audit has exactly one allowed
`turn/start` and no `thread/resume` request from the private UI. The owner
socket identities stayed fixed during UI use. The saved owner rollout contains
the private user input, an assistant response, and task completion. Model tool
counts were `[12, 0]` for the owner turn and private UI turn. No private
`auth.json` appeared. The runner stopped its fake processes; a later process
scan found no process whose command referred to the disposable fixture root.

The screenshot does not show the assistant reply, so live reply rendering is
still unmeasured. The copied Desktop fixture has local composer defaults and
viewer hooks unavailable in the public path. This experiment also lacks an
atomic owner thread generation or lease check between metadata read and turn
start. It proves one fake account text follow-up after explicit owner
activation, not a safe general write capability, personal account continuity,
or full Codex tool access.
