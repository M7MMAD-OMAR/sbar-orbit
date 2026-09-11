# Is this the best way to give an agent its own workspace?

Reviewed 11 September 2026 against the alpha in this repository. The question asked was whether
Orbit's design is the best possible way to implement the idea on Linux, Windows and macOS, with a
different mechanism per operating system explicitly allowed.

Ten parallel surveys produced 75 candidate approaches. Thirty two of the load bearing claims were
handed to independent skeptics instructed to refute them; 28 were refuted, 24 of those with high
confidence. Everything labelled measured below was run on this workstation. Everything about Windows
and macOS is documentation only, and that limit is a finding in its own right, not a disclaimer.

## The four requirements

| | Requirement | Stated as |
|---|---|---|
| R1 | Separate input | The agent has its own pointer and keyboard. It never moves the person's cursor, never steals focus, and does not cost them a monitor |
| R2 | Real sessions | The agent works inside the person's actual logged in browsers and applications, completely |
| R3 | Watch and take over | The person can observe live and grab control when they want |
| R4 | Cost | One workstation shared with the person and several concurrent agents. Orbit budgets about one core |

R1, R3 and R4 are what Orbit already does, and they hold up. R2 is the requirement Orbit currently
refuses by design, and it is where this review spends its effort.

## Verdict

The shape is right and the refusal is wrong to leave unexamined.

Orbit's two backends are the correct primitives. A headless browser driven over CDP satisfies R1
structurally rather than by policy, because it has no display to intrude on. A nested headless
wlroots compositor with its own virtual pointer and keyboard is the right Linux answer for native
applications, and the skeptics did not dislodge it. Both survived.

Three things are wrong.

**R2 is not merely unimplemented, it is actively blocked by two lines.** The person's real cookie
jars on this machine are 100 percent `v11`, meaning their encryption key lives in the login keyring.
`src/chrome.ts` line 21 forces `--password-store=basic`, the wrong key, and line 18 points
`DBUS_SESSION_BUS_ADDRESS` at a socket that does not exist, so the keyring cannot be reached at all.
Measured: a copied profile opened under Orbit's own launch environment decrypts zero cookies and
loads the page silently signed out. Any work on R2 that does not start here fails silently.

**The answer genuinely differs per operating system, and one platform cannot have what the owner
asked for.** A profile copy is a working route to real sessions on Linux and on macOS. On Windows it
is dead, because App-Bound Encryption refuses to decrypt from any directory that is not the default
user data directory. That is not a gap to close with effort; it is a deliberate vendor decision.

**The one mechanism that reaches real sessions on all three platforms is the one the repository never
evaluated**: an extension inside the person's own browser. `docs/research.md` has no row for it. It
is also the only path that carries passkeys and device bound sessions, which no export or copy can.

The honest summary of the compatibility position is stronger than the matrix in `docs/research.md`
admits. That matrix labels Windows and macOS native support "Research: app-specific adapters", which
implies there are hosts to adapt against. There are none. No Windows or macOS machine is in this
project's reach, so every non-Linux row is reasoning about documentation.

## What was refuted

Recorded so these are not proposed again. Each was killed by a skeptic that found the primary source
saying it does not work, or that no primary source establishes it.

| Approach | Why it is dead |
|---|---|
| Attach over CDP to the person's running browser | Full real sessions, and it is exactly the screen takeover R1 forbids. Chrome 136 also blocked default profile debugging |
| A second Chrome profile inside one user data directory via `--profile-directory` | The singleton is scoped to the user data directory, so this is not isolation. It fails R1 and gains nothing on R2 |
| A second concurrent interactive session for the same Windows user | Not a supported configuration on Windows 11 Pro or Home. `RDPWrap` style unlocks are refused on the license, not on feasibility |
| Two concurrent GUI login sessions for the same macOS user | No documented Apple API creates a second Aqua session for an already logged in user. The login keychain is unlocked by the login session and keyed to the UID |
| `CreateDesktop` plus `SendInput` on a non interactive Windows desktop | A private desktop cannot reach the person's running applications, so it fails R2 by construction, and the input path is unestablished |
| Windows `ApplicationBoundEncryptionEnabled=0` to downgrade and then copy | The policy affects future writes only, and the support check returns `kNotUsingDefaultUserDataDir` before the policy branch is reached |
| Accessibility in place, `CGEventPostToPid`, AppleScript, Windows UI Automation in place | All four give full real sessions by acting through the person's own running application. All four therefore mutate the person's visible windows, which is the one thing Orbit promises never to do. They satisfy "no pointer" while failing "separate workspace" |
| Virtual machines, Windows Sandbox, a second user account, WSLg | Good isolation, and they discard precisely the state R2 asks for |
| IddCx virtual displays, a second logind seat, Xvfb as a Wayland substitute | A virtual display gives extra pixels, not a separate pointer. A second seat cannot run concurrently with the person's session |
| Reading the macOS `Chrome Safe Storage` key from a helper binary | Chromium's own design document states macOS raises an OS dialog when a different application requests the item. That dialog appears on the person's screen and takes focus, which breaks R1 |

## Measured on this workstation

Fedora 44, Hyprland, btrfs, system Google Chrome and Chromium. A disposable local fixture stands in
for the person's browser, so no real account was used and no personal browser was opened. Reproduce
with `bun run scripts/limited.ts bun run experiments/profile-clone.ts` and
`bun run scripts/limited.ts bun run experiments/filtered-bus.ts`.

### The person's real profiles

Counting only the three byte encryption version prefix, never a cookie name, host or value:
`~/.config/google-chrome` holds 167 cookies and `~/.config/chromium` holds 751. Every one is `v11`,
with zero `v10` rows. `v11` means the key lives in the login keyring under the browser's own
`Safe Storage` item, not in the profile. So the keyring is load bearing here, not academic.

### What a copy carries

| Question | Measured result | Consequence |
|---|---|---|
| Does a copy of a closed `v11` profile keep the login | Yes. Cookie and `localStorage` both survive, with the same browser binary and the keyring store | A profile copy is a working route to real sessions on Linux |
| Does a different browser binary keep the login | No. Chromium opening a Chrome copy looks up `Chromium Safe Storage`, a different keyring item, and every cookie fails to decrypt | Orbit must launch the binary that owns the profile. `src/runtime-paths.ts` line 3 picks a fixed order instead, and this person has both browsers |
| Does `localStorage` survive a failed decrypt | Yes. It is plaintext on disk and survived every failing case | A copy leaks site state even when it carries no login. Treat the whole copy as sensitive |
| Does a copy of a running browser keep the login | Not immediately. Cookies set seconds earlier were still in memory and the copy had none. After about 35 seconds the commit had landed and the copy worked | Copying a live profile silently produces a half signed in browser |
| What does a naive copy of a live profile do | It inherits `SingletonLock`, `SingletonSocket` and `SingletonCookie`. Chrome refused to start, exit code 21. In one run it took the "profile appears to be in use on another computer" branch and spawned a `zenity` dialog | A naive clone can put a dialog on the person's screen, which is the one thing Orbit promises never to do |
| Does removing those markers fix it | Yes. With `Singleton*` deleted, the copy ran concurrently with the original and the original kept working | The fix is three file deletions and it belongs in Orbit, not in a document |
| Does a copy forward a URL into the person's running browser | Not reproduced. Every second launch aborted with exit code 21 rather than forwarding | The risk is real in principle, because the copy's `SingletonSocket` points at the live browser's socket under `/tmp`, but a headed instance was not tested and no headed browser was opened on the person's desktop |
| What does the copy cost | 480 MiB of incompressible data copied on the home filesystem in 125 ms, and `btrfs filesystem du` reported 0.00 B exclusive, so the extents are shared | On btrfs a per session clone is effectively free. The real Chrome profile here is 5.3 GiB, so without reflink the same operation is a 5.3 GiB copy and the feature must refuse rather than silently spend the disk |

### The real profile, at real size

The measurements above used a small synthetic profile. This one used the person's actual Chrome
profile, with their consent, reading the source only and deleting the clone before the process
exited. Nothing about a cookie was recorded except aggregate counts. Reproduce with
`ORBIT_REAL_PROFILE=1 bun run scripts/limited.ts bun run experiments/real-profile-clone.ts`.

| Measurement | Result |
|---|---|
| Copy of 5.25 GiB | 620 ms, and `btrfs filesystem du` reported 0.00 B exclusive against 4.80 GiB shared |
| Cookie jar | 167 rows in the source, all `v11`, and all 167 present in the clone |
| Decryption through a filtered bus | 142 cookies returned, 142 with a non empty value, a decrypted share of 1.0 |
| The person's extensions | 4 extension directories survived, and 3 service workers started |
| Cookies returned against rows on disk | 142 against 167, because Chrome prunes expired cookies when it starts |

Two findings only the real profile could produce. Playwright's default arguments include
`--disable-extensions`, so the person's own extensions stay dormant unless that default is dropped
explicitly; dropping it started three of them. And a clone is not a byte identical browser even when
decryption is perfect, because the pruning above means the agent sees a slightly smaller jar than the
person does.

### The keyring, and the conflict Orbit has not recorded

`src/chrome.ts` severs the session bus deliberately. The comment above line 18 records why: Chrome
can use the desktop bus to move itself into an uncapped systemd scope, which would break the one core
budget R4 rests on. Cookies encrypted against the keyring need that same bus to decrypt. The two
goals look mutually exclusive, and a skeptic argued exactly that: the only route to R2 is a
regression against R4.

That is half right. A filtering proxy resolves the containment half and does not resolve the keyring
scope half.

| Configuration | Secret service | `org.freedesktop.systemd1` | Keyring items a client can enumerate | Cloned profile |
|---|---|---|---|---|
| Orbit today, bus severed | unreachable | unreachable | 0 | signed out |
| `xdg-dbus-proxy --filter --talk=org.freedesktop.secrets` | reachable | **blocked** | **25** | **signed in** |

So the cheap fix works and it is not free. `--talk=` constrains the bus name, not which items may be
searched, and Secret Service item paths are dynamic. A client on that filtered bus enumerated all 25
items in the login collection, not just the browser's key. The filtered bus is strictly better than
handing over the raw session bus, and it is still a keyring wide grant. It belongs in the security
section below, next to the origin allowlist, not in the free wins column.

## Per platform

The owner allowed a different mechanism per operating system. The evidence says that is not a
convenience, it is required.

### Linux

| Layer | Recommended | Why |
|---|---|---|
| Browser | Owned headless browser over CDP, launching the binary that owns the profile, with a reflinked clone of that profile, `Singleton*` stripped, and the keyring reached through a filtered bus | The only configuration measured to give real sessions while keeping the browser headless, so R1 holds structurally. Cheapest option on R4 because there is no compositor |
| Native applications | The nested headless wlroots compositor Orbit already has, plus a private session bus with its own portal backend | The shape survived refutation. The missing piece is mechanism, not state: `docs/fedora-results.md` already records that the fixture has no working session bus, and file dialogs are the next gate |

The root cause on both layers is the same line. `src/fedora.ts` line 115 severs the bus for the
private display exactly as `src/chrome.ts` does for the browser, so applications there get no portal,
no notifications and no secret service. The same `xdg-dbus-proxy` mechanism measured above is the
candidate fix, with a wider `--talk` set covering the portal and notifications. That unifies the two
backends behind one mechanism instead of leaving the native side an open question. It is not tested
on the native side and should not be claimed until it is.

One honest caveat the surveys raised: a private session bus cannot conjure an unlocked keyring. The
login keyring is unlocked by PAM at the person's login, and a second keyring daemon on a private bus
would need the password, which an agent must never handle. So for secrets specifically, the filtered
proxy onto the person's real bus is the only route that does not involve a password, and that is
precisely why it carries the 25 item exposure.

### Windows

| Layer | Recommended | Why |
|---|---|---|
| Browser | Owned headless Chrome or Edge over CDP with a fresh profile, and real sessions only through an extension in the person's own browser | A profile copy cannot decrypt. This is a vendor decision, not a gap |
| Native applications | Nothing that satisfies both R1 and R2. Report it as unsupported | Every mechanism that reaches the person's applications drives their visible windows; every mechanism that isolates loses their state |

App-Bound Encryption is the decisive fact and `docs/research.md` has no row for it. Two cookie
generations behave differently. Legacy `v10` cookies keep their key in `Local State` under
`os_crypt.encrypted_key`, unwrapped with `CryptUnprotectData`, which is bound to the user and the
machine with no path binding, so those would decrypt from a copy. `v20` App-Bound cookies, the
default since Chrome 127 and what real logins migrate to on next write, do not. The blocker is Chrome
itself rather than the privileged elevation service: `GetAppBoundEncryptionSupportLevel` returns
`kNotUsingDefaultUserDataDir` whenever the user data directory is not the default one, which a copy
never is. The policy workaround fails for the same reason, because that check returns before the
policy branch is reached.

Windows also has no equivalent of the Linux nested compositor. A desktop object created with
`CreateDesktop` is the structural analogue and it fails for the opposite reason: it is isolated from
the person's running applications, so it cannot satisfy R2, and whether a GPU composited application
even renders there is unresolved with no host to test on.

### macOS

| Layer | Recommended | Why |
|---|---|---|
| Browser | Owned headless browser over CDP, and a profile copy opened by the same signed Google Chrome binary | The key is not in the profile, so a copy works, but only for the binary that saved the key |
| Native applications | Nothing that satisfies both R1 and R2. Report it as unsupported | There is no second concurrent GUI session for the same user, and acting in place drives the person's own windows |

macOS is the cleanest result of the three for the browser and the bleakest for applications. The
encryption key is a 128 bit random value stored in the login Keychain as a generic password named
`Chrome Safe Storage` for Google Chrome branding and `Chromium Safe Storage` otherwise. Nothing binds
it to the profile path, so a copy decrypts. But the Keychain item's access control is keyed to the
application that saved it, and Chromium's own design document states macOS raises a dialog when
another application requests an item it did not save. That dialog lands on the person's screen, so
any helper or Playwright supplied Chromium reading the key breaks R1. The rule is the same one the
Linux measurement produced independently: launch the binary that owns the profile.

For native applications, the single question that decides the platform has a negative answer. Fast
User Switching gives a second session to a different user, with a different Keychain and different
application state, which forfeits the entire point.

## The cross platform answer the repository is missing

One mechanism gets full real sessions on Linux, Windows and macOS alike: code running inside the
person's own browser. An extension is inside the authorized process, so App-Bound Encryption, the
Keychain ACL and the Linux keyring are all irrelevant. It is the only path that carries passkeys and
device bound session credentials, which no copy or export can reach, and it cannot fork a session or
log the person out of their own browser.

In its pure form it fails R1, and the skeptics were right to say so: the tab the agent drives sits in
the person's window, so the agent has its own pointer but not its own screen. A refuter also
correctly killed the naive delivery story, since an MV3 extension cannot answer requests on a Unix
socket without a separate native messaging host.

The version that survives is the hybrid. The extension never drives anything. It runs in the person's
browser, and on request it mints narrow, short lived, origin scoped authenticated state and hands it
to a separate Orbit browser through a native messaging host. The agent then works in an Orbit owned
headless browser exactly as it does today, so R1, R3 and R4 are untouched, and R2 arrives without a
5.3 GiB copy, without a keyring grant, and without any of the platform specific decryption problems
above. It is the same shape on all three operating systems, which is the only unified answer this
review found.

It is not free of unknowns, and two were explicitly not established. Whether `chrome.cookies.getAll`
returns `HttpOnly` cookies was not confirmed against Chrome's own reference, and session cookies are
`HttpOnly`, so the approach is worthless if it does not. Whether partitioned cookie partition keys
survive the round trip was also not confirmed. Both are documentation lookups, not experiments.

## What granting real sessions costs

This section is not optional. Orbit's refusal to touch the personal profile is a safety property, and
removing it inverts the threat model.

Today an Orbit browser starts empty, so a web page that talks the agent into acting reaches nothing.
Once the agent holds the person's live sessions, the same page reaches every service the person is
signed in to, acting as them. The orbit server's own instructions already class browser content as
untrusted data. A keyring wide grant compounds it: the measurement above shows a filtered bus exposes
25 login keyring items, which is wifi secrets, SSH passphrases and other applications' tokens, in
order to reach one cookie key.

The feature is shippable with these, and is a credential handover without them.

| Mitigation | What it prevents |
|---|---|
| Per origin allowlist supplied at session creation, enforced in the navigation path | A page reached by the agent cannot pivot to the person's bank |
| Read only by default, writes refused until the person allows them for that session | An injected instruction cannot send, buy or delete |
| Human confirmation on irreversible actions, reusing the existing pause and takeover path | The person sees the action before it happens |
| Short lived session leases, and a clone discarded when the session stops | A stale copy of the person's identity does not accumulate on disk |
| Per session audit log of origins actually contacted | The person can see where their identity went |
| A private secret service serving only the browser's own key, instead of the whole keyring | Removes the 25 item exposure. Not built, and it requires the broker to handle one real secret |

Two further honest limits. A clone is a fork, not the person's live session: writes in the fork never
return to their browser, so takeover happens in a divergent copy, and "completely" is not what a copy
delivers. And whether major services invalidate a session that appears from a second concurrent
client, or whether a token rotation in the fork logs the person out of their real browser, was not
established. The extension hybrid avoids both problems, which is the strongest argument for it.

## Recommendation, cheapest first

| | Change | Cost against one core |
|---|---|---|
| 1 | Fix `src/chrome.ts` line 21 and `src/runtime-paths.ts` line 3: stop forcing `--password-store=basic`, and launch the binary that owns the profile rather than the first one found | None, both are argument changes. First because everything else fails silently until they are done |
| 2 | Record App-Bound Encryption, the `v10` and `v20` split, and the profile copy question in `docs/research.md`, and correct the compatibility matrix to say there is no Windows or macOS host | None. It stops the same dead ends being reproposed |
| 3 | Build the scoped mitigations in the security section before any real session feature, not after | An allowlist check in the navigation path, cheaper than the capture loop beside it |
| 4 | Add the extension hybrid as the R2 mechanism: mint narrow short lived origin scoped state in the person's browser, hand it to an Orbit browser through a native messaging host | Reuses the existing headless browser, so no new compositor and no 5.3 GiB copy. The cheapest R2 on R4 and the only one that is the same on all three systems |
| 5 | Add a Linux only profile clone as the fallback when the extension is not installed: reflink, strip `Singleton*`, require the source browser closed or the commit settled, refuse on filesystems without reflink | Free on btrfs at 0 B exclusive and 125 ms per 480 MiB. Carries the keyring exposure, so it needs item 3 first |
| 6 | Put a filtered session bus in front of the private display with a `--talk` set covering the portal, notifications and secrets, closing the file dialog gate | One small proxy process per session. Untested on the native side |
| 7 | State the per layer rule in the documentation: website work goes to the browser backend, which pays no compositor, and the private display is for native applications only | None. Makes an existing accident into a decision |

## Open questions that need an experiment, not more reading

1. ~~Does the clone work on the real profile?~~ **Answered, and it does.** 5.25 GiB reflinked in
   620 ms at zero exclusive bytes, every cookie decrypted, and three of the person's own extensions
   started once Playwright's `--disable-extensions` default was dropped. See the measured section.
2. **Does `chrome.cookies.getAll` return `HttpOnly` cookies, and do partition keys survive?** Two
   documentation lookups that decide whether the extension hybrid is viable at all.
3. **Does a filtered session bus in front of the nested compositor make a GTK file chooser work?**
   The fix is proposed on the strength of a browser measurement and is untested for portals.
4. **Does a headed browser forward a URL into the person's running browser from a cloned profile?**
   Only the headless case was reproduced, and it aborted rather than forwarding. The headed case is
   the dangerous one and was not tested, because testing it means opening a browser on the person's
   desktop.
5. **Can a private secret service serve exactly one item?** This is what removes the 25 item keyring
   exposure and it is the difference between a shippable clone and a credential handover.
6. **Everything about Windows and macOS.** No host exists in this project's reach. Until one does,
   every non Linux row in the compatibility matrix is reasoning, and the matrix should say so.
