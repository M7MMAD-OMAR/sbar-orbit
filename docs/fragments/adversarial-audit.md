# Adversarial audit, 19 September 2026

An adversary agent that built nothing, attacking the one promise the project exists for: that an
agent never touches the person's screen, pointer, keyboard, windows or logged in browser. Six test
files under `tests/adversarial/`, 23 assertions groups, and a mutation sweep of 14 rows in which every
row ends KILLED.

Every defect below was REPRODUCED before it was written down. Where a defect could not be expressed as
a test it is reported as prose rather than weakened into a test that passes, and that is said in its
own row.

## What the suite is, and why it is shaped this way

INTEGRATED. Every browser test drives `Sessions.dispatch`, which is the object the broker's socket and
the MCP adapter both call into, and two drive a real broker process over its real socket. A unit test
on one side of a contract cannot see a disagreement with the other side, and one of the findings below
is exactly such a disagreement: `Rule.method` works in `decide()` and is dead in the product because
`src/session.ts` calls `decide()` with three arguments.

VARIED. Each file names the axis the existing suite holds fixed and attacks that axis.

| Existing test | Axis held fixed | What this suite varies |
|---|---|---|
| `person-browser.test.ts` | the browser is started by the TEST, never by the broker | the broker's own launch, read from `/proc` |
| `policy.test.ts`, `advisor.test.ts` | one spelling of each destination | the ENCODING of the path and the CASE of a rule's origin |
| `browser-crash.test.ts` | the audit is of PROCESSES | the DIRECTORIES a killed broker leaves |
| `docs/experiment.md` two session evidence | sequential, 100 submissions each | `Promise.all`, eight ways at once |
| `capture-timeout.test.ts` | six plain decimal integers | hex, floats, exponent overflow, whitespace, separators |
| `process-scope.test.ts` | one of the function's two throws | the other one |

ABSENCE over output. The escape test asserts that a forbidden environment key is `undefined` on every
process in the tree, that no process names the person's browser directory, and that the session bus
address points inside the session's own profile. An assertion about a correct looking frame would pass
against a browser talking to the person's compositor.

## Findings, by severity

### 1. High. The crash handler still writes into the person's own browser directory, after c9a5413

`test.failing` in `tests/adversarial/escape.test.ts`.

This suite's first run produced the finding that became c9a5413: a live `chrome_crashpad_handler`
under an Orbit session with
`--database=/home/<person>/.config/google-chrome/Crash Reports --url=https://clients2.google.com/cr/report`.
c9a5413 added `--disable-crash-reporter` to the Linux branch and `tests/crash-handler.test.ts` asserts
it from the source and from the browser's argv. Both are true and the escape is still there.

Measured through a real broker session on Fedora 44 with Chrome 152, after c9a5413:

```
browser   /opt/google/chrome/chrome ... --disable-crash-reporter --password-store=basic ...
child     /opt/google/chrome/chrome_crashpad_handler --monitor-self
            --database=~/.config/google-chrome/Crash Reports
            --url=https://clients2.google.com/cr/report
child     /opt/google/chrome/chrome_crashpad_handler --no-periodic-tasks   (same --database)
renderers /opt/google/chrome/chrome --type=renderer ... --enable-crash-reporter=,
```

So on this Chrome the flag does not stop the handler starting. Two handlers run, both pointed at the
person's own crash database, and the browser passes `--enable-crash-reporter=,` down to every child.
The fix's own test cannot see this, because it asks the browser's argv for a flag that is present and
the defect is in what the browser does with it.

What is claimed: a write into the person's browser state directory by a process a session started.
What is NOT claimed: an unconstrained upload on a leased session. The handler is a descendant of the
`bwrap` wrapper, so on a session with bounded origins it sits inside the network namespace and
`clients2.google.com` is unreachable from there. On a session with `origins: "any"` no namespace is
opened at all, and then it is reachable.

Reproduce: `bun run scripts/limited.ts bun test tests/adversarial/escape.test.ts` and read the
`.failing` row, or take any live session and
`tr '\0' ' ' < /proc/<handler pid>/cmdline`.

### 2. High. The immune set is defeated by a percent encoded path

`test.failing` x2 in `tests/adversarial/policy-ratchet.test.ts`.

`immuneMatch` splits `URL.pathname`, which keeps percent escapes verbatim:
`new URL("https://bank.test/%74ransfer").pathname` is `/%74ransfer`. The segment set holds
`%74ransfer`, the table looks for `transfer`, and the money movement entry does not fire. Every
ordinary web server decodes the path before routing, so the two are one endpoint to the service and
two endpoints to the immune set. The same defeat works on `credential-change` (`/%70assword`) and
`oauth-grant` (`/%6Fauth/authorize`).

Measured, and the canonical spelling is caught as a control, so this is about the encoding:

```
immuneMatch("navigate","https://bank.test/transfer","POST")    -> money-movement
immuneMatch("navigate","https://bank.test/%74ransfer","POST")  -> null
```

This matters more than any widening path. `docs/support-tiers.md` claims `An immune set nothing
clears` as Measured, and `docs/autonomy.md` names matching a URL as a string as Orbit's "equivalent
mistake"; this is that mistake surviving inside the structural matcher. The broker level test drives a
real session against a fixture that decodes its path, and the session is neither refused nor contained.

Uppercase (`/TRANSFER`) and dot segments (`/a/../transfer`) are both caught correctly, so the gap is
specifically the decode.

### 3. Medium. A narrowing rule written with a bare host or a trailing slash silently does nothing

`test.failing` in `tests/adversarial/policy-ratchet.test.ts`.

`parsePolicy` validates `rule.origin` by calling `normaliseOrigin` for its throw and then stores the
caller's ORIGINAL string, while `ruleMatches` compares it against `new URL(url).origin`, which is
always normalised. So `origin: "example.test"`, `"https://example.test/"` and `"HTTPS://example.test"`
are all accepted, reported back by `session.journal` as held, and match nothing.

The session's own `origins` field does not have this problem because `parsePolicy` keeps the
normalised value there, which is why no existing test sampled it: they only ever spell a rule origin
canonically. A rule the person wrote, the parser accepted and the journal reports is worse than a
missing rule.

### 4. Medium. `Rule.method` is dead on the broker's own path

`test.failing` in `tests/adversarial/policy-ratchet.test.ts`.

`Rule.method` exists, `parsePolicy` accepts it, `ruleMatches` requires a method to match it, and
`src/session.ts:341` calls `decide(session.policy, action.type, destination)` with no fourth argument.
So every method bearing rule fails OPEN: `ruleMatches` returns false when `method === undefined`.

This is the contract seam that unit tests structurally cannot see. `tests/policy.test.ts` calls
`decide` directly and passes a method where it tests one, so both sides are green about a field that
does not work in the product. Either the broker should pass the method, or `parsePolicy` should refuse
the field for the browser backend.

### 5. Medium. A broker killed outright leaves its egress socket directory on tmpfs forever

`test.failing` in `tests/adversarial/reaping-and-secrets.test.ts`.

`tests/browser-crash.test.ts` kills the broker with SIGKILL and proves no descendant survives. It
never looks at the filesystem. A bounded origin session opens
`$XDG_RUNTIME_DIR/sbar-orbit/egress/<8 hex>` holding `lease.sock` and `cdp.sock`, removed by
`EgressLease.close()`, which is exactly what SIGKILL does not run.

Measured: directory opened, broker SIGKILLed, every process reaped, directory still present 4.5
seconds later.

`src/fedora.ts` already carries the reasoning for the native runtime directory: tmpfs pages are
charged to the cgroup that wrote them, and "left behind, closed sessions kept filling the shared
memory budget until the kernel throttled everything that was still running". Nothing sweeps these:
`cleanWorkspaces` walks the WORKSPACE root and knows nothing about the runtime one, so no `clean` path
removes them either.

### 6. Medium. `act @path` echoes the first token of any file it can read but not parse

`test.failing` in `tests/adversarial/cli-document.test.ts`.

`actionDocument` hands the file's text to `JSON.parse` and puts the PARSER'S message into the error.
Bun's message quotes the offending token, so the first token of the file is returned on stdout.
Measured:

```
act s @secrets.env   -> ...is not JSON: JSON Parse error: Unexpected identifier "AWS_SECRET_ACCESS_KEY"...
act s @token.txt     -> ...Unexpected identifier "ghp_REALTOKENVALUE_abcdef123456"...
```

Asserting which of the two this is, because the brief asked: it is NOT a privilege boundary. The CLI
runs as the person and could read the file anyway. It IS a disclosure into a channel that leaves the
process: an agent host captures the CLI's stdout, and a person pasting a failed command into an issue
pastes the first token of whatever file they pointed at. `src/policy.ts` and `src/diagnostics.ts` both
go to real lengths to keep file content out of every record; this path puts it in one.

Remedy shape: report the position and length of the parse failure rather than the parser's message.

### 7. Medium. `act @path` on an endless file reads forever

Same `test.failing` file.

`Bun.file(path).text()` on a character device with no end reads without bound. Measured on Fedora 44:
`act s @/dev/zero` killed at 8 seconds having reached 8.4 GiB resident, nothing on stdout, no error. A
FIFO nobody writes to hangs on the same line with no memory growth, which is the quiet form.

Again not a privilege boundary. The documented remedy for a shell that eats quotes IS `@path`, so a
mistyped path that happens to be a device turns a one line command into an out of memory event while
three agents share one budget. Remedy shape: refuse a path that is not a regular file, or cap the
bytes taken.

### 8. Low. `LIMIT_REACHED` is not in the diagnostics allowlist, and two codes in it are never thrown

`tests/adversarial/weak-assertions.test.ts`, passing, with the drift pinned as the assertion.

`LIMIT_REACHED` is thrown from four places on the hot path: the 32 session ceiling, the 10000 action
ceiling, the 64 tab ceiling and the 32 application ceiling. `src/diagnostics.ts` carries
`SESSION_LIMIT` and `RESOURCE_LIMIT` instead, and no source throws either. So the four ceilings a busy
broker actually hits are recorded as `BACKEND_ERROR` in the diagnostics report, which is the
unattributable failure `src/ipc.ts` names. Five other codes are also unlisted and are listed in the
test with the reason they are accepted, so a NEW unlisted code fails it.

### 9. Low. A weak assertion in `tests/process-scope.test.ts`, shown to survive a mutation

`tests/adversarial/weak-assertions.test.ts`, positive form added.

The existing test ends on `await expect(auditProcessScope(42, root)).rejects.toBeDefined()` after
replacing a `cgroup` FILE with a directory, which makes `readFile` throw `EISDIR`. Real path, real
coverage. What it does not cover is the OTHER throw in the same function:

```ts
if (!/^\d+$/.test(token)) throw new Error("Invalid process child list");
```

Mutated to `if (false)`, with `git diff --stat` confirming the edit landed, `tests/process-scope.test.ts`
stays at 1 pass, 0 fail. The guard matters because every token becomes a pid that is audited or
signalled, so a non numeric token becomes `NaN`. The replacement asserts
`rejects.toThrow("Invalid process child list")`, which the EISDIR path cannot satisfy.

The general shape, since the brief asked for it: `rejects.toBeDefined()` appears at
`browser-crash.test.ts:95`, `native-crash.test.ts:48`, `launcher.test.ts:41` and
`process-scope.test.ts:19`. In the first three the real subject is asserted properly one line later,
so those are defensible. `.not.toBe(` appears 20 times, mostly as `isError).not.toBe(true)` in the MCP
tests, where the only alternative to `true` is `undefined` and the assertion is therefore adequate.

## Surfaces attacked with no defect found

- THE RATCHET ITSELF. Ten `session.narrow` calls in sequence asking for every class and origin back,
  in four shapes; a narrowing with neither field; five invented widening method names; a second wide
  session created beside a narrowed one; and `narrow` called on the module's own exported defaults to
  see whether the next session inherits a mutated array. Nothing widened. The `parsePolicy({}).deny`
  spread is load bearing and killing its mutation proves it.
- OBSERVATION AS AN UNPOLICED READ. `session.observe` after narrowing to `allow: []` is refused and
  journalled, and `session.presence` deliberately still answers. Mutation KILLED.
- THE PROFILE LEASE, RACED EIGHT WAYS. One winner, seven `PROFILE_BUSY`, reclaimable after stop.
  Mutation KILLED.
- A DUPLICATE REQUEST ID, RACED TEN WAYS. Ten resolutions, one journalled click, and a conflict on
  different arguments. Mutation KILLED.
- A NARROWING RACED AGAINST THE ACTION IT FORBIDS. No allowed agent action appears after the narrowing
  line in the journal, whichever call won.
- TWO SESSIONS AT ONCE. Two profiles, two journal files each 0600, each mentioning only its own id,
  per session sequence numbers unique and increasing, and each session reading its own page.
- THE DURABLE JOURNAL FILE. A real run carrying a password shaped string, a token in a query and a
  denied navigation: neither the typed text, the token, the username, the query key nor the path is in
  the file, the origin survives, `inputLength` is exact, the workspace path is absent, mode is 0600.
- THE DIAGNOSTICS REPORT AND ITS ISSUE URL. A real run's report names no origin, path, token, session
  id, selector or home directory, in the report or in the prefilled link, while still carrying
  `session.act` and `POLICY_DENIED`.
- THE CAPTURE BUDGET. 29 spellings including `0x10`, `1e999`, `1e308`, `1_000`, `"  "`, `-0`, `0.4`
  and `999999999999999999999`. Every one lands finite, integer, non zero, non negative and inside
  [500, 120000]. `1e999` overflows to Infinity and is ignored rather than clamped, which is correct.
- THE ENVIRONMENT AS A ROUTE TO THE CAPTURE BUDGET. No session field reaches `process.env`; the RPC
  surface is the enumeration in `dispatchRequest` and contains no per session settings write. A
  hostile environment still gets a clamped value, so the worst it buys is a slow capture.
- THE BROWSER'S OWN ENVIRONMENT AND ARGV. `DISPLAY`, `WAYLAND_DISPLAY`, `WAYLAND_SOCKET` and
  `XAUTHORITY` absent from every process in the tree with a readable environment; no value anywhere
  equal to the host's `WAYLAND_DISPLAY`; `DBUS_SESSION_BUS_ADDRESS` inside the session profile and
  never equal to the broker's; exactly one browser process, headless, with exactly one
  `--user-data-dir` naming its own profile.
- STOPPING A SESSION. Profile and restore store gone from the workspace, journal deliberately kept.
  Both removal layers had to be mutated together to kill it, which is defence in depth working.

## The mutation sweep

`bun run scripts/limited.ts bun run tests/adversarial/mutate.ts`. Fourteen rows, every one KILLED. The
sweep enforces two rules on itself, both because a failure of either looks exactly like a survivor:

1. A mutation that does not APPLY is reported `SKIP(anchor)`. The anchor is matched against the source
   as spelled, and `git diff --stat` is consulted after the write to prove the file changed and that
   the number of changed lines matches the number of edits.
2. The file is restored with `git checkout --` and `git status --porcelain` is proven clean of it
   before the next row runs.

| Invariant | Mutation | Outcome |
|---|---|---|
| The browser gets no reach onto the person's Wayland or X display | `src/chrome.ts`, the forbidden key filter replaced by `true` | KILLED |
| The browser never reaches the person's session bus | `src/chrome.ts`, bus address falls back to `process.env.DBUS_SESSION_BUS_ADDRESS` | KILLED |
| A profile key is leased to exactly one session | `src/session.ts`, `if (this.leases.has(lease))` to `if (false)` | KILLED |
| A repeated request id performs one action | `src/session.ts`, `return existing.result` guarded off | KILLED |
| A policy only ever narrows | `src/policy.ts`, `narrow` intersection replaced by union | KILLED |
| Narrowing does not mutate the module default | `src/policy.ts`, `[...readOnlyPolicy.deny]` to `readOnlyPolicy.deny` | KILLED |
| The journal records a destination as an origin, never a full URL | `src/policy.ts`, `new URL(url).origin` to the raw url | KILLED |
| The durable journal file is private to this user | `src/session.ts`, `mode: 0o600` to `0o644` | KILLED |
| A session's profile and restore points do not outlive it | `src/session.ts`, BOTH removal sites | KILLED |
| The diagnostics report carries a hashed session id | `src/diagnostics.ts`, BOTH the hash and the read side shape check | KILLED |
| The capture budget never reaches the browser as zero or infinite | `src/browser.ts`, the clamp removed | KILLED |
| A non numeric budget is ignored rather than read as NaN | `src/browser.ts`, the `isFinite` check removed | KILLED |
| A missing action document is refused by name, never read as null | `src/cli.ts`, the throw replaced by `raw = "null"` | KILLED |
| Observation is policed like any other action | `src/session.ts`, `decide(policy, "observe")` replaced by a literal allow | KILLED |

No surviving mutants. Two rows needed PAIRED edits and the single edit form is recorded in the sweep's
own comments rather than tidied away, because in both cases surviving was the code being right:

- The profile is removed by `reap`'s release chain AND again by `stop()`, which the source calls belt
  and braces. Either alone SURVIVED; both together KILLED.
- The session id is hashed on the way INTO a diagnostic event and every field is rebuilt from an
  allowlist on the way OUT, where `/^[a-f0-9]{16}$/` rejects a 36 character uuid. Either alone
  SURVIVED; both together KILLED.

Three first attempts were misplaced mutations rather than findings, and are recorded as such: adding a
`url` field beside `inputLength` on a `fill` action, which carries no url; and the two pairs above.

## Attacks described rather than run

- THE HOST'S REAL DISPLAY. Proving that a session cannot open a window, read a key or capture a frame
  on the person's screen would mean driving their compositor. Not run, by design: that restraint is
  the product under test. The proposed experiment is a wlroots screencopy and a virtual keyboard
  attempt from inside a session, on a SECOND nested compositor belonging to the experiment, asserting
  that both fail because the socket is not in the environment. The environment absence asserted here
  is the necessary half of it.
- A FILE CHOOSER REACHING THE PERSON'S FILES. `src/fedora.ts` gives a launched application private
  `XDG_*` base directories and no session bus, and `docs/support-tiers.md` records the GTK chooser
  working with no bus at all. Attacking it needs the native runtime, which this worktree does not
  have built. Proposed experiment: launch a GTK application with `selectedFiles` naming one fixture,
  drive the chooser to a path outside it, and assert the write is refused by
  `src/native/file_leases.py` rather than by the chooser's own UI.
- A BROWSER EXTENSION AS AN EGRESS PATH. `cloneProfile` sets `extensions: true` by default and freezes
  `Extensions` read only per FILE, never the directory, with the tradeoff written in the source. A
  proof needs a real cloned profile (`ORBIT_REAL_PROFILE=1`), which this agent must not create.
  Proposed experiment: place an extension with a `background` script fetching an off lease origin into
  a clone, and assert the proxy's `refused()` list names it.
- A SUPERVISOR'S GRANDCHILD AFTER A SIGKILL. `tests/native-crash.test.ts` covers this and skips
  without `ORBIT_TEST_NATIVE=1` and the built runtime. Not re-attacked blind.

## Verification, measured in this worktree

```
bun run typecheck                                            exit 0
bun run scripts/limited.ts bun test tests/adversarial/       23 pass, 0 fail, 377 expect() calls
bun run verify, before this suite                            318 pass, 33 skip, 1 fail, 1 error
bun run verify, after this suite                             341 pass, 33 skip, 1 fail, 1 error
```

The one failure and one error are PRE-EXISTING in this worktree and identical before and after: this
tree lacks the gitignored `node_modules` the website workspace needs, so
`website/tests/locale.test.tsx` cannot resolve `react/jsx-dev-runtime`. Reported by name rather than
by count, because identical counts can hide a swapped failure.

Six of the 23 passing tests are `test.failing`, which is how a reproduced defect is recorded without
turning the suite red: each carries the observed failure text and the condition for removing
`.failing`. They are findings 1 through 7 above.
