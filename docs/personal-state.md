# Working beside the person with their applications

The acceptance target is an agent working on a private display with its own pointer and windows, using the person's installed applications, accounts, files and settings. When an application supports collaboration on a shared file or service, both people should see the same underlying work. The agent must not move or control the person's windows.

This is an application compatibility target, not a single switch. A private Wayland display cannot take ownership of a window that is already connected to the person's compositor. Sharing the person's D-Bus session can redirect a new application launch into the process on their desktop. Orbit therefore needs a separate application instance and a measured path to the same account or document for each application family.

## Evidence on this workstation

| Capability | Current result | Limit |
|---|---|---|
| Installed native applications | 19 applications launched and mapped in the private display | First window only for 15 of them; account state was not tested |
| Files | GNOME Text Editor in a private Orbit session saved Arabic text to a host file on 28 September 2026 | Concurrent editing behavior depends on the application and file format |
| VS Code on a shared file | The installed `/usr/share/code/code` opened a disposable host file in Orbit's private display. An Orbit edit was saved and read from the host; a host append then appeared in the open editor | One text file, two sequential editors, not simultaneous conflict resolution |
| VS Code settings and one extension | A copy of `Code/User/settings.json` and Material Icon Theme loaded in a separate VS Code data and extensions directory. `files.autoSave: afterDelay` saved an Orbit edit without Ctrl+S. The source settings hash stayed unchanged | Manual snapshot of settings and one extension; VS Code still showed a sign-in prompt |
| VS Code profile action | `launch-app` copied Default Profile settings, a consistent account database and selected extensions into Orbit's private session. The account menu showed the same GitHub identity on 28 September 2026 | Four selected extensions and 256 MiB total snapshot limit; GitHub identity was verified, Copilot service access and concurrent host VS Code use were not |
| GSettings preferences | A controlled preference reached a private GTK application, with the source database unchanged | One schema on one Fedora host; changes after session creation are not synchronized |
| Private application bus | A GTK application wrote to its own dconf database on a bus that activates dconf only. VS Code gets a separate proxy for the host secret service | The proxy exposes the full secret service collection to VS Code, not only its own key |
| Browser profile | A Chrome profile copy started on 28 September 2026 with bounded network origins | npmjs.com presented a challenge page and GitHub showed its signed-out page, so these runs did not measure login continuity; earlier account evidence covers one service |
| Native application accounts | VS Code's copied account database and the unlocked host keyring restored its GitHub identity in a private window | Other applications remain not measured; a keyring relock during the session was not tested |
| Flatpak applications | Not measured for personal state | Flatpak uses application specific directories and portals |

## Acceptance for each application

1. Open the installed application version on Orbit's private display without opening or focusing a window on the person's desktop.
2. Match the person's relevant preferences and authenticated identity in a separate instance.
3. Read and write the intended shared file or service, then confirm the other instance sees the change in the way that application supports.
4. Restart the Orbit instance and confirm the expected account and work persist.
5. Verify that stopping Orbit does not terminate the person's application or alter its local profile unexpectedly.
6. Measure processor, memory and startup cost inside Orbit's shared resource budget.

Chrome, Claude Desktop, Codex, Nextcloud Desktop, Proton Pass and VS Code are initial application pilots. Their login stores, single instance behavior and packaging differ. VS Code has one measured GitHub identity result; a full coexistence result still needs a simultaneous host instance and service operation. The other application login paths remain `not measured` until their own account and coexistence tests pass. Nextcloud requires a network blocked startup test before any second sync client is allowed to run.

The VS Code pilot used the application's [documented `--user-data-dir` and `--extensions-dir` flags](https://code.visualstudio.com/docs/configure/command-line) with `/usr/share/code/code`, not the launcher that detaches from Orbit's process group. The copied settings file was 3,892 bytes and its SHA-256 was `a4a551405dc8b438880c2dbfb345b04ecae325ad7e38e9533692a43b85a2524a` before and after the run. The private display's Extensions view listed Material Icon Theme as installed. The fresh application data still opened with a sign-in prompt. [VS Code's Settings Sync documentation](https://code.visualstudio.com/docs/configure/settings-sync) describes OS credential storage on Linux, so copying settings and extension files is not evidence of account continuity.

The later `launch-app` integration test returned `profileSnapshot: { settings: "copied", extensions: ["pkief.material-icon-theme-5.38.1"] }`, mapped one VS Code window on the private display, and wrote Arabic text to a shared disposable file through the copied `files.autoSave` preference. The Extensions view showed Material Icon Theme installed. The private runtime directory and application process disappeared after `session stop`. The source settings changed at 3:33 AM, before this test began at 3:35 AM. A controlled second launch began and ended with the same source SHA-256, `98c493ecd5c0c908ccb8c0dea8a66cb2c34487c7d102457eab9990a0410a986b`. This is evidence that the controlled run did not write the source file; it does not attribute the earlier change.

The account test exposed another VS Code path outside `--user-data-dir`: `~/.vscode-shared/sharedStorage/state.vscdb`. A full profile pilot without `--shared-data-dir` used that host database and changed its modification time. The corrected `launch-app` passes a private `--shared-data-dir`; its log named the private database, and the host database's modification time stayed at 4:00:50 AM through the corrected run. The account database `Code/User/globalStorage/state.vscdb` is copied with SQLite's online backup API, including uncheckpointed WAL data. The private VS Code process reaches only `org.freedesktop.secrets` through `xdg-dbus-proxy`, after a metadata check finds the `Code` key unlocked. The account menu in the private window showed the person's GitHub identity. After `session stop`, the proxy process and runtime directory were gone. This proves the GitHub identity in this VS Code build and host state; it does not prove Copilot API access, other sign-ins, or future token refresh.

The filtered proxy limits D-Bus service names, not keyring items. VS Code can enumerate the host keyring collection through that service while its private session runs. A synthetic one-item service worked for a simple libsecret lookup but VS Code crashed before reading a secret from it, so that narrower path is not claimed. The preflight refuses a missing or locked `Code` item before launch; a relock after launch remains unmeasured.

The implementation path is a private display and private application process, selective snapshots of settings and local state, a restricted private application bus, and application specific credential access. The display, dconf snapshot, restricted bus and VS Code GitHub identity route now exist; other app state and credential paths remain open. Files remain the person's real files under their normal user permissions. A whole home directory copy is unsuitable here: the current config directory is 31 GB and the data directory is 146 GB. Copying them also risks duplicating live databases and lock files.
