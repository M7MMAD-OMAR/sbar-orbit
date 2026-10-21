# Native handoff release hold

**Status, 21 October 2026:** owner handoff remains held. The nested lab success in [owner-handoff-release.json](../experiments/ghost-cursor/owner-handoff-release.json) is retained as historical evidence, but cannot release live owner input. The TypeScript and Python gates additionally require an `ownerAcceptance` record with `state: "passed"` and measured `inputDelivered`, `selectionIsolated`, `ownerFocusPreserved`, `ownerPointerPreserved` and `handbackVerified` values of `true`. The committed evidence has no such acceptance. A live owner claim with a throwaway fixture is partly traced below; agent input did not reach the fixture on the live session.

The owner compositor crashed during an existing Chrome window claim on 6 October 2026 at 3:40 AM, Asia/Dubai. Opening the requested account on workspace 4 had succeeded. The pointer demonstration did not run.

The core trace identifies `CExtDataDeviceProtocol::dataDeviceForClient` called by the Orbit claim handler. The pinned upstream lookup dereferences each device without checking for an empty entry. This establishes the failing lookup, but does not by itself establish why the device entry was invalid. An ABI or lifetime defect remains to be ruled out.

The candidate now checks every WLR and ext device and client, rejects incomplete inventories, and checks mandatory seat and selection protocols before lease insertion. Owner handoff, borrowed input, borrowed resume, and owner plugin load or admission resume remain disabled before host access. Status, pause, handback and unload remain available for recovery. There is no runtime override for this release hold.

The old private compositor harness and browser probes were removed. Historical
results below describe the previous source only. They do not authorize loading
the changed plugin. Releasing the hold requires a reviewed method of regression
on a separate non-production host, application-state proof of input, selection
isolation, visible cursor behavior, focus preservation and exact cleanup.

| Evidence | Current result |
| --- | --- |
| Real Chrome opening on workspace 4 | Observed before the incident |
| Owner compositor crash during claim | Confirmed by core trace |
| Cause of invalid device entry | Not measured. The corrected plugin no longer calls the upstream lookup that dereferenced it |
| New device inventory guard | Synthetic old-source failure and corrected-source pass measured in [run 37403797681](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797681). Actual compositor ABI safety and owner claim remain not measured; the release hold remains active. |
| New release gate tests | Pure refusal fixtures measured in [run 37409928412](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412): `native-handoff-release.test.ts` checks refusal before worker creation and before owner plugin load or resume spawning; its Linux wrapper runs `native_handoff_release_test.py` for direct claim, input, existing lease resume and plugin mutation refusal before initialization. This does not measure real compositor safety or a completed owner claim; the release hold remains active. |
| Old crash reproduced | Nested lab, 18 October 2026: the 2116c4b source ended the lab Hyprland with SIGSEGV in `CExtDataDeviceProtocol::dataDeviceForClient` during a real Chrome claim with clipboard watchers present |
| Corrected Chrome claim and visible cursor | Nested lab, 18 October 2026: claimed; agent cursor, click and typing reached Chrome while a person window kept focus and the pointer stayed put; handback left Chrome and the compositor running (historical probes removed, retained in Git history). Host nested lab, not a separate machine |
| Selection isolation | Not measured |
| Live owner compositor claim | Partly traced, 18 October 2026, owner authorized: a throwaway GTK fixture was opened silently on workspace 9 of the owner's Hyprland 0.56.2 (Lua configuration) and claimed with the evidenced plugin. Reported by the session, not retained: seven runs loaded and unloaded the plugin without a compositor crash; the claim, cursor, move, click, typing and handback commands each returned success; the active window read before each run matched the reading after typing. Traced in private run directories in the owner's cache: five runs; four fixture states show empty text and nothing saved and one run has none; of two Wayland event logs, one is empty and the other shows no keyboard or pointer event during the claim, its only keyboard and pointer enter arriving about two hours later during cleanup. Agent input was therefore not delivered to the fixture on the live session, although the plugin reported success; the cause is not measured and live input diagnosis was stopped. A nested lab run of the same fixture receiving and saving typed text was reported by the session and not retained |
| Live probe cleanup | Failed once: the probe closed its fixture with the classic dispatch syntax, which a Lua configuration refuses, so the last fixture stayed open on workspace 9 until about 7:19 AM. Checked at about 6 PM the same day: no fixture process or workspace 9 window remained |
| Original owner opening on a Lua configuration | Measured locally on 22 October 2026. See [the application report](native-opening.md). This does not establish input delivery |
| Remote regression and cleanup | Not measured |

Raw crash dumps and owner logs are private diagnostic data and must not be uploaded as public CI artifacts.
