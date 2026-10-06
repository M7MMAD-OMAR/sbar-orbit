# Native handoff release hold

The owner compositor crashed during an existing Chrome window claim on 6 October 2026 at 3:40 AM, Asia/Dubai. Opening the requested account on workspace 4 had succeeded. The pointer demonstration did not run.

The core trace identifies `CExtDataDeviceProtocol::dataDeviceForClient` called by the Orbit claim handler. The pinned upstream lookup dereferences each device without checking for an empty entry. This establishes the failing lookup, but does not by itself establish why the device entry was invalid. An ABI or lifetime defect remains to be ruled out.

The candidate now checks every WLR and ext device and client, rejects incomplete inventories, and checks mandatory seat and selection protocols before lease insertion. Owner handoff, borrowed input, borrowed resume, and owner plugin load or admission resume remain disabled before host access. Status, pause, handback and unload remain available for recovery. There is no runtime override for this release hold.

The private compositor path remains available for verification on a separate machine. Releasing the hold requires a pinned Fedora compositor regression: broken source fails, corrected source passes, absent clipboard protocols and a real Chrome client are exercised, and cursor, selection isolation, owner focus preservation and cleanup are measured. A synthetic null-entry test is supporting evidence only.

| Evidence | Current result |
| --- | --- |
| Real Chrome opening on workspace 4 | Observed before the incident |
| Owner compositor crash during claim | Confirmed by core trace |
| Cause of invalid device entry | Not measured |
| New device inventory guard | Synthetic old-source failure and corrected-source pass measured in [run 37403797681](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37403797681). Actual compositor ABI safety and owner claim remain not measured; the release hold remains active. |
| New release gate tests | Pure refusal fixtures measured in [run 37409928412](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37409928412): `native-handoff-release.test.ts` checks refusal before worker creation and before owner plugin load or resume spawning; its Linux wrapper runs `native_handoff_release_test.py` for direct claim, input, existing lease resume and plugin mutation refusal before initialization. This does not measure real compositor safety or a completed owner claim; the release hold remains active. |
| Corrected Chrome claim and visible cursor | Not measured |
| Remote regression and cleanup | Not measured |

Raw crash dumps and owner logs are private diagnostic data and must not be uploaded as public CI artifacts.
