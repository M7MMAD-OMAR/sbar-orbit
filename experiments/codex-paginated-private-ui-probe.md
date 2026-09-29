# Disposable paginated Desktop viewer attempt

## Fixture-only injection

`prepareCodexAttachedLaunch` now accepts an internal
`fixturePaginatedPageReader` option. The function requires
`allowFixture: true`, a canonical executable inside the private Orbit
session, and no candidate manifest. Only then does it permit legacy
`thread/read` metadata, route paginated pages to the supplied callback,
and set `CODEX_LINUX_ATTACH_PAGINATED_VIEWER_READY=1` for the copied
Desktop. `prepareActiveCodexAttachedLaunch`, used by the public action,
passes `allowFixture: false` and has no callback. The active launcher
still denies saved conversation content. A focused test checks the
public restriction, the omitted `allowFixture` case, an outside
executable, the fixture flag, and the default absence of the flag.

The candidate was a separate reflink copy under
`/var/tmp/codex-private-smoke-u/app`, repacked with the external
Desktop patch at commit `9da0bd7`. The installed source ASAR SHA256
after repacking was
`8889a6e9aeba678a5d77876bcc9cfce3168ab47cc7bb4ba5856f80a3a32157a8`,
equal to the source hash recorded earlier in the retained fake candidate
manifest. The copied patched ASAR SHA256 was
`9b657e3ed7c1a9552043ddd19e2c96d2e76c2e90ed96c87c618367433ba50db2`.
The installed ASAR and personal Desktop were not modified.

## Bounded UI attempts

The first disposable owner launch failed because its temporary root made
Chromium's `SingletonSocket` path too long. Shortening the temporary
root resolved that failure.

The next owner created a fake saved paginated thread and completed its
model turn. The copied private Desktop launched on its own Xvnc display.
The screenshot at
`/var/tmp/codex-private-smoke-u/orbit-client-first.jpg` shows a dark
window and fake footer address, but Projects and Recents are empty, and
the main pane says `You don't have access to Codex yet`. The temporary
runner accidentally omitted the fixture page callback and UI flag in
this attempt, so that screenshot measures the default gate only. It
does not measure paginated hydration. The runner had no gate audit file;
page method counts for this attempt are not measured.

After correcting the disposable runner, its fake owner again completed
the saved turn. A direct owner `account/read` then returned a ChatGPT
plus identity but `workspaceRouting.chatgptAccountId` was null. The
runner's auth fixture lacked its synthetic `tokens.account_id`; this
explains the access screen without attributing it to the page helper.
Adding the synthetic account id in the next bounded run caused direct
owner `account/read` to exceed the runner's 10-second RPC deadline.
That run stopped before starting the private Desktop. Its temporary
owner config no longer contained the fixture `chatgpt_base_url` after
Desktop startup, but this observation alone does not prove the cause
of the routing timeout. No corrected private UI screenshot or gate
audit was produced.

The precise blocker at this point was workspace routing from the
synthetic account, before the copied Desktop can navigate to the
saved thread. The separate gate bridge probe in
`codex-paginated-gate-bridge.md` did return fake full turn content
through the real gate callback. Visible conversation body rendering
in the copied Desktop was not measured in that run. No personal profile or
installed application was used.

## Corrected synthetic UI run

The blocked run above used a stale copied ASAR. Its main bundle carried the
private account marker but returned `accountId: null`. The current source
patch projects `workspaceRouting.chatgptAccountId`. The stale ASAR also
lacked the paginated viewer markers. The disposable fixture initially
lacked `chatgpt_base_url` and local responses for
`/backend-api/wham/accounts/check` and
`/backend-api/wham/config/bundle`. These were fixture errors, not
observations about a personal account.

After fixing only files under `/var/tmp/codex-private-smoke-u` and repacking
its ASAR from the installed ASAR as a read-only source, a direct fake owner
`account/read` returned a ChatGPT Plus account, `fixture_selected` workspace
id, and no RPC error. The copied ASAR was checked for the workspace id
projection, `CodexLinuxAttachOnlyPaginatedViewer`, and
`CodexLinuxAttachOnlyPaginatedTurnsRpc` before launch.

The bounded private UI run exited zero in about 52 seconds. The screenshot
`/var/tmp/codex-private-smoke-u/orbit-client-opened-first.jpg` shows a dark
Codex window with `Shared Fixture Project`, the saved `Private fixture
conversation`, the user's `Private fixture conversation` message, and the
assistant's `Orbit completed fixture answer` text. OCR also found both
message texts. The private client had no `auth.json`. The 132 gate audit
entries include two allowed `thread/read` requests, one allowed
`thread/turns/list`, and one denied `config/batchWrite`. No owner write
method was allowed through the gate. All private processes stopped.

This is a **Limited, synthetic read display** result. It proves that the
copied Desktop can render full saved text through the fixture-only gate
callback. It does not measure the person's account or authorize a production
viewer. Writing to an existing conversation, other Codex actions, and the
other installed applications remain unmeasured. The installed ASAR SHA256
remained `8889a6e9aeba678a5d77876bcc9cfce3168ab47cc7bb4ba5856f80a3a32157a8`.
