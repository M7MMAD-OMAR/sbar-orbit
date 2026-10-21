# Executed original application opening

On 22 October 2026, 20 installed native applications were attempted on the actual
Fedora 44, Hyprland 0.56.2, Wayland, x86_64 workstation. These were original installed
applications with their normal owner environment, on numbered host workspace 2.
No browser, private display, copied profile or substitute application was used.

Initially 15 opened with verified floating geometry at 960 by 640 logical pixels
and were closed by exact PID, address and stable window identity. Five attempts
failed. Investigation identified unsupported native entry scripts and a local
rendering environment wrapper in four registrations. After the resolver change,
all four were opened again through the same real application path, measured at
960 by 640, and closed. **19 of 20 original opening attempts are now measured.**
Maps remains failed: a launch receipt was retained, but no launch-bound window was
acknowledged within the deadline. A later exact receipt-ancestry check found no
matching window to close. No unrelated existing window was closed.

| Application | Latest opening | Cleanup | Repaired after real failure |
| --- | --- | --- | --- |
| Calculator | measured | closed | no |
| Text Editor | measured | closed | no |
| Characters | measured | closed | yes |
| Clocks | measured | closed | no |
| Calendar | measured | closed | no |
| Fonts | measured | closed | no |
| Image Viewer (Loupe) | measured | closed | yes |
| File Roller | measured | closed | no |
| Files (Nautilus) | measured | closed | no |
| Disk Usage Analyzer | measured | closed | no |
| Document Viewer (Papers) | measured | closed | no |
| Audio Player (Decibels) | measured | closed | yes |
| Video Player (Showtime) | measured | closed | yes |
| Maps | failed | no acknowledged window | no |
| Contacts | measured | closed | no |
| Document Scanner | measured | closed | no |
| Inkscape | measured | closed | no |
| Volume Control | measured | closed | no |
| Blender | measured | closed | no |
| Ark | measured | closed | no |

The [machine-readable record](native-opening-results.json) retains both rounds,
including failures. The initial source was commit `189c377`. The repair round ran
that base with the recorded `application-launch.ts` digest, before its commit.
The initial harness invoked `NativeBackend.openApplication` after exact one-use
protected approval. A further round opened Characters, Decibels, Showtime and Loupe
through public `native.open` RPC on the restarted managed broker after admission
repairs. All four returned measured 960 by 640 floating windows on workspace 2,
retained the same active window/workspace before and after, and were closed by
exact identity. The broker source digest is recorded separately. MCP tool delivery
and input/capture are not certified by this RPC round.

The active window and workspace were equal at the end of all four repair attempts.
Some initial before/after identities differed. Owner activity was concurrent, so
this is not causal proof that Orbit stole or preserved focus. Continuous focus
and pointer preservation remain not measured.

No editing, clicking, typing, screenshot, account state or signed-in continuity was
measured. The input/capture hold remains active. These results do not establish
complete application compatibility or support for another desktop environment.

## Reproduce the public opening route

After the [native preparation and exact protected approval](cli.md) are configured:

```sh
sbar-orbit applications Calculator
sbar-orbit native-open '{"workspace":2,"applicationId":"org.gnome.Calculator.desktop","window":{"width":960,"height":640}}'
```

Inspect the returned launch-bound identity and actual geometry. Ordinary opening
leaves the application open. Test operators must close only their exact newly
opened windows, preserving any unsaved-content prompt. A successful command alone
is not proof of input delivery. Missing acknowledgement must remain uncertain,
not become a blind retry or closure of another window.
