# Windows manual check

Written 30 October 2026. A short checklist for a real Windows desktop. Windows has the shared
broker, installer, per user autostart and resource budget only; there is no native control adapter
(see [Windows compatibility plan](windows-compatibility-plan.md) and [Windows evidence](windows-measured.md)).
This list checks what exists and records what does not. It claims nothing that was not observed.

Run it in PowerShell on a Windows 11 desktop with Bun installed. Record each result as pass, fail or
not run, with the date.

1. Install: `install.cmd`, then `sbar-orbit --version`. Expect the packaged version.
2. Doctor: `sbar-orbit doctor`. Expect it to run. Known defect: it lists capabilities that do not
   exist on Windows; note what it prints.
3. Broker: `sbar-orbit serve`, then `sbar-orbit status` from a second shell. Expect the broker to
   answer and the endpoint to be owner only (`icacls` on the endpoint path shows only your account).
4. Autostart: install the logon task, sign out and in, run `sbar-orbit status`. Expect the broker up.
5. Applications: `sbar-orbit` application discovery lists Notepad from App Paths metadata.
6. Refusals: opening an application or `native-plugin status` must fail with the plain unsupported
   message, not a stack trace. `panel` and `settings` must refuse the same way.
7. Update: run a managed update with a newer local package and confirm the pointer file moves.
8. Download: fetch the source tarball from the GitHub release in a browser, extract it, run `install.cmd` and record
   whether SmartScreen or Defender prompts at the download or at the run, with the Windows build and the file hash (see [Windows signing](windows-signing.md)).

Expected on Windows today: steps 1 to 7 pass or refuse plainly, step 8 is recorded; native open, input, capture and the
numbered workspace are not implemented and must not be reported as working.
