# Disposable Codex cold reply rendering

Measured on 29 September 2026 against a copied Desktop, a fake account, a
local mock model, and an Orbit private display. No installed Desktop, personal
profile, personal window, or personal browser was launched or changed.

The runner starts one owner, saves a conversation, stops the owner, starts a
new owner process, verifies that the saved conversation is cold, and lets only
the owner call `thread/resume`. The private Desktop then sends one follow-up
to that existing conversation. The fixture page reader copies the owner's
SQLite state and rollout into a separate directory when polling for the saved
private turn. It rewrites the copied rollout path and uses SQLite `DELETE`
journal mode so the read-only helper can open that copy inside bubblewrap.
The fixture gate projects completion from this saved page. These copies and
projection are test-only and do not implement a coherent live owner snapshot.

Run the four files in this directory together, with the previously prepared
disposable app and source-tag page helper under `/var/tmp`:

```sh
bun run scripts/limited.ts timeout 180s /usr/bin/python3 \
  experiments/codex-cold-reply-fixture/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-c "$PWD"
```

The final two-window bounded run exited zero. The first copied UI showed the
old answer, the private user message, and the new answer
`Orbit owner preflight answer` in the same saved conversation. After closing
that private window, a second private window with a different PID showed the
same saved content. The first gate allowed exactly one `turn/start`, received
no private `thread/resume`, and projected one saved-turn completion. The
reopened window sent zero `turn/start` and zero `thread/resume` requests.
The owner rollout held the follow-up and answer. The mock model saw tool counts
`[12, 0]` for the owner turn and private turn. The private home had no
`auth.json`, the owner socket identity was unchanged during UI use, and the
runner stopped the fixture processes. The visual artifact is
`/var/tmp/codex-private-smoke-c/orbit-client-after-write-first.jpg` and
`/var/tmp/codex-private-smoke-c/orbit-client-after-write-reopened.jpg`.

The first assertion was too weak: it matched the old answer while the new
turn still showed `Thinking`. A later run with a live page refresh failed
because SQLite backup had retained `WAL` mode and the read-only helper could
not open the page. After that was corrected, a screenshot visibly contained
the new answer but OCR missed the first word. The final assertion checks the
distinctive answer suffix and the screenshot was inspected directly.

This closes one fake cold-thread reply-rendering measurement. It does not
establish personal account attachment, an owner-coordinated snapshot, a
general cold activation protocol, full tools, simultaneous private clients,
owner restart after the private turn, or public Orbit access. The public gate
still denies this write route.
