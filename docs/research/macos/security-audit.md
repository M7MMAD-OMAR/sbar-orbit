# Adversarial security audit: the macOS adapter in sbar-orbit

Scope: `src/macos.ts`, `src/macos-budget.ts`, `src/macos-autostart.ts`,
`src/native/supervise-darwin.ts`, and the darwin branches of `src/chrome.ts`, `src/platform.ts`,
`src/service.ts`, `src/preflight.ts`, `src/workspace-storage.ts`, `src/install.ts`, `src/ipc.ts`,
`src/host-browsers.ts`, `scripts/limited.ts`, `scripts/public-audit.ts`.

Worktree audited: `.worktrees/subagent-sa-0-213c514b` at branch `hermes-subagent/subagent-sa-0-213c514b`.

Host is Fedora Linux, so darwin-gated code could not be executed. Every claim below is either
(a) derived from the source, (b) derived from XNU header layout reasoning stated explicitly so it can
be checked, or (c) reproduced on Linux where the semantics are POSIX and identical on macOS. Each
finding says which. Nothing was fixed; this is a report.

What was run:

- `bun run typecheck` : clean.
- `bun run scripts/public-audit.ts` : `{"filesChecked": 384, "findings": []}`, exit 0.
- Three POSIX signal experiments (reproduced on Linux, semantics identical on darwin), described
  inline at findings 2 and 7.
- A plist injection harness against the real `brokerAgentPlist`.
- A regex evasion harness against the real refusal-list patterns.

---

## H1. The second containment layer the design promises does not exist

**`src/native/supervise-darwin.ts:20`, `src/chrome.ts:126`, `src/macos.ts:302`, `src/cli.ts:78`**

Three separate comments state the macOS containment story as two layers:

> `supervise-darwin.ts:21` "What catches that case is the broker's own sweep on start, which reads
> the session workspace's `owner.json`, confirms the group is still Orbit's, and kills it."

> `macos.ts:305` "Every sweep goes through this rather than through `signalProcessGroup`."

There is no such sweep. `signalOwnedProcessGroup` (`src/macos.ts:310`) has zero call sites in the
entire repository:

```
$ grep -rn "signalOwnedProcessGroup" . --include=*.ts --include=*.md
./src/macos.ts:310:export function signalOwnedProcessGroup(...)
```

The only thing a managed broker does on start is `cleanWorkspaces()` (`src/cli.ts:78`), which is
`rm -rf` over directories (`src/workspace-storage.ts:105`) and never reads a session `owner.json`,
never reads a pgid, and never signals anything.

Why it matters. The supervisor is documented as best effort precisely because a SIGKILLed supervisor
runs no sweep (`supervise-darwin.ts:19-24`). On that path today, on macOS:

1. The headless Chrome tree survives with its process group intact, indefinitely. Nothing on the
   machine will ever reap it. `docs/support-tiers.md` and the code comments claim a second layer that
   would.
2. Worse, `cleanWorkspaces()` then deletes the workspace whose owning broker no longer answers
   (`src/workspace-storage.ts:104-105`), and session profiles live inside that workspace
   (`src/session.ts:147`, `mkdtemp(join(this.root, "profile-"))`). So Orbit `rm -rf`s the profile
   directory of a browser that is still running and still writing to it.

The failure is silent in both directions: the person keeps a headless Chrome consuming memory and
network with no Orbit that knows about it, and Orbit reports the workspace reclaimed.

Fix. Implement the sweep the comments describe, before `cleanWorkspaces()` removes anything. In
`src/cli.ts` around line 78, for `process.platform === "darwin"`, walk each workspace's
`profile-*/owner.json`, and for each record carrying `pgid`, `leaderStartedAtMs` and
`leaderExecutable`, call `signalOwnedProcessGroup(pgid, SIGNAL.TERM, {...})`, poll
`processGroupMembers(pgid)`, then `signalOwnedProcessGroup(pgid, SIGNAL.KILL, {...})`. Only after the
group is empty may the workspace be removed. A workspace whose group is still alive and could not be
proved must be KEPT, not deleted, so the profile is not pulled from under a live browser. Refuse to
delete a workspace containing an `owner.json` whose group still has members.

---

## H2. A `taskpolicy`-less macOS loses SIGKILL escalation when enumeration fails

**`src/macos.ts:135` combined with `src/native/supervise-darwin.ts:87-91`**

```ts
// src/macos.ts:135
if (bytes < 0) return { pids: [], complete: true };
```

An enumeration ERROR is reported as an empty group that is also `complete: true`, that is, as a
positive statement that the group is gone. `proc_listpids` returns -1 on failure and the errno cases
are real: a transient `ENOMEM`, or an `EPERM` if the process ever loses the right to enumerate.

The consequence in the reaping loop:

```ts
// src/native/supervise-darwin.ts:87-91
while (Date.now() < deadline && processGroupMembers(pgid).pids.length > 1) await Bun.sleep(25);
if (processGroupMembers(pgid).pids.length > 1) {
  signalProcessGroup(pgid, SIGNAL.KILL);
```

If the enumeration fails, `.pids.length` is 0, the grace loop exits at once, the `> 1` test at line 88
is false, and **SIGKILL is never sent**. A browser tree that ignored SIGTERM (Chrome does hold SIGTERM
while it flushes a profile, and a wedged renderer holds it indefinitely) is left running and the
supervisor exits reporting success.

The same conflation reaches `src/macos-budget.ts:105`, where a failed enumeration deletes a live
registration and under-reports the pool, which is the direction that hands out a session the machine
cannot afford, the exact hazard the file's own header calls out at `macos-budget.ts:44-47`.

Fix. Distinguish "error" from "empty". Return a discriminated result:

```ts
if (bytes < 0) return { pids: [], complete: false, failed: true };
```

and make every caller fail closed on `failed`: `supervise-darwin.ts` must escalate to SIGKILL when the
membership is unknown rather than when it is known non-empty, and `macos-budget.ts:105` must keep the
registration when the answer is unknown rather than reap it.

---

## H3. A caller-chosen registry root defeats the resource-budget gate entirely

**`src/macos-budget.ts:53`, used by `src/macos-budget.ts:147` and `src/resource-budget.ts:123`**

```ts
export function budgetRegistryRoot(env = process.env, home = homedir()) {
  return env.ORBIT_BUDGET_ROOT || posix.join(home, "Library", "Application Support", "sbar-orbit", "budget");
}
```

`ORBIT_BUDGET_ROOT` is taken verbatim. It is not required to be absolute, not `lstat`ed, not checked
for ownership, and not checked for group or other write bits. Contrast `createWorkspaceDirectory`
(`src/workspace-storage.ts:28-40`), which does all four of those things for the workspace root and is
the standard this project already sets for itself.

The budget gate is `insideRegisteredGroup()` (`src/macos-budget.ts:147`), which is what
`requireDarwinBudget()` (`src/resource-budget.ts:123`) refuses on, and which is the mechanism behind
"a bare `bun test` refuses by design". Defeating it takes two steps and no privileges:

```
export ORBIT_BUDGET_ROOT=/tmp/mine
mkdir -p /tmp/mine && printf '{"pgid":%d,"label":"x","startedAt":"2026-01-01T00:00:00Z"}' "$(ps -o pgid= -p $$ | tr -d ' ')" > /tmp/mine/$(ps -o pgid= -p $$ | tr -d ' ').json
```

`liveBudgetGroups` reads it, the pgid has members so it is not reaped, and there is no
`leaderStartedAtMs` so the identity check at `macos-budget.ts:110` is skipped (see M1).
`insideRegisteredGroup()` returns true, `requireResourceBudget()` passes, and every headroom refusal
in `requireHeadroom()` is now computed against a pool the caller controls. The whole macOS budget,
accounting half included, becomes whatever the caller writes into a file.

This is not remote, it needs local environment control. But the environment is exactly what an agent
running under Orbit has, and the budget is one of the two things standing between an agent and
exhausting the person's machine.

Fix. Validate the root the same way the workspace root is validated, in `budgetRegistryRoot` or at
every use:

```ts
const root = env.ORBIT_BUDGET_ROOT || defaultRoot;
if (!isAbsolute(root)) throw new OrbitError("INVALID_REQUEST", "The budget registry root must be absolute");
const info = await lstat(root);
if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
  throw new OrbitError("INVALID_REQUEST", "The budget registry must be a private directory owned by this user");
```

Consider also refusing `ORBIT_BUDGET_ROOT` outside tests, the way a test-only override should be
gated, since nothing in the shipped documentation asks a person to set it.

---

## M1. An `owner.json` or a registration without `leaderStartedAtMs` silently disables the identity check

**`src/chrome.ts:169-171` and `src/macos-budget.ts:110-116`**

```ts
// src/chrome.ts:169
if (typeof owner.leaderStartedAtMs === "number"
  && !groupIsStillOurs(owner.pgid!, { startedAtMs: owner.leaderStartedAtMs, executable: owner.leaderExecutable }))
  throw new OrbitError("RESOURCE_BOUNDARY_LOST", ...);
```

```ts
// src/macos-budget.ts:110
if (typeof entry.leaderStartedAtMs === "number") { ... reap on mismatch ... }
```

Both guards are conditional on the field being present and numeric. If it is absent, `null`, or a
string, the entire pgid-reuse defence is skipped and the code falls back to "the number has members",
which is precisely the check the file headers say is insufficient (`src/macos.ts:242-248`).

`supervise-darwin.ts:61` writes `leaderStartedAtMs: processStartedAtMs(pgid)`, and
`processStartedAtMs` returns `null` on any short read or unreadable process. So the null case is not
hypothetical and not limited to "older owner.json": a single failed `proc_pidinfo` at supervisor
start produces an `owner.json` that permanently disables its own containment check, and
`assertContained()` then reports a healthy session while looking at a group it has not proved.

The budget side is reachable by a plain file write. Given H3, or given any writable registry root, an
entry naming the person's own shell pgid with no `leaderStartedAtMs` is never reaped, charges the
pool with their processes forever, and pins `requireHeadroom()` into permanent refusal: a durable
denial of service on Orbit itself, from one JSON file.

Note this is a read/accounting path in both cases, not a kill path. It does not by itself cause a
wrong `killpg`. It does dismantle the guarantee that `assertContained()` is documented to provide.

Fix. Fail closed. In `src/chrome.ts:169`, treat a missing or non-numeric `leaderStartedAtMs` as an
unprovable group and throw `RESOURCE_BOUNDARY_LOST`, since Orbit wrote that file itself moments
earlier and its absence means the supervisor could not establish identity. In
`src/macos-budget.ts:110`, invert the condition: reap any entry that does not carry a numeric
`leaderStartedAtMs`, rather than trusting it. Separately, make `supervise-darwin.ts:61` refuse to
start when `processStartedAtMs(pgid)` returns null, rather than writing an unprovable record.

---

## M2. A single SIGTERM makes `scripts/limited.ts` loop on itself and never exit

**`scripts/limited.ts:43-44`**

```ts
const forward = () => { signalProcessGroup(pgid, SIGNAL.TERM); };
process.on("SIGTERM", forward); process.on("SIGINT", forward);
```

`pgid` is this process's own group (`becomeGroupLeader()` at line 33 is `setpgid(0, 0)`), so the
process is a member of the group it signals. `killpg(SIGTERM)` therefore delivers SIGTERM back to
itself, re-entering `forward`, which signals the group again, without bound. Because a handler is
installed, the default terminate disposition is gone, so the process never dies and the command never
exits.

Reproduced on Linux (identical POSIX semantics, `/tmp/orbit-macos-audit/sigloop-drive.ts`): a session
leader whose SIGTERM handler `killpg`s its own group, sent one external SIGTERM, ran the handler 50
times (the count at which the harness capped it) and remained alive:

```
sending SIGTERM to 2895537
stdout: LOOPED 50 times, aborting
        child exited, code null signal SIGTERM
        handler fired 50 times; leader still alive after external SIGTERM
```

Impact: `bun run verify` and every Orbit entry point that goes through `limited.ts` cannot be stopped
with SIGTERM on macOS. A `launchctl bootout`, a CI cancellation or a Ctrl-C hangs until SIGKILL,
while the process floods its own children with signals. It is the stop path, so the harm is a wedged
build rather than a compromise, but it is a hang that only SIGKILL clears.

Fix. Remove the handler before forwarding, then restore the default disposition and re-raise:

```ts
const forward = () => {
  process.off("SIGTERM", forward); process.off("SIGINT", forward);
  signalProcessGroup(pgid, SIGNAL.TERM);
  // the group signal above now reaches this process with the default disposition
};
```

or, simpler, signal the child's pid and the child's descendants explicitly instead of the group this
process is inside, which is what `supervise-darwin.ts` gets right by construction only because it
installs `stop` (line 66) as a flag-setter and never re-signals from inside the handler.

---

## M3. `extraArgs` is spliced into the Chrome command line after every containment flag

**`src/chrome.ts:322-324`** (and the same shape on Windows, `src/windows-job.ts:402`)

```ts
owner = launchOnDarwin(executable, profile, [...common, "--use-mock-keychain", "--password-store=basic",
  "--disable-crash-reporter", "--disable-features=MediaRouter", `--disk-cache-dir=${join(profile, "cache")}`,
  ...(options.extensions ? [] : ["--disable-extensions"]), ...(options.extraArgs ?? []), "about:blank"], env);
```

`options.extraArgs` lands after every flag that makes the session private, and Chromium's
`base::CommandLine` keeps switches in a map where the LAST occurrence wins. So an entry of
`--user-data-dir=/Users/<person>/Library/Application Support/Google/Chrome` overrides the private
profile and points the session at the person's real browser profile. `--load-extension=`,
`--disk-cache-dir=`, `--remote-debugging-address=0.0.0.0`, `--remote-debugging-port=9222` and
`--disable-features=` (which would undo the `MediaRouter` suppression, restoring the Local Network
alert on the person's screen) are all equally overridable. That is the complete list of things this
project exists to prevent.

**This is not currently reachable.** The two callers are `src/browser.ts:103`, which passes
`egress.launch.args`, built by Orbit as `--proxy-server=...` literals (`src/egress.ts:323`), and
`clone?.launch` from `src/clone.ts:138-143`, which never sets `extraArgs` and which on darwin cannot
run at all because `canCloneProfile` refuses outright (`src/platform.ts:406`). No user-controlled
string reaches `extraArgs` today. I am reporting it as a missing guard rather than a live exploit.

The reason it is still worth an M: the darwin branch has no equivalent of the single choke point the
Windows branch built (`windowsChromeArguments`, `src/windows-job.ts:386`, which exists precisely
because "building the list again here is what let the two drift apart", `src/chrome.ts:285`), and one
future caller that forwards a request field into `extraArgs` opens all of the above with no test
failing.

Fix. Add an assertion at the top of `launchChrome`, before any branch:

```ts
const reserved = /^--(user-data-dir|disk-cache-dir|load-extension|disable-extensions-except|remote-debugging-(port|address|pipe)|headless|no-sandbox|disable-web-security|auto-open-devtools-for-tabs|password-store|use-mock-keychain|disable-features)\b/;
for (const arg of options.extraArgs ?? [])
  if (reserved.test(arg)) throw new OrbitError("INVALID_REQUEST", `A session may not override ${arg.split("=")[0]}`);
```

and give darwin its own `darwinChromeArguments()` the way Windows has one, so the flag list has one
home and one test.

---

## M4. The viewer on macOS opens the token URL in the person's real browser profile, via a PATH-resolved `open`

**`src/host-browsers.ts:212`, reached from `src/host-browsers.ts:263`**

```ts
function fallbackCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
```

Two defects in one line.

First, `open` is resolved from `PATH`. Every other macOS tool in this codebase is absolute, and
deliberately so: `/bin/launchctl` (`src/macos-autostart.ts:133`, with a comment explaining the
measurement), `/bin/cp` (`src/platform.ts:217`), `/usr/sbin/taskpolicy` (`src/chrome.ts:136`). The
broker under a LaunchAgent runs with a PATH that `bin/sbar-orbit` prepends `dirname(bun)` to, so a
binary named `open` in a Bun install directory executes as the broker.

Second, and more consequential: on macOS `listHostBrowsers()` (`src/host-browsers.ts:131`) enumerates
XDG `.desktop` files only, so it returns an empty list on every Mac. `pickBrowser` therefore returns
`undefined`, `profile` stays `undefined`, and the fallback runs. The viewer URL carries an access
token in its fragment (`src/preview.ts:56`, `#${token}`, and `src/ipc.ts:53` says so: "The link
carries an access token"). `open <url>` hands it to LaunchServices, which opens it in the person's
default browser in their logged-in profile, with no `--user-data-dir`. On Linux the viewer always gets
a private profile (`src/host-browsers.ts:184-187, 205, 261`); on macOS it never does.

The viewer is the person's own surface, so opening their browser is arguably the intent. The defects
are that the token is written into their real profile's history and is readable by any extension in
that profile with history or tabs permission, that no private viewer profile is ever used on macOS,
and that `sbar-orbit preview browsers` returns an empty list on every Mac so the settings row has
nothing in it and the person cannot choose.

Fix. Use `"/usr/bin/open"`. Add a darwin branch to `listHostBrowsers` that enumerates
`/Applications` and `~/Applications` the way `darwinBrowserInstalls` already does
(`src/runtime-paths.ts:99`), returning the Mach-O inside the bundle so `viewerCommand` can pass
`--user-data-dir=${viewerProfileDirectory(...)}` and `--app=`, exactly as on Linux. Note separately
that `viewerProfileDirectory` (`src/host-browsers.ts:186`) hardcodes the XDG layout
(`~/.local/state`) rather than calling `stateDirectory()`, which every other per-user path branches
through (`src/service.ts:101`); that will put a viewer profile in the wrong place on macOS the moment
a browser is found there.

---

## M5. `ri_user_time` and `ri_system_time` are mach absolute time, not nanoseconds

**`src/macos.ts:82-83`, `src/macos.ts:94-95`, `src/macos.ts:113`**

The four RUSAGE offsets themselves are **correct**. `struct rusage_info_v0`, which is the prefix of
every later version including v4, is:

```
uint8_t  ri_uuid[16];            0
uint64_t ri_user_time;          16   <- RUSAGE.userTimeNs, correct
uint64_t ri_system_time;        24   <- RUSAGE.systemTimeNs, correct
uint64_t ri_pkg_idle_wkups;     32
uint64_t ri_interrupt_wkups;    40
uint64_t ri_pageins;            48
uint64_t ri_wired_size;         56
uint64_t ri_resident_size;      64   <- RUSAGE.residentBytes, correct
uint64_t ri_phys_footprint;     72   <- RUSAGE.physFootprintBytes, correct
```

The defect is the UNIT, not the offset. In XNU, `fill_task_rusage()` (bsd/kern/kern_resource.c) fills
these from `task_power_info_locked()`, whose `total_user` and `total_system` are the task's
accumulated thread times in **mach absolute time units**, not nanoseconds. On Intel Macs the timebase
is 1/1 and a tick is a nanosecond, so the field name happens to be right. On Apple silicon the
timebase is 125/3, a tick is about 41.67 ns, and `cpuNs` is therefore roughly **24 times too small**.
The type name `cpuNs` and the doc at `macos.ts:94` ("User plus system CPU, in nanoseconds") both state
the wrong thing on the platform Orbit's own comments say it measured on.

I could not execute this on a Mac. It is a header-and-source reasoning claim and should be confirmed
with one line on an arm64 Mac: spin a busy loop for a known wall-clock second and compare
`processUsage(pid).cpuNs` against it; a 24x shortfall confirms the unit.

What it does and does not affect: `cpuNs` is summed in `processGroupUsage` (`src/macos.ts:329`) and
surfaced from there, but `sharedBudgetUsage` (`src/macos-budget.ts:123-133`) sums only
`footprintBytes` and `processes`, and `requireHeadroom` (`src/resource-budget.ts:181`) reads only
tasks and memory. **No kill and no refusal is gated on `cpuNs` today.** This is a reporting
correctness bug, not a kill-gate bug, and I am rating it accordingly.

Fix. Read the timebase once via `mach_timebase_info` and convert, or rename the field to
`cpuAbsoluteTicks` and state the unit honestly:

```ts
const tb = new Uint32Array(2); system().mach_timebase_info(ptr(tb));   // numer, denom
const toNs = (ticks: number) => ticks * tb[0]! / tb[1]!;
```

---

## L1. The macOS supervisor SIGKILLs itself and loses both its exit code and its confirmation poll

**`src/native/supervise-darwin.ts:89-92`**

```ts
signalProcessGroup(pgid, SIGNAL.KILL);
for (let attempt = 0; attempt < 80 && processGroupMembers(pgid).pids.length > 1; attempt++) await Bun.sleep(25);
process.exit(child.exitCode ?? 0);
```

The supervisor is a member of the group it is killing (line 45 made it the leader). SIGKILL cannot be
caught, so the supervisor dies inside line 89: the poll at line 90 never runs, and `process.exit()` at
line 92 never runs.

Reproduced on Linux (`/tmp/orbit-macos-audit/killpg-self.ts`): a session leader that `killpg`s its own
group with SIGKILL exits 137 / SIGKILL and the following line never prints. The SIGTERM at line 83 is
survived, correctly, because the handlers at lines 67-68 are installed.

Consequences are modest: the signal IS delivered to the whole group, which is the point, so
containment still happens. What is lost is the supervisor's ability to confirm the group emptied
(line 90 is dead code) and to report the browser's exit code (line 92 is dead code), so
`src/chrome.ts:141` `exitCode()` always reads the supervisor's SIGKILL rather than Chrome's status,
and a failure to reap is indistinguishable from a successful one.

Fix. Exclude self from the final kill: enumerate `processGroupMembers(pgid).pids`, filter out
`process.pid`, and `kill(9)` each, or fork the escalation into a short-lived helper outside the group.
Then the poll and the exit code become real.

---

## L2. `mkdir(mode)` does not repair an existing directory, and the socket has a chmod window

**`src/macos-budget.ts:72`, `src/install.ts:330`, `src/ipc.ts:36` with `src/ipc.ts:78`**

`mkdir(root, { recursive: true, mode: 0o700 })` applies its mode only to directories it creates, and
that mode is masked by the umask. A directory that already exists with looser bits is left as it is.
This appears at `src/macos-budget.ts:72` (registry root), `src/install.ts:330` (connector config
directory), `src/macos-autostart.ts:174` and `:193`. `src/diagnostics.ts:28-31` is the counterexample
done right: it `mkdir`s, `lstat`s, refuses a symlink, and then `chmod`s unconditionally.

Separately, `src/ipc.ts:36` binds the unix socket and `src/ipc.ts:78` chmods it to 0600 only after
`Bun.serve` returns. Between those two points the socket carries the umask default, which for a socket
is typically world-connectable.

Both are mitigated in practice on macOS: every default path is under `~/Library/...` inside a home
directory that is mode 0700 on macOS by default, and the socket's parent is created 0700 by
`claimSocket` (`src/service.ts:148`). That mitigation disappears the moment `ORBIT_BUDGET_ROOT` or
`ORBIT_SOCKET` names a shared directory, which is finding H3 again from another side.

Fix. Follow the `diagnostics.ts` pattern everywhere: after `mkdir`, `lstat`, refuse a symlink or a
non-directory or a foreign owner, then `chmod(0o700)` unconditionally. For the socket, create it
inside a 0700 directory (already true by default) and additionally set the umask around the bind, or
bind to a temporary name, chmod, then rename.

---

## L3. `enableLaunchAgent` does not check who can write the launcher it makes launchd execute at every login

**`src/macos-autostart.ts:190-194`**

```ts
try { if (!(await stat(launcher)).isFile()) throw new Error("not a file"); }
catch { throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file"); }
```

The only property checked is "regular file". The plist then names it in `ProgramArguments` and launchd
executes it at every login, for the life of the install. A launcher under a directory writable by
another user, or a symlink to one, is persistence with the person's full user privileges.

Today `launcher` comes from `activateLocal(source, prefix)` with `prefix` defaulting to the person's
own prefix and overridable only by their own `--prefix` flag (`src/install.ts:178, 258, 261`), so this
is the person's own choice rather than an attacker's. It is worth closing anyway because a LaunchAgent
is the highest-value thing this adapter writes.

Fix. `lstat` rather than `stat` (refuse a symlink), and require `uid === process.getuid()` and
`(mode & 0o022) === 0` on the launcher and on every directory component of its path, before writing a
plist that names it.

---

## L4. The refusal-list regexes are evadable, and they do not cover every shipped file

**`scripts/public-audit.ts:84` and `scripts/public-audit.ts:86-101`**

`bun run scripts/public-audit.ts` runs clean on the current tree (`filesChecked: 384, findings: []`),
so there is no violation to report. The rules themselves are weaker than the table they enforce.

Coverage gap. Line 84 scopes the forbidden-symbol rules to
`/^(?:src|scripts|bin|desktop|viewer|experiments|tests)\//`. `install.sh`, `install.cmd`,
`extension/`, `website/`, `skills/` and `.github/` are all shipped and none is scanned for these
symbols. `install.sh` is an executable shell script that runs on the person's Mac, so an `osascript`
or a `screencapture` there passes the audit today.

Evasion. I ran the real patterns against fourteen probes
(`/tmp/orbit-macos-audit/regex.ts`). Every one of these is a genuine TCC-raising call and every one is
MISSED:

```
MISSED  CGWindowListCreateImageFromArray(...)      screen recording, the array variant
MISSED  CGDisplayCreateImage(CGMainDisplayID())    screen recording, the display variant
MISSED  SCStreamConfiguration / SCShareableContent ScreenCaptureKit by its real class names
MISSED  Bun.spawn(["screencapture", "-x", out])    the rule requires the literal /usr/sbin/ prefix
MISSED  Bun.spawn([Bun.which("screencapture")!, o]) same, resolved from PATH
MISSED  AXIsProcessTrustedWithOptions(opts)        accessibility, does not start with AXUIElement
MISSED  CGEventTapCreateForPid(pid, ...)           input monitoring, the ForPid variant
MISSED  CGWarpMouseCursorPosition(pt)              moves the person's real pointer
MISSED  CGDisplayMoveCursorToPoint(d, pt)          moves the person's real pointer
MISSED  IOHIDPostEvent(service, ...)               raw HID input, not IOHIDManager*
MISSED  const f = sym["CGEvent" + "Post"]          string concatenation
MISSED  dlopen("Screen" + "CaptureKit")            string concatenation
MISSED  const tool = "osa" + "script"; spawn(tool) string concatenation
MISSED  NSWorkspace.shared.open(url)               opens in the person's real browser
CAUGHT  CGWindowListCreateImage(rect)
CAUGHT  osascript -e 'tell app'
```

The `\b` anchors are the reason: `CGWindowListCreateImage\b` does not match
`CGWindowListCreateImageFromArray`, and `AXUIElement\w*` does not match `AXIsProcessTrusted`. String
concatenation defeats any source grep by construction, which `public-audit.ts:78` already
acknowledges ("necessary and not sufficient"), so that part is a known and accepted limit rather than
a surprise.

Fix, in order of value:

1. Widen the scope at line 84 to every shipped text file, with the existing `.md` exemption:
   `const sourceFile = !file.endsWith(".md");`
2. Drop the closing `\b` and the path prefixes, and widen the families:
   - screen recording: `/CGWindowListCreateImage|CGDisplayCreateImage|CGDisplayStream|ScreenCaptureKit|\bSC(?:Stream|ShareableContent|ContentFilter)\b|\bscreencapture\b/`
   - accessibility and synthetic input: `/\bAX[A-Z]\w*|CGEventPost|CGEventCreate|CGWarpMouseCursorPosition|CGDisplayMoveCursorToPoint/`
   - input monitoring: `/CGEventTapCreate|IOHID[A-Z]\w*/`
   - automation: `/NSAppleScript|\bosascript\b|AESendMessage|NSWorkspace/`
3. Add a rule that catches the evasion technique rather than the symbol: flag any `dlopen(` whose
   argument is not a string literal, and any `Bun.spawn([` whose first element is not a string
   literal, in `src/` and `scripts/`. That turns "a variable reached exec" into a reviewable event
   instead of an invisible one.

Note the `com.apple.quarantine` and `xcode-select` rules are correct as written, and
`/usr/sbin/screencapture` is the right path for that binary; the problem is only that the path is
required.

---

## Categories with no finding

Said plainly rather than padded.

**FFI buffer sizing and return-value checking (question 1).** All correct, with one caveat already
filed as M5 about units rather than sizes.

- `processUsage` (`macos.ts:106`): `struct rusage_info_v4` is 288 bytes (v0 96, +48 v1, +16 v2, +64 v3,
  +64 v4); the buffer is 512. Return checked `!== 0` before any decode. Correct.
- `processGroupMembers` (`macos.ts:132-141`): capacity grows 1024 to 8192 int32s, the exactly-full
  case is retried once and then honestly reported `complete: false`. The byte-count-not-pid-count
  distinction at line 136 is right. The only defect is the error conflation, filed as H2. The
  `return { pids: [], complete: false }` at line 143 is unreachable; harmless.
- `childProcesses` (`macos.ts:164-169`): both buffers sized by `byteLength`, both return values
  checked `> 0`, self removed from the set. Correct.
- `processPath` (`macos.ts:185-188`): `PATH_MAX_BYTES` 4096 is `PROC_PIDPATHINFO_MAXSIZE`
  (`4 * MAXPATHLEN`), return checked `<= 0`, and `proc_pidpath` returns `strlen` of the result so
  `subarray(0, length)` is exactly right with no trailing NUL. Correct.
- `processStartedAtMs` (`macos.ts:264-272`): buffer is exactly `PROC_BSDINFO_SIZE`, and the check
  `written !== PROC_BSDINFO_SIZE` refuses a short read rather than decoding it, which is the right
  call for a value that gates a kill.
- FFI signatures all match `libproc.h`: `proc_pid_rusage(int, int, rusage_info_t*)`,
  `proc_listpids(uint32_t, uint32_t, void*, int)`, `proc_pidinfo(int, int, uint64_t, void*, int)`,
  `proc_pidpath(int, void*, uint32_t)`.

**The `proc_bsdinfo` offsets.** Correct. Laying out `struct proc_bsdinfo` from `sys/proc_info.h`:
flags 0, status 4, xstatus 8, pid 12, ppid 16, uid 20, gid 24, ruid 28, rgid 32, svuid 36, svgid 40,
rfu_1 44, `pbi_comm[MAXCOMLEN=16]` 48, `pbi_name[2*MAXCOMLEN=32]` 64, nfiles 96, pgid 100, pjobc 104,
e_tdev 108, e_tpgid 112, nice 116, **`pbi_start_tvsec` 120**, **`pbi_start_tvusec` 128**, total **136**.
All three constants at `macos.ts:257-260` match. No silent wrong number gating a kill from this
source.

**`pbi_flags` at 16 and `PROC_FLAG_DARWINBG 0x8000`.** These do not exist in the audited tree. There
is no `pbi_flags` read, no `PROC_FLAG_DARWINBG`, and no `0x8000` anywhere in `src/`. Nothing reads
back whether `taskpolicy -b` took effect. So there is no offset to be wrong. Stating it because the
brief asked: had it been there, `pbi_flags` is at offset **0**, not 16, and 16 is `pbi_ppid`, so that
code would have compared a parent pid against a flag bit. It is not present.

**Does any path signal a group Orbit did not create? (question 2, the worst-case question.)** No, and
I looked for one specifically.

- `supervise-darwin.ts:83` and `:89` use the unchecked `signalProcessGroup`, but on `pgid` returned by
  `becomeSessionLeader()` at line 45, which is this process's own pid and own group. A live process's
  own pgid cannot be recycled while it lives, so reuse is impossible by construction, exactly as the
  comment at `macos.ts:305-308` claims.
- `scripts/limited.ts:43` likewise signals its own group from `becomeGroupLeader()`. Safe as to
  target; defective as to termination, filed as M2.
- `chrome.ts:160-176` reads only; it never signals.
- `macos-budget.ts` never signals.
- `signalOwnedProcessGroup`, the one function that could signal a remembered number, has no callers
  (filed as H1).

So the worst bug is absent. What is present is the opposite failure: nothing sweeps at all.

**TOCTOU inside `groupIsStillOurs`.** Structurally present and, in my judgement, acceptable. Between
`processStartedAtMs` / `processPath` (`macos.ts:292, 296`) and the `killpg` at `macos.ts:312` the
leader could exit and its pgid be recycled. Closing it would require a pidfd equivalent, and darwin's
`pidfd`-like primitive is `dispatch_source` `PROC_EXIT`, which does not make `killpg` atomic. Exploiting
it requires cycling the entire pid space (`kern.maxproc` scale) inside a window of microseconds and
landing on the exact number. I would not spend engineering on it, but it should be written down in
`docs/porting.md` beside the two-fact identity claim rather than left implicit, because the current
comment at `macos.ts:286-288` reads as though the check is total.

**The LaunchAgent plist (question 4).** No injection found, and I tried. `xml()`
(`macos-autostart.ts:54-57`) escapes all five XML entities, which is the complete set, and it is
applied to the launcher, to every environment key and value, and to the log path
(`macos-autostart.ts:89, 110, 113`). I ran four crafted `HOME` and launcher values through the real
`brokerAgentPlist` (`/tmp/orbit-macos-audit/plist.ts`), including
`/Users/x</string><key>AbandonProcessGroup</key><true/><string>` and a `ProgramArguments`-replacing
payload ending in `osascript`. Every one renders as escaped text inside the original `<string>`:

```xml
<string>/Users/a&amp;b&lt;/string&gt;&lt;key&gt;AbandonProcessGroup&lt;/key&gt;&lt;true/&gt;&lt;string&gt;</string>
```

The `BROKER_LABEL` at line 86 is a module constant, not an input. The one apparent hit in my harness
output was my own detector matching the template's unconditional `<false/></dict><key>ProcessType`,
not an injection.

On missing keys: `AbandonProcessGroup` is correctly absent and the reason is documented
(`macos-autostart.ts:17-20`); adding it would break the bootout containment layer. `RunAtLoad`,
`KeepAlive{SuccessfulExit:false}`, `ProcessType Background`, `Nice`, and both low-priority IO keys are
present and sensible. `HardResourceLimits` is correctly absent with the reasoning recorded at lines
71-74. Nothing missing would make launchd do something unwanted. `StandardOutPath` is absent so
`serve`'s JSON line goes to `/dev/null`, which is cosmetic, and the `mkdir` for the log directory at
line 193 swallows its error with `.catch(() => {})`, so a failure there surfaces later as a launchd
spawn complaint rather than an install failure; neither is a security issue.

**Command and argument injection generally (question 5).** Every `Bun.spawn` in the darwin paths
passes an argv array; there is no shell anywhere, no `sh -c`, no string interpolation into a command
line. `profile` is always `mkdtemp`-generated (`src/session.ts:147`), absolute, and cannot begin with
`-`. `executable` on darwin comes only from `darwinBrowserInstalls()` (`src/runtime-paths.ts:99-123`),
which is a table of literal bundle paths, or from `defaultChromeExecutable()`, and cloning (the only
route by which a caller names an executable) is refused outright on darwin at `src/platform.ts:406`.
`chrome.ts:268` additionally requires the file to exist. The `taskpolicy` prefix threading through
`supervise-darwin.ts:33`'s destructuring is correct in both the present and absent cases. The one
unguarded surface is `extraArgs`, filed as M3 and explicitly marked not currently reachable.

**Diagnostics journal permissions.** No finding, and it is the best-behaved writer in the adapter:
`mkdir` 0700 then `lstat` then unconditional `chmod` (`src/diagnostics.ts:28-31`), `lstat`-before-open
with `O_NOFOLLOW` where the platform defines it, `nlink === 1`, a size ceiling, and `chmod(0o600)` on
the handle itself (`src/diagnostics.ts:33-62`). This is the pattern L2 asks the other writers to
adopt.

**`owner.json` permissions.** No finding. Written `mode: 0o600` on both the error and the success path
(`supervise-darwin.ts:51, 63`), inside a `mkdtemp` profile directory (0700), inside a broker workspace
that `createWorkspaceDirectory` has verified is owned by this user with no group or other bits
(`workspace-storage.ts:30-40`). It is not attacker-writable on a correctly configured Mac. It is only
a trust problem to the extent that its `leaderStartedAtMs` may be null, which is M1.

**Connector `mcp.json`.** No finding: `mkdir` 0700, `writeFile` 0600 (`src/install.ts:330-332`),
under `~/Library/Application Support/sbar-orbit` on darwin (`src/service.ts:57-60`).

**`preflight.ts` darwin branch.** No finding. It probes absolute paths only, has no remedy that runs
anything, and correctly refuses to emit Fedora remedies off Linux (`src/preflight.ts:95`).

---

## Severity summary

| ID | Severity | File:line | One line |
|----|----------|-----------|----------|
| H1 | High | `src/macos.ts:310`, `src/cli.ts:78` | The documented broker start-up sweep does not exist; a SIGKILLed supervisor orphans Chrome forever and `cleanWorkspaces` then deletes its live profile |
| H2 | High | `src/macos.ts:135` | A failed `proc_listpids` reads as "group is empty and that is certain", which skips SIGKILL escalation in the supervisor |
| H3 | High | `src/macos-budget.ts:53` | Unvalidated `ORBIT_BUDGET_ROOT` lets any caller fabricate a registry and pass the entire resource-budget gate |
| M1 | Medium | `src/chrome.ts:169`, `src/macos-budget.ts:110` | A missing or null `leaderStartedAtMs` silently disables the pgid-reuse identity check instead of failing closed |
| M2 | Medium | `scripts/limited.ts:43` | The SIGTERM handler `killpg`s the group it is inside, looping on itself; the process never exits (reproduced) |
| M3 | Medium | `src/chrome.ts:324` | `extraArgs` is spliced after every containment flag and last-wins would override `--user-data-dir`; not reachable today, no guard |
| M4 | Medium | `src/host-browsers.ts:212` | macOS viewer uses PATH-resolved `open`, so the token URL lands in the person's real browser profile with no private profile |
| M5 | Medium | `src/macos.ts:82`, `:113` | `ri_user_time`/`ri_system_time` are mach ticks, not nanoseconds; `cpuNs` is ~24x low on Apple silicon. Reporting only, gates nothing |
| L1 | Low | `src/native/supervise-darwin.ts:89` | The supervisor SIGKILLs itself, so its confirmation poll and exit-code report are dead code (reproduced) |
| L2 | Low | `src/macos-budget.ts:72`, `src/ipc.ts:78` | `mkdir(mode)` does not repair an existing directory; the socket has a bind-to-chmod window |
| L3 | Low | `src/macos-autostart.ts:190` | The launcher that launchd runs at every login is checked for "is a file" and nothing else |
| L4 | Low | `scripts/public-audit.ts:84`, `:88` | The TCC refusal regexes miss 14 real call spellings and skip `install.sh`, `extension/`, `website/` |

No finding, stated plainly: FFI buffer sizes and return checks, the RUSAGE offsets, the
`proc_bsdinfo` offsets and size, plist XML injection, plist missing keys, shell or argument injection
via profile or executable paths, `owner.json` permissions, the diagnostics journal, the connector
`mcp.json`, and the `preflight` darwin branch. There is no path on which Orbit signals a process group
it did not create.
