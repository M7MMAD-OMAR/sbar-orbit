# Codex fake account with an empty model tool set

This disposable fixture combined the selected fake ChatGPT account projection
with the previously built exact-tag `allowedTools` Codex CLI. It did not use
the person's account, Codex home, pointer, or windows. The candidate was a
copy under `/var/tmp/codex-private-smoke-w`; the installed Desktop files were
not changed.

The candidate copied the private Desktop ASAR from the earlier fake account
fixture and replaced only `app/resources/codex` with the stripped patched CLI
from the startup tool ceiling experiment. The CLI SHA-256 was
`ed53e302475acec23b8be11d8da1e04f6665b96d31a963381114ea0df2c9e31a`.
The candidate manifest SHA-256 was
`059ca4abb27c85bcc926c16ca72dd748583158db0f3df3db54fb17741feb9f0b`.
The candidate was selected through Orbit's public `launch-app codex active`
fixture with a fake plus account, local account check, local mock model, and
private Xvnc display.

The bounded command was:

```sh
bun run scripts/limited.ts timeout 240s /usr/bin/python3 \
  /var/tmp/codex-private-smoke-w/evidence/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-w \
  "$PWD" \
  --restrict-tools --public-attach
```

The mock model saw exactly zero tools in one request, and its no-tool turn
completed. The private Codex window showed the fake email, `Shared Fixture
Project`, and `Private fixture conversation` in dark mode. The private client
had no `auth.json`. Opening that conversation displayed `Attach-only
conversation viewer is unavailable`; the answer body was not shown. The
fixture's full UI assertion failed for that reason, so the command exited 1.
Its screenshots remain at
`/var/tmp/codex-private-smoke-w/orbit-client-first.jpg` and
`/var/tmp/codex-private-smoke-w/orbit-client-opened-first.jpg`. All private
processes stopped after the assertion.

This result combines fake account identity, project title, conversation title,
and a zero-tool new turn in one private run. It does not prove conversation
body access, an existing-thread tool ceiling, approved Orbit tools, safe
writes, a real account, or continuity after the person's app restarts. The
original personal Desktop was not attached.
