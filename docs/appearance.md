# Appearance in a private display

A native session runs applications on a private compositor with private XDG base directories, so nothing an application restores on start, recent documents, a previous session, a logged-in account, comes from the person's own configuration. Left there, that also strips the person's theme, and every application in the agent's workspace looks like a stranger's machine: light where the desktop is dark, default icons, default fonts, the wrong cursor.

Orbit copies the appearance and nothing else. Applications in a session look the way they look on the desktop, while the boundary that keeps documents and credentials out stays where it was.

## What is carried over

| Kind | Source, relative to the person's configuration directory | How it reaches applications |
|---|---|---|
| GTK 3 and 4 theme, icon set, cursor, font, dark preference | `gtk-3.0/settings.ini`, `gtk-3.0/gtk.css`, `gtk-4.0/settings.ini`, `gtk-4.0/gtk.css` | Copied into the session's private configuration directory |
| File manager sidebar | `gtk-3.0/bookmarks` | Copied. These are folder names, not contents |
| Qt theme, style and colours | `qt6ct/qt6ct.conf`, `qt6ct/colors/`, `qt5ct/qt5ct.conf`, `qt5ct/colors/`, `qt5ct/qss/`, `Kvantum/` | Copied; `QT_QPA_PLATFORMTHEME=qt6ct` |
| KDE application colours, fonts and icons | `kdeglobals` | Filtered, see below; `QT_QPA_PLATFORMTHEME=kde` when the KDE platform theme plugin is installed |
| Cursor theme in the compositor | The GTK cursor settings | `seat seat0 xcursor_theme <name> <size>` in the compositor configuration, plus `XCURSOR_THEME` and `XCURSOR_SIZE` |
| Dark colour scheme for libadwaita | A dark GTK theme or `gtk-application-prefer-dark-theme` | `ADW_DEBUG_COLOR_SCHEME=prefer-dark`, because the settings portal that normally delivers it is not reachable from a private display |
| Icon sets, themes and colour schemes the person installed | `icons/`, `themes/`, `color-schemes/` under the data directory | A directory of links to those three, placed first on `XDG_DATA_DIRS` |
| Fonts the person installed | `fonts/` under the data directory, and the fontconfig cache | A fontconfig fragment naming both by their real path |

Everything else under the person's configuration and data directories stays out. In particular: desktop entries and MIME associations, so opening a link inside a session cannot start the person's own handlers; the recently used list and file manager metadata, which applications read only from the private data directory; caches, keyrings, browser profiles, and every application's own state.

`kdeglobals` is not copied as a file. It mixes appearance with file dialog state, the terminal command and, on some desktops, recent files and URLs. Only the `General`, `Icons`, `KDE`, `WM`, `Colors:*` and `ColorEffects:*` groups are re-emitted, and within `General` only colour and font keys.

## Why fonts are named by their real path

fontconfig keys its cache by directory. Linking the person's fonts under the session, or listing them through a link on `XDG_DATA_DIRS`, gives them a new path and therefore no cache, so every session would rescan every installed font. On the workstation this was built on that is 3,749 files and 2.4 GB, and the rescan held the compositor for 3.9 seconds on the shared one-core budget, long enough for the session to fail to start at all. A configuration fragment that names the real font directory and the real cache directory brings the compositor start back to 0.1 seconds with all 12,544 faces visible.

## What is measured

`ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/appearance-check.ts` opens a GTK 4 application, a GTK 3 one, a KDE one and, if installed, an Electron one on a private display and saves the frame. On this workstation Files, Text Editor and Dolphin all open dark, with the person's icon sets, colour scheme and fonts.

`bun test ./tests/appearance.test.ts` proves the property that matters: given a configuration directory seeded with decoys, a session document, a token file, a browser profile, a sibling inside a listed directory, a link at a listed path, a file deeper than the tree copy goes and one larger than a megabyte, exactly the appearance files arrive and nothing else. It also checks the `kdeglobals` filter, the cursor validation, the dark decision and the data directory links.

## Limits

An Electron application that reaches its backend over the session bus does not start in a private display, because the bus is deliberately unreachable there. Docker Desktop's launcher is one; the `Docker Desktop` binary underneath it did not map a window within thirty seconds on the software-rendered display either, and is not supported yet.

The settings portal is not reachable, so applications that read the colour scheme only from the portal and ignore both `settings.ini` and the libadwaita variable stay light. None of the applications tried did.

A theme file is observed content. The cursor name is validated before it reaches the compositor configuration, and no value from any copied file is placed in a command line.
