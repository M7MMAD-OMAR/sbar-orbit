# Codex personal attachment, static cutover review

Status on 29 September 2026: review only. This document does not activate a
candidate, query the person's Codex account, or change any personal app or
profile. A displayed email, project, or conversation title is not a pass for
the requested ability to read and write the same conversations.

## Present boundary

The person's installed Desktop currently owns a stdio app-server. Orbit's
public `launch-app codex active` path requires a live owner RPC socket and an
adjacent state socket, then creates a separate private HOME, Electron data
directory, display, and gate. It returns `UNSUPPORTED` before launch when the
sockets are absent. The public launcher passes neither a paginated page reader
nor its viewer flag, and its gate denies saved content and writes. It cannot
attach to the currently running stock process by selecting an Orbit action.
See `src/native-codex-attach.ts:14-27,114-210`,
`src/codex-authority-gate.ts:427-709`, and `docs/codex-attached-client.md`.

A copied Desktop has displayed a synthetic account, project, saved thread,
user message, and assistant answer through a fixture-only reader. That run
did not use the personal account. The test helper is not packaged for the
public route. Its per-page file fingerprint rejects observed concurrent
writes but cannot prove a coherent snapshot across state, history, and rollout
files. See `experiments/codex-paginated-private-ui-probe.md` and
`experiments/codex-paginated-wal-stale-guard.md`. The proposed owner-coordinated
repair and its unrun red and green gates are in
`docs/codex-coherent-snapshot-design.md`.

A deterministic fake mixed-store fixture then exposed a silent stale page:
state and rollout held two turns while history held one, and the current
helper accepted one turn with no file drift. A fixture-only checkpoint guard
rejected that exact lagging projection while preserving the normal two-turn
read. See `experiments/codex-paginated-cross-store-red.md` and
`experiments/codex-paginated-projection-lag-green.md`. The partial guard is not
a coherent snapshot and is not enabled in the public route.

A later disposable live-owner run displayed two completed owner turns together
in the same saved conversation under its project in the private Desktop. The
private home had no `auth.json`, the owner remained connected, and seven
watched source files did not change during the second private read. See
`experiments/codex-paginated-live-private-ui.md`. This measured the fake
account's short transcript, not the person's account or a long history. The
UI gate log still denied methods including `config/read`, `model/list`,
`plugin/list`, `threadSection/list`, `thread/attachment/list`, and
`config/batchWrite`. Full Codex capability parity is therefore not measured.

The existing owner wrapper is source only. It selects a manifest-pinned,
same-version candidate when its private config passes validation, otherwise
it launches the original installed executable. It is not installed as the
user's desktop entry. See `src/codex-owner-launch.ts:93-128` and
`docs/codex-owner-cutover-plan.md`. Changing a broker candidate variable alone
does not give the already running original process shared sockets. A restart
into a candidate owner is unavoidable for this design. The candidate may be a
separate app copy, so the installed binary need not be edited. Running that
candidate against the real profile can perform normal Codex writes, and the
requested future conversation edits necessarily change the shared data. A
strict requirement that the personal profile never change cannot coexist with
writing existing conversations.

On 29 September 2026, the wrapper's resource-bounded `--dry-run` returned
`{"choice":"original","setEnvKeys":[]}`. It did not launch Codex or change a
desktop entry. This confirms that the prepared candidate is not selected by
the current wrapper configuration; it says nothing about account parity.

## Gates before any personal cutover

| Gate | Observable pass | Stop condition |
| --- | --- | --- |
| Exact candidate | Candidate Desktop, bundled CLI, paginated reader, and gate are built from reviewed sources and pinned to the installed version in a complete manifest. Executed bytes remain the checked bytes. | Version, hash, source ASAR, owner, mode, or file identity changes. The current validation still has a same-user verification-to-execution race. |
| Read consistency | With a disposable owner writing WAL during pagination, the private client sees one coherent saved conversation or an explicit stale-read error. Main, WAL, SHM, and rollout bytes and metadata change only from the owner writer. Multiple pages, cursor changes, forks, reverts, archives, large histories, and restart are covered. | Mixed generations, silent stale content, private read mutation, orphan helper, timeout leak, or unsupported history shape. The current fingerprint is insufficient. |
| Account projection | A disposable signed-in owner fixture gives the copied client only bounded identity and routing fields. Its private home has no `auth.json` or token. Projects, saved titles, and full body appear through the same gate and copied app bytes. | Token exposure, credential field in any IPC/RPC reply, entitlement failure, empty Projects or Recents, or title without body. Real plan and workspace policy remain not measured. |
| Write authority | A disposable existing owner conversation accepts a private turn and preserves the owner's own turns, tools, cwd, approvals, environment, and live notifications. Busy owner turn, forged client, direct RPC/MCP, host command, and cross-session attempts fail before side effects. Only a broker-bound private executor and explicit tool set run. | Any owner tool exposed to the private model, cross-client callback or steer, owner profile command execution, unintended project mutation, or silent cold `thread/resume` write. The combined source patch is not in the Desktop or gate. |
| Continuity | Normal client close/reopen and owner close/reopen show the same project, full saved text, and permitted actions in disposable profiles. A changed owner socket identity invalidates stale private writers until reattested. | New blank profile, missing body, stale socket acceptance, duplicate turn, or regression after restart. |

The writable route needs an owner-side authorization boundary beyond a model
tool list. `thread/resume` on a cold saved conversation has already changed
rollout and SQLite files before a new turn. Exact-tag combined patches have
blocked active-turn steering and dynamic callback theft and applied a
per-turn zero-tool ceiling in fake fixtures, but the public gate still denies
turns, and complete existing-conversation behavior is not measured. See
`experiments/codex-existing-thread-resume-boundary.md`,
`experiments/codex-combined-owner-ceiling.md`, and
`docs/codex-writable-thread-plan.md`.

A copied private Desktop fixture advanced past composer configuration loading
but then attempted `thread/resume`. The gate denied it, no UI `turn/start`
occurred, and the typed follow-up was absent from the fake owner's rollout.
See `experiments/codex-fixture-composer-readiness.md`. The direct gate-client
saved-thread write experiment alone did not prove that the Desktop UI could submit.

A later fixture-only copied Desktop patch avoided raw resume for one already
loaded fake thread. Its UI submitted one text follow-up through the narrow
gate, and the fake owner's rollout recorded the user item and assistant
completion. The UI screenshot showed the submitted user bubble and `Thinking`,
not the assistant reply. Reopen, live completion notifications, cold threads,
tools, permissions, and real account continuity remain unmeasured. See
`experiments/codex-fixture-followup-ui-evidence.md`. This result does not
enable the public gate or remove the owner generation requirement.

## Reversible personal sequence after all disposable gates pass

1. Prepare and review one immutable candidate, owner wrapper, Codex-only
   desktop entry override, and rollback bytes. Validate a dry run without
   starting the personal app. Do not change other app launchers or profiles.
2. At a chosen interruption, record the original process and executable,
   close Codex normally, and verify its owner and children have exited. Stop
   if unsent user text or another process still uses the profile. Take a
   private stopped-state backup of `~/.codex` and `~/.config/Codex`.
3. Launch the candidate as the sole owner using the normal personal HOME and
   Electron data path. Its bundled CLI opens the original account and state.
   Verify private owner and state sockets, socket identities, original account
   identity, dark appearance, project IDs, thread IDs, and full saved content
   in the owner's window. No second app-server opens the same profile.
4. Launch one Orbit private client through the active action. Verify a
   separate display and pointer, the same account and projects, full content
   across more than one saved conversation, zero copied credentials, no raw
   owner socket in its mount, and no owner window input. Any mismatch or denied
   content is a failed cutover. A real model turn and file edit are separate
   gates, not implied by read parity.
5. Only after the read and safety checks pass, install the Codex-only desktop
   entry override, close and reopen the owner through it, and repeat the
   socket, account, project, full content, and private client checks. Keep the
   old entry bytes for immediate rollback.

On failure, close the candidate and private client, restore the original
desktop entry bytes if changed, and restart the original executable. Preserve
the candidate-mutated profile separately before restoring the stopped-state
backup if the original cannot read it, so rollback does not silently discard
new work. The candidate restart is a real interruption and cannot be performed
without affecting the user's current Codex window. The sequence above is a
future review gate, not authorization to execute it now.

Passing the read cutover alone would still fall short of the user's acceptance
criterion. Existing conversation writes, project files, all Codex actions,
other applications, and device access each require their own measured route.
Unknown measurements remain `not measured`.
