# Acceptance evidence procedure

The [prepared ledger](acceptance-evidence.json) maps all twelve user stories,
eight failure cases, six selected-file scenarios, three account contracts, five
host contracts and the matched performance gate. Its 35 rows describe required
evidence. Every row remains `not measured` or `blocked`. Supporting test names
and historical documents are pointers, not new measurements.

This procedure prepares a reviewable external trial. It neither starts a viewer
nor accesses a person's browser, screen, pointer, windows, profiles or accounts.
The participant controls any interaction on their device. Agents work only in
owned disposable Orbit surfaces, configuration roots and scratch files. Native
execution stays blocked by [the incident contract](native-handoff-incident.md).
Do not run, revise or delegate the rejected native preparation or prototypes.
The existing interactive viewer cost hold in [validation.md](validation.md)
also needs resolution before a participant viewer trial.

## Prepare without involving the participant

1. Pin the runtime Git identity, complete tested file manifest and its SHA-256,
   installed artifact version/digest, browser identity and OS/device class. A
   checkout measurement cannot establish published-release acceptance. Record
   actual commands and environment limits without credentials or personal paths.
2. Verify disposable loopback contracts for navigation, input, read, image,
   pause, stop, independent sessions, failure recovery, upload and cooperative
   file/account leases. Retain full failed attempts as well as successful ones.
   Run shared-budget checks only under the coordinator's explicit test lease.
3. Use `experiments/host-action-acceptance.py` for installed Codex and Claude,
   API and CLI paths. Its deterministic providers measure tool transport. Codex
   native client image receipt does not establish model image forwarding.
   Hermes needs an owner-provisioned dependency environment before real action
   validation; neither a direct import nor another interpreter supplies it.
4. Prepare a local form with distinct A/B markers, scratch selected and decoy
   files, an optional explicitly chosen test account and a viewer link that is
   never opened automatically. Do not collect real page text, account snapshots,
   cookie/token values, private titles or keystrokes as evidence.
5. Confirm the external trial can record anonymous focus attribution, owned
   process creation identities, event coverage and polling gaps. A participant
   runs or supervises device telemetry; agents do not inspect personal windows.
   If the required event coverage is unavailable, U1/U8 stay unmeasured.

## Participant-controlled browser trial

Arrange one agreed ten-minute trial on a participant-controlled test device.
Record a random run ID and source digest, not the participant's name. The
participant can stop at any point; interruption is retained as incomplete
evidence. They choose ordinary concurrent work and report whether it was
interrupted. Orbit runs two fresh private sessions, completes at least 100
actions each and retains their distinct form/storage outcomes. This covers the
browser portions of U1/U2; it does not imply native desktop safety.

After the viewer cost hold is resolved, the participant opens the supplied
viewer link when they choose, reads its own `#cost` line, pauses the agent and
enters a disposable phrase. Runtime receipts must show the pause acknowledgement,
refusal of new agent input and serialized manual/agent operations. The participant
resumes, closes the viewer and confirms work continues. Collect frame timestamps
for the strict age below 1000 ms at 5 FPS gate, plus the resumed action witness.
A scripted phrase is explicitly automated evidence and cannot become a human
takeover result.

Stop A, record its pre-stop owned process identities and exit times within
5000 ms, then submit again through B. The participant reports their concurrent
apps remain usable. No agent checks personal processes or windows to obtain that
confirmation. Absence of captured owned descendants is missing evidence.

For U6, the participant explicitly chooses a disposable service/account and
signs in only within Orbit's fresh profile. Save account state, stop and restart
through the claimed installed mechanism, check an agreed authenticated boolean
marker and refuse a competing account lease. Retain only booleans, counts,
timings, service scope and snapshot permission metadata. The participant reports
their existing login still usable. No personal browser clone is part of this
procedure. Session storage, passkeys, device-bound tokens, token refresh and
arbitrary provider continuity remain outside an unmeasured service result.

For U11, use scratch selected and sibling files. Record exact byte hashes and
versions before/after, application identity, actual save operation and conflict
outcome. Browser upload delivery proves a byte snapshot, not application write
or atomic save. Cooperative leases do not constrain another same-user editor.
The native save and external conflict rows remain blocked. The exact-file bridge
does not promise atomic rename or source-path replacement tracking.

Repeat applicable U1-U11 portions on external macOS and Windows devices for U12.
Record explicit unsupported or refused operations with their environment limit;
do not count skips as passes. The native release hold remains in force on every
host. A disposable CI runner supplies only its actually executed scope.

## Receipt format and integrity checks

Keep each receipt and its artifacts in an owned evidence directory outside the
repository source scope. No secret-bearing logs or real account captures belong
there. A `not measured` receipt may contain only this honest prerequisite:

```json
{
  "schemaVersion": 1,
  "gate": "H-hermes",
  "state": "not measured",
  "limit": "Actual host actions have not run",
  "reason": "Owner-provisioned Hermes dependency environment is absent"
}
```

For a measured attempt use these fields:

| Field | Required content |
| --- | --- |
| `schemaVersion`, `gate`, `runId` | Version 1, exact ledger ID, random trial identity |
| `state`, `tier`, `limit` | Actual passed/failed/refused claim, Limited or Measured evidence tier, explicit environment/capability limit |
| `source` | `gitHead`, `files` map of relative paths to SHA-256 values, `sha256` of Python `json.dumps(files, sort_keys=True).encode()` |
| `environment` | `os`, `architecture`, `deviceClass`, `installation` artifact identity, `runtimeVersion` |
| `artifacts` | Nonempty list of `{id, kind, path, sha256}`; kind is runtime, participant or review; paths remain inside the trusted owned receipt directory with no symlink components; each artifact at most 4 MiB and at most 128 artifacts |
| `observations` | For a passed claim, exactly the ledger's required observation names; each has `{value, artifact}` pointing to a retained witness |
| `participant` | When required, `{recordedBy, runId, sourceSha256, artifact}` with `recordedBy: participant`, matching run/source and a participant artifact |
| `reason` | Observed failure/refusal or external prerequisite; never infer success from an absent result |

Runtime artifacts retain JSON with `gate`, `runId`, `sourceSha256`, `gitHead`,
`environment` matching the outer receipt, plus an `observations` map of names to
values. Participant artifacts retain the same gate/run/source/Git identity and
`recordedBy: participant`, plus the complete claimed observation values. Each
passed observation references a runtime or participant artifact containing the
same name and value. A review artifact cannot witness an observation. The helper
rejects mismatched retained bindings even if artifact hashes are recomputed.
These are declared bindings; they do not authenticate an execution or person.
Use a trusted owned receipt root. The helper pins directory descriptors, refuses
symlinks and nonregular files, bounds reads, and checks the opened file identity
and metadata before/after reading. It does not create a hostile filesystem trust
boundary or prove source-manifest completeness.

The participant creates their own receipt or supplies it through a separately
controlled collection channel. They attest to the run ID/source, uninterrupted
work, viewer cost reading, manual takeover, other-app usability and any explicitly
tested account/file behavior. An agent never authors this confirmation. The
validator checks the declared origin and retained artifact integrity; it cannot
authenticate a person. Independent review must verify the collection origin
and actual observations before the coordinator accepts a gate.

```sh
python3 experiments/acceptance-evidence.py docs/acceptance-evidence.json
python3 experiments/acceptance-evidence.py docs/acceptance-evidence.json --receipt /var/tmp/owned-trial/receipt.json --source-sha256 TESTED_RUNTIME_DIGEST
python3 experiments/acceptance-evidence.test.py -v
python3 experiments/host-action-acceptance-compare.test.py -v
```

These commands start no host client, broker, browser or native display. A valid
receipt reports `receiptIntegrity: valid` and always `acceptance: open`.
Integrity validation does not judge assertion truth, performance thresholds,
participant identity, source-manifest completeness or release readiness. A
failure receipt may legitimately lack later observations; it retains its actual
reason and runtime witness. The native held rows refuse all execution claims.

## External prerequisites after preparation

- Coordinator-controlled exclusive slots for fresh host actions on the final
  source, plus exact published artifact/provider scope for external U7.
- Owner-provisioned Hermes dependencies and a separately authorized configured
  provider environment capable of authentic Codex model-image receipts. Do not
  repair another agent repository or change configured models for a test.
- A consenting participant and appropriate external device classes, with the
  viewer cost hold resolved before interactive viewing and participant-controlled
  anonymous telemetry available.
- Explicitly selected disposable account/service and scratch file/application
  cases, with the documented authentication/save limitations preserved.
- External resolution of the native preparation rejection before any separately
  reviewed disposable native environment. No alternate route or runtime override.

The coordinator reviews source-bound runtime receipts, participant-origin
evidence and independent findings, then updates acceptance status. Historical
documentary evidence without retained artifacts remains historical. A prepared
schema or completed fixture never substitutes for the missing external trial.
