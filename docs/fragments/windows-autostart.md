# Autostart of the broker on Windows

Current follow-up: the [installed command acceptance](installed-command-acceptance.md)
closes the browser chain after logon on the Windows guest. The installer now starts
an account-specific task immediately and verifies the broker. The sections below
preserve the earlier measurement and its then-open limits.

This closes the row `docs/support-tiers.md` recorded as unmeasured: "Always with `--no-service`: the
service step refuses on Windows by design, so autostart there is not measured". Every Windows install
before this one ran with `--no-service`, because the service step returned `skipped` on Windows. It no
longer does.

Measured on the Windows 11 25H2 guest (build 26200, 8 vCPU, Edge 151, Bun 1.4.2) under libvirt, driven
only through `experiments/windows-vm/`, on 19 September 2026.

## The design decision, and the two options the measurement rejected

A Windows Service is the wrong shape and was never built. `docs/windows-measured.md` section 1 already
measured the reason: a Chromium family browser launched from session 0 as SYSTEM exits at once and
never publishes `DevToolsActivePort`. A service runs in session 0. It would install cleanly, start
cleanly, and then be unable to do the one thing the broker exists for.

So the question was which per user, interactive session mechanism to use. Three were armed together by
`experiments/windows-vm/autostart-probe.ps1`, as the ordinary unelevated interactive user, and the
guest was rebooted. Each ran the same payload, so the only difference between the three results is the
mechanism.

| Mechanism | Armed | Fired at logon | Verdict |
|---|---|---|---|
| Scheduled task, logon trigger, imported as XML | yes | **yes, 21 seconds after boot, `Last Result: 0`, session 1** | chosen |
| HKCU `...\CurrentVersion\Run` | yes | no | rejected |
| Per user Startup folder `.cmd` | yes | no | rejected |

### Why not `schtasks /SC ONLOGON`, which is the obvious spelling

Refused, unelevated, and this is the finding that decided the implementation shape. Run as
`<domain>\<user>`, `elevated: False`:

```
schtasks.exe /Create /TN OrbitAutostartProbeOnlogon /TR "..." /SC ONLOGON /F
ERROR: Access is denied.                                        [exit 1]

schtasks.exe /Create /TN OrbitV1 /TR "..." /SC ONLOGON /F        (no /RU, no /RL)
ERROR: Access is denied.                                        [exit 1]
```

Two controls prove it is the ONLOGON trigger specifically and not `schtasks` or the account:

```
schtasks.exe /Create /TN OrbitV3 /TR "..." /SC ONCE  /ST 23:58 /F   SUCCESS  [exit 0]
schtasks.exe /Create /TN OrbitV4 /TR "..." /SC DAILY /ST 23:57 /F   SUCCESS  [exit 0]
```

`/SC ONLOGON` with no user is a trigger for ANY user logging on, which is a machine wide change, and an
unelevated caller may not make one. A `LogonTrigger` carrying this account's own SID is a change to one
account, and that is permitted. The same task imported from XML, from the same unelevated shell:

```
schtasks.exe /Create /TN OrbitAutostartProbeTask /XML C:\orbit\autostart-probe\task.xml /F
SUCCESS: The scheduled task "OrbitAutostartProbeTask" has successfully been created.   [exit 0]
```

`Register-ScheduledTask -AtLogOn -User <this account>` also succeeded unelevated. The XML form was
chosen over it because it is one `schtasks` call with no PowerShell dependency, and because the exact
document is then assertable in a test.

Nothing here elevates. Orbit installs per user with no privilege on Linux and macOS, and an autostart
that needed an administrator would be a different product.

### Why the Run key and the Startup folder were rejected

Both are sound mechanisms and both failed the only test that matters. After the reboot, measured:

- both were still armed: the Run value was present, the Startup `.cmd` was present
- neither was disabled: `StartupApproved\Run` and `StartupApproved\StartupFolder` were both empty
- Explorer was running as the person: `explorer.exe pid 6472 session 1 started 02:25:32`
- Windows itself listed both under `Win32_StartupCommand`
- neither payload wrote a single line

The same `.cmd` the Run key names, run by hand afterwards, ran perfectly and reached session 1:

```
02:32:06 AM  started, mechanism: runkey
02:32:06 AM  whoami: <domain>\<user>
02:32:06 AM  session id: 1
02:32:06 AM  interactive: True
```

So the command is correct and the delivery is Explorer's, which did not run it on this guest's logon.
A mechanism whose firing depends on a shell sweep that can silently not happen is not the one to build
autostart on. This is a measurement on one guest, and it is stated as such: it does not prove the Run
key never works, it proves it did not work here while the task did.

## What is installed

`src/windows-autostart.ts` registers one scheduled task, `SbarOrbitBroker`, from generated XML:

```xml
<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-...-1006</UserId></LogonTrigger>
<Principal id="Author">
  <UserId>S-1-5-21-...-1006</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
<Exec><Command>cmd.exe</Command>
  <Arguments>/c "C:\...\bin\sbar-orbit.cmd" serve --managed-socket</Arguments></Exec>
```

Each element for a reason:

- `InteractiveToken` is the session 0 question restated. A password based logon type would run the
  broker where a browser cannot start.
- `LeastPrivilege`, because Orbit asks for no privilege anywhere else either. Read back after
  registration, Task Scheduler reports `RunLevel: Limited`.
- `PT0S`, no execution time limit. The default is three days, after which Task Scheduler stops the
  task, and a broker is meant to outlive that.
- `cmd.exe /c`, because `Exec` is a `CreateProcess` call and that does not run a `.cmd` file.
- An environment is set by the shell in the action, because a logon task inherits no shell profile.
  The task's inherited PATH was measured as
  `C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\;C:\WINDOWS\System32\OpenSSH\;%LOCALAPPDATA%\Microsoft\WindowsApps`
  and nothing else. This is the same defect the macOS LaunchAgent port found. It is survivable only
  because `bin\sbar-orbit.cmd` already resolves Bun by location rather than through PATH, and that
  property is load bearing for autostart rather than a nicety.

## The install, which had never run on Windows without `--no-service`

```
install.cmd --json --prefix C:\orbit\prefix-autostart          [exit 0]
installed: True
  step prerequisites: done :: everything this step can see is present
  step launcher:      done :: C:\orbit\prefix-autostart\bin\sbar-orbit.cmd
  step service:       done :: the SbarOrbitBroker logon task is registered and starts the broker when you log in
  step connector:     done :: %APPDATA%\sbar-orbit\mcp.json, unchanged
  step verify:        skipped :: ... so there is no broker to verify until you log in again
```

Read back out of Task Scheduler rather than out of the report:

```
TaskName:      \SbarOrbitBroker
Status:        Ready
Logon Mode:    Interactive only
Task To Run:   cmd.exe /c "C:\orbit\prefix-autostart\bin\sbar-orbit.cmd" serve --managed-socket
Comment:       Sbar Orbit local broker, started when you log in
Schedule Type: At logon time
Run As User:   <user>
principal RunLevel: Limited  LogonType: Interactive  UserId: <user>
```

**One product defect this found.** The first run reported `service: done` and then
`verify: failed, no answer from the managed broker`, exiting 1 on a machine where every step had in
fact succeeded. A logon task is not `systemctl enable --now`: it starts the broker at the NEXT logon
and starts nothing at registration time, and the verify step polled a socket nothing was serving yet
for 15 seconds. The service step now publishes `startsAtNextLogon: true` and verify skips on it. This
is the same shape of defect as the one recorded in `src/install.ts` about waiting for a managed broker
Windows never installs, and it was found the same way: by running the real install, not by the suite.

## What fired at logon, with no human action

The reboot at 2:25 AM, with the probe's three mechanisms armed:

```
02:25:41 AM  started, mechanism: task
02:25:42 AM  session id: 1
02:25:42 AM  interactive: True
02:25:42 AM  seconds since boot: 21

TaskName: \OrbitAutostartProbeTask   Last Run Time: 9/19/2026 2:25:37 AM   Last Result: 0
query session:  services  0  Disc  |  >console  <user>  1  Active
```

The task fired 21 seconds after boot, in session 1, interactive, with no human action beyond the logon
itself, and Task Scheduler recorded the run as succeeding. That is the mechanism measured.

**A second product defect this found.** The broker the task started then died:

```
error: EPERM reading "C:\orbit\...\node_modules\zod\index.js"
Bun v1.4.2 (Windows x64)
```

That is guest state, not Orbit: three of the four source trees on this guest have a `node_modules\zod`
that is unreadable even to its owning account, from earlier ACL experiments. A fourth tree reads fine
and is what the install above used. It is recorded here because it is exactly the failure mode a real
autostart has, a broker that starts and exits with nobody watching, and because it is why the chain
below is incomplete rather than green.

## What is NOT measured, and why

**The post logon broker chain.** The task fires and reaches the interactive session, measured. What is
not measured is the rest: the autostarted broker answering `status`, `session create browser` reaching
`running`, and a frame whose metadata names the page, all after a logon with no human action. The
armed verification script is on the guest at `C:\orbit\autostart-evidence\verify.ps1` and has never run.

The reason is the logon. The first reboot reached the desktop because the guest carried
`AutoAdminLogon=1` with a `DefaultPassword`, pre-existing project state that I did not write. That
autologon is one shot on this build: after it was consumed, `AutoAdminLogon` read `0` and
`DefaultPassword` was gone. The second reboot therefore stopped at the password prompt. `net user`
reports `Password required: No`, which means a password is not required to be SET, not that the account
has none, and an empty submission returned "The password is incorrect. Try again."

I did not, and will not, get past that:

- I did not write `AutoAdminLogon` or `DefaultPassword`. Doing so stores an account password in
  cleartext in a registry value readable by every account on the machine, which is a real security
  regression on a machine that is part of this project's evidence, and an autostart measured only under
  a machine reconfigured to log in without a password is a measurement of the test rig rather than of
  autostart.
- I did not type the account's password, and it does not appear in any transcript or file.
- `virsh send-key` reaches the guest (the "password is incorrect" dialog is the proof) but cannot
  authenticate.
- The domain has no snapshot to revert to: `virsh snapshot-list win11` is empty.

So the honest statement is: the logon TRIGGER has been measured firing at a real logon. The broker
chain AFTER logon is `not measured`, and closing it needs either a guest account whose password the
owner sets to empty, or a snapshot taken while logged on.

Everything the probes left behind was removed: the probe's Run value (removed by loading the offline
user hive, since nobody is logged on), the probe's Startup `.cmd`, and the probe tasks. The product's
own `SbarOrbitBroker` task is left in place, because it is the thing that was installed.

## Tests

`tests/windows-autostart.test.ts`, 19 tests. The XML builder is asserted on every platform, because
the rule it encodes is about Windows whoever is asking, the same reason `tests/windows-host.test.ts`
pins the Windows socket path from a Fedora host. Everything that talks to Task Scheduler is Windows
only and skipped elsewhere with the reason written down.

```
Linux  (Fedora host):  14 pass, 5 skip, 0 fail, 44 expect() calls
Windows (the guest):   19 pass, 0 skip, 0 fail, 62 expect() calls
```

The tests redirect `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOME`, `TEMP`, `TMP` and `TMPDIR` as well
as the XDG variables, and one test asserts the temporary XML lands inside that redirection. That is the
defect `docs/windows-measured.md` section 24 records: a test that redirected `XDG_CONFIG_HOME` only
wrote into the real roaming profile, because Windows ignores the XDG variables entirely.

### Mutation evidence

Every core invariant was broken deliberately, the failure observed, the code restored, and the suite
re-run green.

| Invariant | Mutation | Observed failure |
|---|---|---|
| The logon trigger is scoped to one account | removed `<UserId>` from `<LogonTrigger>` | `(fail) the task carries a logon trigger scoped to ONE account` ... `Expected substring or pattern: /<LogonTrigger>[\s\S]*?<UserId>S-1-5-21-...` |
| The task runs with an interactive token | `InteractiveToken` to `Password` | `(fail) the task asks for an interactive token and no elevation` ... `Expected to contain: "<LogonType>InteractiveToken</LogonType>"` |
| The task asks for no elevation | `LeastPrivilege` to `HighestAvailable` | same test, `Expected to contain: "<RunLevel>LeastPrivilege</RunLevel>"` |
| A path with `&` produces parseable XML | `xml()` escapes everything except `&` | `(fail) a path with an ampersand produces XML Task Scheduler can parse` ... `Expected to contain: "R&amp;D"` |
| The broker may run forever | `PT0S` to `P3D`, the three day default | `(fail) the task may run forever and refuses a second instance` ... `Expected to contain: "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"` |
| The temporary XML never stays in the profile | removed the `rm` in the `finally` | `(fail) the temporary XML is cleaned up and never left in the profile` ... `Expected: false, Received: true` |
| A foreign task of the same name is refused | removed the ownership check in `disableLogonTask` | on the guest: `(fail) a FOREIGN task of the same name is refused and left intact` ... `expect(received).rejects.toThrow(expected), Received promise that resolved` |

The last one is Windows only and was mutated and observed on the guest, not on the host, because on
Linux it is skipped and a skip proves nothing.

## Proposed row for the Windows table in docs/support-tiers.md

Replacing the existing "One command install (`sbar-orbit.cmd install`)" row's final sentence, and
adding one row:

| Capability | Tier | The deciding fact |
|---|---|---|
| Autostart of the broker at logon | Limited, and the chain after logon is not measured | Windows has no service for this and must not: a browser does not run in session 0. It has a per user logon task, and `install.cmd --json` now registers one with no `--no-service` and no elevation, exit 0, `installed: true`. `schtasks /SC ONLOGON` is refused unelevated with `ERROR: Access is denied.`, with and without `/RU` and `/RL`, while `/SC ONCE` and `/SC DAILY` succeed from the same shell, so the refusal is the machine wide trigger rather than the tool: the task is therefore imported from XML with a `LogonTrigger` scoped to this account's SID, which succeeds unelevated. Measured across a real reboot, the task fired 21 seconds after boot in session 1, interactive, `Last Result: 0`, with no human action. The HKCU `Run` key and the Startup folder were armed in the same reboot, were still armed and not disabled afterwards with Explorer running as the person, and neither fired; run by hand each reached session 1, so the delivery is Explorer's. **The chain after logon, the autostarted broker answering `status` and driving a browser session to a decoded frame, is `not measured`: the guest's one shot autologon was consumed by the first reboot and the account has a password, which was not typed and must not be stored in cleartext to make the measurement possible.** Two product defects came out of it: the install's verify step waited 15 seconds for a broker a logon task starts only at the next logon, and reported `verify: failed` on a machine where every step succeeded |

`bin\sbar-orbit.cmd` no longer refuses `autostart` by name on Windows. `sbar-orbit.cmd autostart status`
reports what is registered, whether Orbit wrote it, Task Scheduler's own last result, the registered
XML, and the three mechanisms this design rejected with the measurement that rejected each.
