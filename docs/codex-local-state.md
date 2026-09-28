# Codex Desktop private state follow-up

Measured 28 September 2026 on the installed Linux desktop app. These findings supplement `docs/validation.md`. The earlier experiments below are retained as their original results; the later result is recorded here.

## Later private state result

`launch-app codex` now creates a private disk home while leaving the installed app and original home in place. It reads the original Codex state, then copies the global sidebar state, configuration and dconf preferences. SQLite online backup captures both `state_5.sqlite` and `thread_history_1.sqlite`, including uncheckpointed WAL rows. Rollout JSONL files use Btrfs reflinks. The account copy has its refresh token cleared. The private mount hides the original `/home` and presents the private home at the expected path. The snapshot checks source identity, rejects links and oversized files, and retries a source change up to three times. A failed attempt removes its partial private copy.

In the final private pilot, the report counted 23 projects, 687 threads, 687 paginated threads, 690 rollout files, and a 2,165,903,360 byte private history database. The UI displayed the user's dark theme, pinned conversations, project names and account identity. After opening one older pinned conversation and waiting up to 60 seconds, the historical message content appeared. An earlier 45 second observation of the same conversation still showed a loading spinner, so the delay matters. The app-server log recorded `thread/read` requests without a logged thread, SQLite or rollout failure. It also reported missing plugin cache paths, MCP startup problems and an unavailable keyring provider. These did not stop the observed historical content from loading, but tool parity remains unmeasured.

During a private pilot, the original `auth.json` and `config.toml` SHA-256 values matched before and after. The copied state is not atomic across the JSON and SQLite stores, and it is a point in time copy. Without an explicit project grant, the original project directories are hidden inside the private app, so their names in the sidebar do not prove file access. Sending a prompt through the private account, token refresh, plugin use, personal project edits, and retention of changes made only in the private app after closing it have not been measured. A broker crash can leave a private disk copy until a later launch sweeps it; the sweep checks the owner's process identity and keeps recent or active copies.

The original `config.toml` digest later changed, with a recorded modification at 11:29 AM, and changed again at 11:32 AM after all private Codex windows and snapshots were gone. Its writer was not captured, so these observations cannot assign the change to either Orbit or another process. The original file was not restored or edited as part of this work. The source `auth.json` digest stayed unchanged in the final check.

## One selected project directory

The optional `projectPath` grant exposes one chosen directory at its original absolute path inside the private Codex mount. It refuses the home root, top-level hidden application directories, symbolic path components and changed directory identity. The project directory is a live writable bind for the session. Its original contents are not copied, and intentional edits there reach the user's files immediately.

For a project the person has selected, the action includes `{"type":"launch-app","app":"codex","profile":"active","projectPath":"<absolute project directory>"}` with the placeholder replaced by that project's canonical path. Without `projectPath`, no home project directory is shared.

A native fixture bound a disposable project, wrote through the private mount and read the changed source file afterward. A sibling host directory remained hidden, the private home marker stayed visible, and a nested Bubblewrap process exited successfully. In a later installed Codex private window, the project chooser's Home view listed only the selected disposable project under that home. The project was highlighted in the chooser, but the pilot did not prove that the Codex main window accepted it or edited its files. No personal project directory was granted in these pilots. The grant does not make paths outside the masked home exclusive; the outer native mount still includes the rest of `/`.

## Auth-only private session

The app opened in Orbit's private display with the existing account identity. The sidebar showed "No projects" and "No chats". Opening Plugins displayed loading placeholders and then "Failed to load plugins" with "Timeout". The session closed after 69 seconds. The original `auth.json` and `config.toml` SHA-256 values matched before and after, and the host desktop process remained alive.

The private app-server log contained 411 events at close. A bounded classification found 6 messages containing 401 or Unauthorized, 4 containing 403 or Forbidden, and 2 containing timeout text. The diagnostic did not retain the full log records or identify the affected endpoints. These counts cannot establish whether the status codes came from account APIs, plugin APIs, or telemetry. They cannot explain the Plugins timeout by themselves.

## Local state dependencies

The host `state_5.sqlite` has 23 project rows, 24 project root rows and 682 thread rows. Every recorded thread rollout path, and 23 project root paths, is under the host home directory. All 682 rollout files existed on the host at inspection. The host `sessions` tree held 679 JSONL files totaling about 8.6 GB. The host `.codex-global-state.json` contains project ordering and assignment keys. The current private Codex route copies `auth.json` only and hides the original `/home`, so those local stores and paths are absent from the private app.

This matches the [OpenAI app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadListParams.json): an ordinary `thread/list` request may scan JSONL rollouts to repair metadata unless `useStateDbOnly` is true. The [OpenAI rollout implementation](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) has separate scan and state DB modes. Missing local state is a strong explanation for the empty lists, but the UI itself was not observed to reload after restoring those files.

## Limited state copy experiment

An uncommitted prototype copied `.codex-global-state.json` with a size limit and made a SQLite online backup of `state_5.sqlite` into the private home. The backup helper saw the original home through a read-only bind. Focused tests passed, including independent private writes and unchanged fixture source hashes. The real app still showed only its splash screen for 68 seconds, so neither the project list nor an existing conversation was measured. The private app-server log had 109 events and a timeout warning from `codex_models_manager::manager`. The original auth, config and global state hashes matched before and after. The original state database hash changed during the run; the exact writer was not identified. The private app could not write the hidden host home. The prototype was reverted after this unsuccessful pilot.

The database alone is insufficient evidence of usable conversation history: its 682 rollout paths point to files hidden from the private mount. Making those files available without allowing the second client to mutate the host state needs a separate measured design. Plugin loading is a separate capability and its timeout cause remains unproven.
