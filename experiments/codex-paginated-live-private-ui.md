# Disposable live Codex page read in a private Desktop

## Scope

This test combines the fake live Codex app server from
`codex-paginated-live-owner-read.py`, the fixture-only Orbit gate callback, a
read-only paginated page helper, and the copied Desktop viewer. The owner had a
fake ChatGPT Plus token, local model, project, and conversation. No personal
account, installed Desktop bundle, browser, or profile was opened or changed.
The Orbit public attach action remained disabled.

The page callback starts a new helper process for each private page request.
Its namespace receives only the six live SQLite main, WAL, and SHM files,
the `sessions` directory, the helper binary, and system libraries. It does not
receive the owner's auth file or socket. The helper fingerprints all six files
and the selected rollout before and after reading and rejects a changed source.
The test passed an earlier fingerprint after the owner completed another turn;
the helper explicitly returned `STALE: previous page version changed`.

## Bounded run

The bounded command exited 0:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
ORBIT_CODEX_COPIED_DESKTOP=/var/tmp/codex-private-smoke-u/app/ChatGPT \
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-paginated-live-private-ui.py
```

The first 1280 by 800 private screenshot is
`/var/tmp/codex-live-ui-evidence-j2_q4ncf/private-ui-first-opened.jpg`. It
visibly shows dark Codex, `Shared Fixture Project`, the saved title `Private
fixture conversation`, the user's text with that title, and the assistant's
`Orbit completed fixture answer`. After the same owner completed another turn,
the test opened a new private Desktop and the second screenshot at
`/var/tmp/codex-live-ui-evidence-j2_q4ncf/private-ui-second-opened.jpg`
shows `Owner fixture second live turn` and `Owner second answer became
visible` in the same saved conversation. No page snapshot was copied between
the turns. Both private Desktop homes lacked `auth.json`, while the owner
socket remained connected. The local model received one request before the
first screenshot and two by the second.

Each private UI gate audit shows two allowed `thread/read` requests and one
allowed `thread/turns/list` request. No write method was allowed through the
gate. The audits are in the evidence directory beside the screenshots.

The fake owner changed state WAL and SHM, history WAL and SHM, and the selected
rollout between completed turns. After the second owner turn, the seven watched
files had the SHA256 values below. The exact same values and file identity,
mode, size, mtime, and ctime were measured after the second private UI read.

| Owner source | SHA256 after second turn and private UI read |
| --- | --- |
| `state_5.sqlite` | `4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f` |
| `state_5.sqlite-wal` | `c2490ce8632f316bb44693abb8c33b27809552cf7c41811dbc97931e58ce8ed4` |
| `state_5.sqlite-shm` | `d9f5f201c4befd222289c836f875ea12937edade4a750441a84c18cdedd85be2` |
| `thread_history_1.sqlite` | `4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f` |
| `thread_history_1.sqlite-wal` | `eaf6e3d3c35e2f30661569f0e282fe5ed554ab9ae31acc83296684b406b673f1` |
| `thread_history_1.sqlite-shm` | `689157b4d91f26fc6c1d44264f475056ad190c0e0b1ea0fce8f55d7ccbfd6469` |
| selected rollout JSONL | `b16831f646efd4395e4668a3c6a42885c8c63ed9811ae2a7d34771cae3c8c518` |

## Limits

The second screenshot shows only the new turn. The first turn might be above
the viewport, but scrolling was not measured after the private processes
stopped. The screenshot does not prove both turns can be browsed together.
The fake project displayed `No chats`, while the saved thread appeared in
Recents. The harness started the thread with `/fixture/project` as its cwd,
but the fake state socket declared the project root as the different host
temporary path. It passed no projectId to `thread/start` and did not record
the raw or projected `thread.projectId`. Project membership is unmeasured.

The page helper checks a version before and after each page, but this does not
prove one coherent snapshot across all stores under every owner write
schedule. The run measured the full seven-file owner fingerprint after the
second UI read; it did not retain an outer fingerprint immediately after the
first UI read. The first UI's page helper still performed its internal checks.
No real account, larger history, owner restart, full transcript navigation,
private write into a saved conversation, or other application was measured.

## Corrected project fixture attempt

A later bounded attempt aligned the fake local project's root path with the
owner thread cwd `/fixture/project`. The retained screenshot at
`/var/tmp/codex-live-ui-evidence-izjjw_kg/private-ui-first-sidebar.jpg`
visibly shows `Private fixture conversation` nested under `Shared Fixture
Project`; Recents shows `No chats`. Raw owner metadata saved beside the
screenshot reports `projectId: null`, `cwd: /fixture/project`, and
`historyMode: paginated`. This indicates the UI can associate this fake
thread by matching the project root and cwd, without a thread projectId. The
gate metadata request completed, but that attempt did not retain its projected
value.

The corrected attempt stopped before clicking the title. Tesseract returned a
blank text box for the low-contrast nested title, and the fixture script
required an OCR hit. No page read, conversation body, or scroll was measured
in that attempt. A subsequent harness edit records projected metadata before
launch and adds a coordinate fallback limited to the fixed disposable 1280 by
800 display. That edit has passed syntax and type checks but has not run in a
bounded UI test. The first successful run above remains the only measured
live page display.
