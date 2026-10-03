# Native scoped enrollment evidence

Reviewed 4 October 2026. This is prototype ownership integration, not owner
desktop activation or project release acceptance.

## Behavior

`ghost-register-scope-process <pid> <unit>` enrolls one same-user process in an
exact `orbit-native-<32 lowercase hex characters>.scope` under the Fedora user
manager's `sbarorbit.slice`. The plugin retains both a pidfd and the scope
directory descriptor. Each ownership check compares current cgroup membership,
the directory device and inode, and process liveness. An observed mismatch
permanently revokes that registration. Returning to the original scope requires
explicit registration again. Registration is bounded to 64 live process records;
revoked live records remain until exit or explicit replacement.

The launcher verifies the manager InvocationID and exact scope membership before
and after registration through `NativeLease`. The plugin does not continuously
query the manager, and membership checks do not constitute atomic isolation from
concurrent same-user cgroup mutations. This is cooperative same-user ownership,
not an operating-system security boundary.

An owner-session client cannot gain ownership merely by having a window on
`special:ghost`. The older environment registration and workspace fallback remain
available only in the private lab. A known revoked scoped client cannot use that
fallback, including after another registration prunes exited processes. Mixed
owner and agent windows within one client remain refused.

## Checks

Run one bounded command at a time:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/scoped_process_probe.py
bun run scripts/limited.ts bash experiments/ghost-cursor/plugin/build.sh /tmp/ghostinput-scoped-process.so
```

The probe compiles the actual `ScopedProcess`, `agentClient` and scoped pruning
definitions from the plugin source. It uses no desktop windows. It checks implicit
workspace refusal, lab compatibility, exact and foreign scope membership,
process exit, migration, refusal after pruning, and persistent revocation after
returning to the still-live original scope. Its two private scopes are stopped
independently, and cleanup failures fail the command.

The original source failed the workspace-only owner enrollment regression. The
intermediate source without sticky revocation failed the return-to-original-scope
regression. The final source passed both the policy and live scope checks.
Reports retain the compiled source SHA-256; raw logs remain private.

Plugin source tested:
`592f62e843466404365608419a7ca82ffa88cc8adf23be5c2fcbb55b45f0419e`.

The version-matched plugin built successfully and was loaded into a fresh private
compositor. The scoped GTK4 and Dolphin recording completed 20 native actions,
with 2.417976666 seconds of simultaneous activity. The simulated person's typing
continued and its pointer remained at the same position. Both application scopes
were cleaned up. The 45-frame recording preserved decoded pixels and durations;
its SHA-256 is `7e070607fd8a5224013da481be253fd9c5221a4291be2395534e391605c6e7a2`.
Both private labs used for this change were shut down after measurement.

The typecheck passed. The full bounded suite completed with 579 passes, 45 skips,
and four failures across 628 tests. Three failures explicitly reported insufficient
shared-budget capacity for browser creation. The crash-database process check
timed out; its cause is not established by that result. At the capacity failure,
the shared slice held 1533 tasks, including 1369 in the existing managed broker
service and 149 in the test scope. A read-only broker status query confirmed
other projects' sessions were running. They were left intact. This failed run is
retained privately and prevented publication at that point. After the owner
explicitly approved stopping five unrelated project sessions, the successor
pre-map revision passed the full suite. See [pre-map evidence](PRE-MAP-PLACEMENT.md)
for the exact revision and current checks. The earlier failure remains evidence;
no resource-limit increase or test exclusion was used to replace it.

## Limits and remaining acceptance

The launcher remains guarded for the private lab. Production launch transport,
universal helper-process enrollment, actual owner-session display/input acceptance,
and owner compositor load/unload state preservation remain incomplete. The
GTK/Qt recording exercises real native applications on a private compositor;
it does not prove operation on the person's active desktop. Existing cursor
pixel evidence is specific to its recorded source revision and is not inherited
by this ownership change.

The additional ownership checks add filesystem reads. Their whole-system cost
and any improvement over the old Orbit pipeline are not measured. The earlier
localized cursor redraw experiment did not establish a CPU improvement and
remains a historical patch for its recorded preimage, not an active optimization.
