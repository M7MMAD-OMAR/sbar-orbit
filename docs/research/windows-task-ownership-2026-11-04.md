# Windows task ownership: observed serialization and qualified semantics

Status: research and diagnostic evidence, not an ownership-policy relaxation or completed Windows acceptance. Live release remains 0.4.2. The 0.4.3 candidate is unsigned and does not support native Windows application control.

## Actual boundary reached

- Run [41766883915](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41766883915) passed native source/dependency/runtime checks and entered the central installer. The owned unknown-root refusal is now proven, not inferred from Setup exit 7.
- Run [41770179986](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41770179986) passed the unchanged task-absence query and reached `health`, then returned `broker-not-ready`. This does not explain an earlier query refusal or prove broker readiness.
- Run [41773116241](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41773116241) established valid installed source bytes with launch admission closed by the retained recovery barrier. The task existed, was ready after failure cleanup, and reported `267014` (`0x41306`). These are post-cleanup observations, not an original startup exit diagnosis.
- Run [41774860386](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41774860386) found that the unchanged ownership predicate rejected COM XML. The action command/arguments, environment binding and several settings matched; principal text, RunLevel presence, whole XML sections and several omitted settings did not. No raw XML, accounts, SIDs, paths, environment values or product binaries were uploaded.

Run [41776574344](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41776574344), source `757b6989b847427cc405be978af147d303131e1e`, subsequently qualified the actual startup transport: `schtasks /Query /XML` completed with no NUL, BOM or replacement-prefix flags and produced the same failed predicate-check vector as COM. Both principal and logon-trigger UserId references resolved through Windows to the live expected SID, with exactly 2 references and none unresolved. The actual typed RunLevel was LUA 0, and all five typed effective-setting comparisons matched the requested policy. Missing or wrong getter types remained unknown, not coerced to defaults.

This qualifies a shared semantic ownership repair, not a foreign-task adoption or successful runtime acceptance. The authoritative matcher was unchanged during measurement. Startup, lifecycle, updater and uninstall must share the repaired predicate, preserving live identity proof and every effective side-effect constraint. Broker readiness, actual GUI execution and update/rollback acceptance remain required before publication.

## Microsoft primary references

The [full Task Scheduler XSD](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema) declares optional settings and these defaults:

| Default | Elements |
| --- | --- |
| `true` | `AllowHardTerminate`, `AllowStartOnDemand`, `Enabled` |
| `false` | `StartWhenAvailable`, `RunOnlyIfNetworkAvailable`, `Hidden`, `RunOnlyIfIdle`, `WakeToRun` |
| `7` | `Priority` |

This is not blanket authority to ignore missing or additional fields. Expected effective policy, duplicate/unknown-node rejection, actual registered getters and version applicability still matter.

`RunLevel` is optional but has **no explicit XSD default**. [Security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks) describe default low privileges when UAC is enabled. [Principal.RunLevel](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-runlevel) defines LUA as 0 and Highest as 1. Read the actual typed value before qualifying omission; do not claim privilege isolation for accounts or UAC configurations where Windows ignores this setting.

[TaskSettings.AllowDemandStart](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-allowdemandstart) is the COM name corresponding to XML `AllowStartOnDemand`, and defaults to true. The names are not interchangeable API property strings.

[LogonTrigger.UserId](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger-userid) accepts a user name or SID; a missing user means any user and must not be adopted as the current SID. [NTAccount.Translate](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.ntaccount.translate?view=net-10.0) can qualify an actual account reference to `SecurityIdentifier`; unresolved or mismatched identities remain unqualified. Apply this separately to the principal and the logon trigger. Never use user-name text heuristics or caller-supplied alias booleans as authority.

[RegisteredTask.Xml](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-xml) is registration information in XML form; [RegisteredTask.Definition](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-definition) exposes the registered definition. The reviewed documentation supplies no byte-preserving export guarantee.

## Repair constraints

- Keep task absence tri-state and fail closed. A query error, nonzero exit, timeout or malformed output is never absence.
- Keep source/dependency seals, SID binding, explicit update consent, current-version selection, recovery barriers and exact health identity.
- If normalization becomes justified, share one semantic ownership predicate across startup, stop/restart, updater and uninstall. Do not add a startup-only bypass.
- Preserve all effective actions, triggers, environment, settings and account scope. Unknown extra fields, elevation, password/S4U logons, additional actions or triggers must remain refused.
- Do not infer startup failure from post-cleanup task results, change readiness thresholds from guesses, or start a second broker for diagnosis.
