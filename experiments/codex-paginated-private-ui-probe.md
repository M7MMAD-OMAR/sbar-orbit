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

The precise blocker for this UI fixture is workspace routing from the
synthetic account, before the copied Desktop can navigate to the
saved thread. The separate gate bridge probe in
`codex-paginated-gate-bridge.md` did return fake full turn content
through the real gate callback. Visible conversation body rendering
in the copied Desktop remains not measured. No personal profile or
installed application was used.
