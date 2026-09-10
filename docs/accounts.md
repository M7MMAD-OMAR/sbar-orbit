# Saved browser accounts

Orbit can save its own browser account state and restore it into a new temporary profile on the next run. It never reopens a fixed browser profile or copies the personal browser's cookies. This preserves the workstation's one-profile-per-run rule.

## Use

Start the broker, set its printed `ORBIT_SOCKET`, then create a named browser session:

```sh
bun run src/cli.ts session create browser work-account
bun run src/cli.ts preview
```

Open the returned viewer link yourself. Navigate the session to the desired site through your agent or CLI, pause the agent, and sign in through the viewer. Select **Save account state** while paused. Resume or stop when ready. The CLI equivalent is:

```sh
bun run src/cli.ts account save "$ORBIT_SESSION_ID"
```

Create another session with the same account name to restore the last saved state. Closing a session does not automatically save changes. A second session or broker receives `PROFILE_BUSY` while the name is leased. Different names stay independent.

## Storage and boundaries

Named state lives in `~/.local/state/sbar-orbit/accounts/NAME/state.json`, or beneath an explicitly configured `ORBIT_ACCOUNT_DIR`. Directories are private and snapshot files use mode 600. Keep this directory out of repositories and shared folders. Snapshots may contain login credentials; Orbit does not return their contents through the save API. Same-user programs remain able to access the files.

The Linux lease uses `flock`; the file remains on disk, but the kernel lock is released when its holder exits. This is separate from Chrome process recovery after an abrupt broker crash, which remains unverified. `profileKey` retains its old meaning as an in-broker label. The new `accountName` selects saved state. Native applications do not use this feature.

[Playwright storage state](https://playwright.dev/docs/auth) covers cookies, local storage and optional IndexedDB. Orbit requests IndexedDB capture and restores with `setStorageState`. Session storage, browser extensions, passkeys, device-bound tokens and full browser profiles are not covered. Sites may require another login. Authentication popups and real services still need testing.

## Evidence

`bun run verify tests/profiles.test.ts` signs in to a disposable local fixture using an HttpOnly cookie, saves while paused, closes the broker, restores through a second broker object and verifies authenticated access plus local storage. It also checks an independent account, competing leases, fresh profile paths, file permissions, invalid names and recovery from a corrupt snapshot. No real account credentials are used.

`bun run verify tests/preview.test.ts` checks the actual viewer save button alongside pause and manual input. The next account gate is a user-chosen real service and its authentication prompts. Synthetic persistence does not prove every provider works.
