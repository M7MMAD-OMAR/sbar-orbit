# macOS research

The sourced groundwork behind the macOS adapter, kept in the repository rather than in a chat log,
because the adapter's design decisions are only checkable against the sources they came from.

Five documents, about 5,400 lines. Four were produced before any code was written, by four agents
researching in parallel with instructions to cite primary sources and to label anything they could
not. The fifth is an adversarial audit of the finished adapter.

| Document | Question it answers |
|---|---|
| [budget.md](budget.md) | Can a non root process enforce a SHARED resource budget over a process tree on macOS 13+, and if not, what is the strongest honest alternative |
| [containment.md](containment.md) | How to launch, contain and reliably reap an owned Chromium tree, including when the parent is SIGKILLed |
| [platform-paths.md](platform-paths.md) | Per user daemons, socket constraints, TCC safe storage locations, and the filesystem rules a Bun CLI must respect |
| [browsers.md](browsers.md) | How Chromium family browsers are installed, identified and safely started without touching the person's own |
| [security-audit.md](security-audit.md) | An adversarial audit of the implemented adapter, with live exploit probes rather than a code read |

## How to read these

**They were written on Linux. Nothing in the first four was executed on macOS.** Every runtime claim
is labelled, and the labels are the point: `[PRIMARY]` or `[DOC]` means a man page, Apple
documentation, XNU source or Chromium source is cited inline; `[OBSERVED]` or `[REP]` means widely
reported third party behaviour; `[INFERRED]` means a conclusion drawn from a primary source but not
stated by it; `[UNVERIFIED]` means it must be measured before being relied on.

What was subsequently measured on a real Mac is in [../../macos-measured.md](../../macos-measured.md),
and where a measurement contradicted the research, the measurement won and the code says so.

## The three findings that changed the design

Each of these was in a research document before it was in the code, and each would have been an
expensive discovery on a person's machine.

**There is no shared resource pool on macOS.** The one kernel object with the right shape is the task
coalition, and it is closed to third party code: `coalition(COALITION_OP_CREATE)` is gated on
`task_is_in_privileged_coalition()`, spawning into another needs the private
`com.apple.private.coalition-spawn` entitlement, and `coalition_ledger()` is root only and caps disk
writes rather than CPU or memory. That is why the budget reports `enforcement: "advisory"` and lists
every dimension as unbounded, rather than printing a number shaped like `memory.max`.

**A fresh `--user-data-dir` does not avoid the Keychain dialog.**
`components/os_crypt/keychain_password_mac.mm` looks the cookie key up with
`FindGenericPassword(service: "Chrome Safe Storage", account: "Chrome")`, compile time constants that
mention no profile directory. On any Mac where Chrome has ever run the item already exists, so a
binary off its ACL raises a modal dialog on the person's screen and `--headless` does not suppress
it. Hence `--use-mock-keychain`, which `os_crypt_switches.h` documents as existing for exactly this.

**The Crashpad handler escapes any process group sweep.**
`crashpad/util/posix/spawn_subprocess.cc` double forks and calls `setsid()`, with a comment saying the
grandchild is expected to outlive its parent. It leaves both the group and the session and is
reparented away, so `killpg` misses it and a descendant walk misses it. Hence
`--disable-crash-reporter`, the same conclusion the Windows port reached independently.

## What the audit found, and the one thing it got wrong

Eight defects, listed with severity in [../../macos-measured.md](../../macos-measured.md) section 8.
The worst was a containment layer documented in three comments with no implementation at all.

It also reported one defect that was not one: plist injection. Five payloads were tried against the
real `brokerAgentPlist`, including one adding `AbandonProcessGroup`, and all five were escaped. Its
detector had matched the legitimate `KeepAlive` block that every plist carries. That is recorded here
because an audit is evidence to be checked, not a verdict to be applied, and the regression test
which now guards that code was shown to FAIL against a deliberately broken escaper before it was
trusted.
