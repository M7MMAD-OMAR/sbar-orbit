# Disposable Codex saved conversation follow-up

This measured one text follow-up in a disposable copied Desktop and fake owner account. The copied Desktop ran in Orbit's private display. The fake owner thread was already loaded, the owner socket identity stayed pinned, and all fake child processes exited. No personal Codex, browser, profile, pointer, or window was used.

## Five bounded UI runs

| Run | Result | Gate evidence |
| --- | --- | --- |
| Main public method hook | Composer kept the typed text. The renderer used a separate resume path. | One denied `thread/resume`, zero `turn/start`. |
| Main private method hook | Composer kept the typed text. The active path was still in the renderer bundle. | One denied `thread/resume`, zero `turn/start`. |
| Renderer execution hook | The raw resume stopped. Its page request used descending order, which the disposable reader rejected. | Zero `thread/resume`, zero `turn/start`, one unavailable page. |
| Ascending page hook | Metadata and page reads worked. Saved follow-up preparation then required `config/read`. | Zero `thread/resume`, zero `turn/start`, one denied critical config read during submit. |
| Text fixture follow-up | The private UI submitted one text message to the already loaded fake owner thread. | Exactly one allowed `turn/start`, zero `thread/resume`, six allowed metadata reads, and three allowed turn pages. |

The fifth run's [private UI screenshot](/var/tmp/codex-private-smoke-write-v/orbit-client-after-write-first.jpg) shows the submitted user bubble and a cleared composer with `Thinking`. It does not show the assistant reply. The fake owner rollout in `/var/tmp/codex-private-smoke-write-v/owner-codex-orbit-71637728/sessions/2026/09/29/rollout-2026-09-29T06-46-41-01a0eb0e-a7f3-7f70-9dc0-4fdb0fe5cdbc.jsonl` independently records the same follow-up as a user response item and completed item, followed by an assistant response and `task_complete` in the next turn. The second fake model request exposed zero tools, compared with 12 for the owner's original turn. The gate forwarded only one text input and `allowedTools:[]`.

The copied renderer's fixture branch checks a UUID thread ID, an idle owner status, a session ID, and matching metadata before and after a paginated page. It then establishes local stream role and conversation state without requesting owner `thread/resume`. The saved follow-up branch accepts one text item with no attachments and uses the already loaded owner's defaults. These branches require the disposable attach fixture flags. The default path remains unchanged, and the public gate still denies raw resume.

## Limits

This is a fake account text write measurement only. The gate has no atomic owner thread generation token, so the metadata checks do not establish a safe general attachment protocol. Cold saved threads, real account continuity, all Codex tools, approvals, attachments, live assistant rendering, reopening the updated private thread, and other applications remain not measured. The screenshot shows `Thinking`, while only the fake owner rollout proves assistant completion. The current gate does not forward raw owner notifications to the private renderer.

A next bounded test should project only the needed turn progress and completion notifications for the exact pinned fake thread, then verify that the private UI shows the reply and that reopening the same fake thread displays the saved follow-up. Any general owner capability needs an atomic thread generation or lease check before private execution. Raw `thread/resume` must stay denied.
