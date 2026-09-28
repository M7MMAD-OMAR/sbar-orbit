# Codex Desktop owner cutover plan

Status on 28 September 2026: preparation only. The person's running Codex
Desktop and profile have not been changed by this plan. The current Desktop
uses a stdio app-server and cannot serve an Orbit attached client. The staged
candidate uses the same Desktop version, adds an owner-only socket, and bundles
a Codex CLI with a per-thread model tool ceiling. All completed combined runs
have used a disposable profile and a fake model credential.

## Preconditions before touching the personal session

1. Keep the reviewed candidate in a stable, user-owned private directory. Pin
   every file with the candidate manifest and verify that its source Desktop
   version and original binary still match the installed app.
2. Complete a disposable end-to-end run with one permitted Orbit tool and no
   exposed host tools. Close and reopen both the Orbit client and its owner
   Desktop in separate tests, then verify the same project, thread and answer.
3. Prepare a Codex-only launcher wrapper and a copy of the existing local
   `chatgpt.desktop` entry. The wrapper must select the pinned candidate and
   its bundled CLI, the stable user-only authority socket, the normal personal
   home and the existing Wayland flags. If the installed version changes or
   validation fails, it must launch the original app without creating an
   attached authority. Do not replace the existing entry during preparation.
4. Prepare a rollback that restores the exact desktop entry and original
   launcher without touching another application. Check available disk space
   for a private copy of `~/.codex` and `~/.config/Codex`. Keep that copy
   unreadable to other users. The final copy must be made only after the
   original Codex exits, so its SQLite and session files are at rest.

## Personal cutover, only after the user approves the interruption

1. Record the running Desktop process identity and current executable. Ask the
   app to close cleanly, then verify that its app-server and Electron children
   exited. Stop if any identity changed or another Codex process is still using
   the profile.
2. Make the private stopped-state profile backup and record file counts and
   hashes of the key state files. Do not copy it into Orbit's client home.
3. Launch the candidate as the sole owner with the original personal home and
   Electron data path. Do not start a second app-server over the same profile.
   Verify both owner sockets are private and live, and that the owner's
   app-server reads the same project and thread identifiers as the baseline.
4. Start one Orbit private client through `launch-app codex active`. Verify the
   original Desktop and Orbit show the same selected project and conversation.
   Check the user's account identity and dark appearance in the real owner
   window, and confirm that Orbit's client can read the conversation without a
   copied login token. Do not run a personal model turn or edit a project as
   part of this check.
5. Only after those checks, install the Codex-only local launcher override
   atomically. Close and reopen Codex through that launcher and repeat the
   owner socket, account, project and conversation checks. Confirm that a fresh
   Orbit client attaches again.

If a check fails, stop the candidate and Orbit client, leave the original
desktop entry in place or restore its saved bytes, and restart the original
Codex. Restore the stopped-state profile backup only if candidate writes made
the original profile unusable. Preserve any changed profile separately for
diagnosis before restoring, so a rollback does not silently discard work.

The user's current unsent text could be lost when the running Desktop closes.
This is the reason the actual cutover needs a chosen moment and explicit user
approval after the disposable checks, wrapper and rollback are ready. No
other application is part of this operation.

## Prepared owner launcher

`scripts/launch-codex-owner.ts` is a source-only wrapper. It has not been
installed as a desktop entry or run against the person's profile. It reads
`~/.config/sbar-orbit/codex-owner.json`, requiring an owned, canonical home and
`.config` directory, a private `0700` Orbit config directory and an owned,
single-link `0600` config file. The file format is:

```json
{
  "format": "orbit-codex-owner-v1",
  "candidateExecutable": "/USER_HOME/.local/share/sbar-orbit/codex-candidates/NAME/app/ChatGPT",
  "manifestSha256": "64 lowercase hexadecimal characters"
}
```

The absolute executable must use the durable Orbit candidate directory. The
wrapper runs the full candidate verifier before launch. On success it selects
the candidate's bundled `app/resources/codex`, fixes the owner socket at
`/run/user/<uid>/codex-desktop/app-server-bridge/app-server.sock`, and uses the
existing Wayland and input-method flags. It passes the desktop entry's Codex,
HTTP, HTTPS and file URLs as separate arguments. HOME, CODEX_HOME and XDG
variables keep their caller-provided values. The wrapper does not set an
Electron user data directory.

If the config or candidate is missing, stale or unsafe, the wrapper selects
`/usr/lib/chatgpt/ChatGPT` with the same launch flags and URLs. It removes any
inherited bridge, candidate CLI and candidate app-directory overrides from
that fallback environment. `--dry-run` prints only `choice` and the names of
environment keys set for the candidate. It does not print paths, URLs,
credentials or environment values, and does not start Desktop. The wrapper
does not make the original Desktop attachable until a reviewed cutover uses it
as the normal owner launcher.

For a later review, invoke `bun run scripts/launch-codex-owner.ts --dry-run`
without changing any desktop entry. A `candidate` choice only means the files
passed validation at that moment. It does not measure the real account, owner
socket, project list, conversation list or appearance.

The wrapper is preparation only. Five focused disposable tests passed with 31
assertions, and typecheck passed. They covered a valid pinned candidate, a
changed candidate CLI, unsafe config paths, a temporary candidate path, URL
handling and a dry run that opened no Desktop. No test installed this wrapper,
launched it with the person's account or proved restart continuity.
