# Roadmap

## Demonstrated in the alpha

- Local broker, CLI and MCP contract.
- Followed browser tabs, so site-opened login and consent windows are reachable.
- Owned browser sessions and optional viewer.
- Fedora native Wayland/Xwayland capture and input.
- Unicode paste, account snapshots and cooperative file reservations.
- Process cleanup and a scripted 10-minute browser/viewer run.
- A session from the person's own browser profile, by clone, decrypted through a secret service that
  holds exactly one item.
- An origin lease held in two places: request interception inside the browser, and a network namespace
  below it whose only route out is a proxy the browser cannot go around.
- Autonomy without a checkpoint: a policy fixed at creation that only ever tightens, an advisor that
  fails closed, an immune set nothing clears, a durable journal, and restore points with a refusal set.
- One command installation on this host class: `./install.sh` checks prerequisites, prepares
  dependencies, links the command, installs and starts the service, writes connector configuration and
  verifies that the broker answers, printing a remedy for every item only a package manager can supply.
  It reports installation state and says in its own closing line that this is not a measurement.

## Next acceptance gates

1. Resolve the participant-reported CPU problem before another interactive trial. Names/pointer visibility were confirmed; takeover and resource acceptance were not. Two measured causes are now fixed: the viewer scheduled its next poll with no delay once an iteration outlasted its cadence, and PNG deflate dominated capture on both backends. The viewer now reports its own per-frame cost, because it runs outside Orbit's cgroup and the CPU sampler cannot see it. A participant-read cost figure is still required; neither fix is confirmed to be what the participant felt.
   Seen again on 12 September 2026, and already explained rather than new: a full suite run alongside
   two other bounded commands failed `tests/preview.test.ts` on its 30 second wait for a fresher frame,
   and the same file passed in 8 seconds when run alone. That is the contention effect
   [validation.md](validation.md) already records, one shared cgroup budget split between concurrent
   runs, which is why gate runs are taken one bounded command at a time. It says nothing about the
   participant's own cost, which still has to be read on their machine.
2. Broaden failure and native application/account coverage. Three repeated recovery runs pass.
   Independent supervisor death is now covered rather than open: a supervisor killed outright runs
   none of its own reaping, so its application survived it and outlived the runtime directory it was
   given. The backend now records the process group each supervisor leads, sweeps it when a supervisor
   exits and again when a session closes, and signals nothing whose private runtime directory does not
   name this session. Five checks in `tests/owned-group.test.ts` and one end to end native check cover
   it, and the end to end check was run first against the unfixed code, where it failed. Still open in
   this gate: account coverage, and applications beyond the four launched so far.
3. Verify full local installation on a fresh machine, including native dependencies. Launcher activation, upgrade, rollback and link-only uninstall pass filesystem tests without touching workspaces or accounts.
4. Repeat browser and native adapter gates on actual macOS and Windows hosts.
5. Publish capabilities from evidence; unsupported closed tools remain explicit. The tier table,
   the local `doctor --report` and the issue forms now exist; what they need is a host this project
   does not have. See [support tiers](support-tiers.md).
6. The browser extension that mints scoped state for a separate Orbit browser. Now written, in
   `extension/`, and not loaded, not run and not verified. Its pure decision path is unit tested:
   origin scoping, grant expiry, the request and response envelope, the refusal codes and the native
   messaging framing. Its three gates, G12 to G14, stay open and cannot be closed here: each needs the
   extension loaded in a real browser, and this project's rules keep agents out of the person's own
   browser entirely. Whether `chrome.cookies.getAll` returns `HttpOnly` cookies, whether partition keys
   survive, whether a stopped service worker has a clean wake path and how long a native port keeps it
   alive are all still `not measured`.

Use [acceptance cases](acceptance.md) as release criteria. Alpha versions do not imply these gates are complete.
