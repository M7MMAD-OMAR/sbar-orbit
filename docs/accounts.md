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

**T6 closed on 14 September 2026 against a real service**, with nobody typing a password: `experiments/real-account-clone.ts` takes the signed in state from a clone of the person's own Chrome profile, the path gate G8 closed, at the person's request. It asks four candidate services which one the person is signed in to, by navigating a bounded clone to a page a signed out person is redirected away from and reading the final location the session reports, never page text; the first signed in service is the one measured, and it was `www.npmjs.com`. The clone's storage state, 146 cookies, was saved as an account snapshot in a scratch directory at mode 0700 and deleted with the run, so Orbit's accounts directory was never written and the accounts feature stays what this page says it is. A fresh session on that name, no clone, reached the protected page signed in, 9.8 seconds from creation to page; a third session on the same name was refused with `PROFILE_BUSY`; and after a 60 minute hold in which the restored session was signed in at every five minute check, a fresh clone of the person's own profile still signed in, so nothing Orbit did logged them out of their browser; that is G18's first half for this one service. The report holds booleans, timings, counts and the origin. Its one liberty is reaching into the session map for the clone's storage state, taken instead of adding a save path for clones to the product.

`experiments/real-account.ts` is the same gate with the person in the loop, for a service the clone cannot reach or a person who would rather sign in themselves. It creates a named account session bounded to one origin, navigates it to the service, pauses it and opens the viewer in Orbit's own browser window; the person takes over, signs in and presses **Save account state**. From the moment the snapshot lands, the file measures the rest of T6 on its own: a second session on the same name is navigated to the service and asked, through the session's `read` action against a selector the service renders only when signed in, whether the login survived; a third session on the same name must be refused with `PROFILE_BUSY`. The report holds booleans, timings and the origin, never a name, a cookie or page text; the one frame it keeps is for the person to look at. `ORBIT_ACCOUNT_SERVICE`, `ORBIT_ACCOUNT_SELECTOR` and `ORBIT_ACCOUNT_NAME` choose the service, the signed in marker and the account name. Its dry run, `ORBIT_ACCOUNT_OPEN=0` with a short `ORBIT_ACCOUNT_WAIT_MS`, was run on 14 September 2026 up to the waiting step; the measured half waits for the person.
