# Codex metadata response projection

## Scope

The fixture-only paginated viewer sends `thread/read` with `includeTurns:false` and `readOnly:true` to the fake owner. The gate previously returned the owner result verbatim. The page callback for full turn content remains separate. The public launch route is still closed.

The copied Desktop uses `historyMode` to choose paginated hydration, `name` or `preview` for its title, `projectId` and `cwd` for project association, and thread identifiers, timestamps, status, source, and Git branch for conversation state. The rollout `path` falls back to an empty string in this view, so it is projected as `null`.

## Red and green contract

The fake owner response included `internalMarker` on the thread and inside `gitInfo`. Before the projection, both reached the private client. The focused gate test passed with assertions expecting those markers, which establishes the leak on the unfixed code.

The gate now checks the requested thread ID, required scalar types, enum values, empty `turns`, and a 64 KiB serialized response cap. It creates a new object from known metadata fields. Unknown keys are absent, `path` and `gitInfo.originUrl` are `null`, and malformed metadata gets a generic error. Section id, name, icon, and color are bounded and projected explicitly. The legacy full-turn opt-in route has separate behavior.

After the project and section fixture edit, the focused gate test passed with 3 tests and 144 assertions. TypeScript typecheck passed.

## Copied Desktop viewport

A separate bounded fake UI smoke loaded this gate source directly on a private 1280 by 800 display. The first screenshot at `/var/tmp/codex-live-ui-evidence-j2_q4ncf/private-ui-first-opened.jpg` visibly shows dark Codex, a `Shared Fixture Project` heading, `Private fixture conversation` under Recents, the first user message, and `Orbit completed fixture answer`. A later screenshot at `/var/tmp/codex-live-ui-evidence-j2_q4ncf/private-ui-second-opened.jpg` shows the same heading and title, plus a second fake user turn and `Owner second answer became visible`. The owner remained connected, the second UI read from live WAL without a copied page, and the private client had no auth file. Each UI gate audit recorded two allowed `thread/read` calls and one allowed `thread/turns/list` call, with no owner write method forwarded.

Both screenshots show `No chats` under the project heading. The fake owner thread started without a `projectId`, and its cwd was `/fixture/project` while the synthetic project root in the state socket used a host temporary path. Raw and projected `thread.projectId` were not logged. The visible heading does not establish that the saved thread is nested in that project. The first turn is also outside the second screenshot viewport, so these images do not prove the complete combined transcript on reopen. This is a visible synthetic viewer check for title and message text, not a project membership or real account result.

This only measures disposable fake account data. It does not authorize a production viewer or establish compatibility with the person's Codex account.
