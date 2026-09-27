# Working beside the person with their applications

The acceptance target is an agent working on a private display with its own pointer and windows, using the person's installed applications, accounts, files and settings. When an application supports collaboration on a shared file or service, both people should see the same underlying work. The agent must not move or control the person's windows.

This is an application compatibility target, not a single switch. A private Wayland display cannot take ownership of a window that is already connected to the person's compositor. Sharing the person's D-Bus session can redirect a new application launch into the process on their desktop. Orbit therefore needs a separate application instance and a measured path to the same account or document for each application family.

## Evidence on this workstation

| Capability | Current result | Limit |
|---|---|---|
| Installed native applications | 19 applications launched and mapped in the private display | First window only for 15 of them; account state was not tested |
| Files | GNOME Text Editor in a private Orbit session saved Arabic text to a host file on 28 September 2026 | Concurrent editing behavior depends on the application and file format |
| GSettings preferences | A controlled preference reached a private GTK application, with the source database unchanged | One schema on one Fedora host; changes after session creation are not synchronized |
| Private application bus | A GTK application wrote to its own dconf database on a bus that activates dconf only | Other services and native account credentials are not available through this bus |
| Browser profile | A Chrome profile copy started on 28 September 2026 with bounded network origins | npmjs.com presented a challenge page, so this run did not measure login continuity; earlier account evidence covers one service |
| Native application accounts | Not measured | Private XDG state and the disconnected session bus omit most application login state |
| Flatpak applications | Not measured for personal state | Flatpak uses application specific directories and portals |

## Acceptance for each application

1. Open the installed application version on Orbit's private display without opening or focusing a window on the person's desktop.
2. Match the person's relevant preferences and authenticated identity in a separate instance.
3. Read and write the intended shared file or service, then confirm the other instance sees the change in the way that application supports.
4. Restart the Orbit instance and confirm the expected account and work persist.
5. Verify that stopping Orbit does not terminate the person's application or alter its local profile unexpectedly.
6. Measure processor, memory and startup cost inside Orbit's shared resource budget.

Chrome, Claude Desktop, Codex, Nextcloud Desktop, Proton Pass and VS Code are initial application pilots. Their login stores, single instance behavior and packaging differ. The support tier for each stays `not measured` until its own account and coexistence test passes. Nextcloud requires a network blocked startup test before any second sync client is allowed to run.

The implementation path is a private display and private application process, selective snapshots of settings and local state, a restricted private application bus, and narrow credential access where the application's login requires it. The display, dconf snapshot and restricted bus now exist; app specific state and credential paths remain open. Files remain the person's real files under their normal user permissions. A whole home directory copy is unsuitable here: the current config directory is 31 GB and the data directory is 146 GB. Copying them also risks duplicating live databases and lock files.
