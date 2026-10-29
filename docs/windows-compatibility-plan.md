# Windows compatibility plan for the next release

Written 29 October 2026. Scope: what exists for Windows, what Windows allows, the order of work, and
what the next release notes can claim. Claims are either backed by a file in this repository, a
GitHub runner run linked below, or a Microsoft source, or they are marked `unmeasured` or `unsourced`.
No Windows desktop session was available to this work, so nothing here was observed on a person's
Windows desktop. See [support tiers](support-tiers.md) and [Windows evidence](windows-measured.md).

## 1. What exists today

Windows has the shared TypeScript layers and infrastructure, and no native control adapter.

| Piece | State | Where |
| --- | --- | --- |
| Launcher, installer | `bin/sbar-orbit.cmd`, `install.cmd`, delegating to `scripts/install.ts` | `bin/`, `install.cmd` |
| Broker and MCP adapter | Platform independent Bun code | `src/ipc.ts`, `src/mcp.ts`, `src/session-mcp.ts` |
| Broker endpoint protection | DACL rewrite and check through icacls | `src/socket-acl.ts` |
| Autostart | Per user logon scheduled task, not a service (session 0 cannot host the UI) | `src/windows-autostart.ts` |
| Resource budget | Named job object | `src/windows-job.ts`, `scripts/limited.ts` |
| Update flow | Pointer file instead of symlink, win32 branches | `src/update.ts`, `src/managed-lifecycle.ts` |
| Application discovery | App Paths metadata | `src/application-discovery.ts` |
| Native availability | Refuses any platform but Linux | `src/native-availability.ts` |

### Per feature of the current round

| Feature | Windows today | Reason and file |
| --- | --- | --- |
| `orbit_act` batching (`actions`) | Partly | The orchestration is TypeScript (`src/session.ts` `batch`) and platform independent; it dispatches to a native backend that does not exist on Windows. No action can run. |
| Settled `capture` | Not at all | Implemented in `src/native/session.py` over the Hyprland plugin. No Windows capture code. |
| Text observation (`observe` format text or both) | Not at all | AT-SPI in `src/native/a11y*.py`. No UI Automation code exists. |
| Curved cursor, hover, press, hold, drag | Not at all | The Hyprland plugin `experiments/ghost-cursor/plugin/ghostinput.cpp`. |
| Panel controls, About, Settings | Not at all | GTK4 Python in `desktop/panel*.py`; `bin/sbar-orbit.cmd` refuses `panel` and `settings`; `src/desktop-settings.ts` and `src/native-settings.ts` throw on non Linux. |
| Forwarded window placement | Not at all | `src/native/window_placement.py`, Hyprland specific. |
| Clipboard paste for untypeable text | Not at all | `src/native/paste.py`, Wayland data control. |
| Update flow | Contract tested, not run live | `tests/update.test.ts` passes on a Windows runner (see section 5). A real managed update on a real Windows desktop is `unmeasured`. |
| Install, launcher, autostart, broker | Source contracts and a broker smoke run on a runner | Section 5. Not a person's desktop. |

A defect found while inventorying: `doctor` reports the full capability list (`windows`, `click`,
`observe` and others) without regard to platform (`src/session.ts`, near the `doctor` method). On
Windows that advertises capabilities that do not exist. Fix belongs in `src/session.ts`, which another
session is editing; it is listed in section 6.

## 2. What Windows allows

Sources are Microsoft Learn unless noted. The research notes with every URL are kept in the shared
notes folder (`windows-research.md`); items the research could not source are marked `unsourced`.

### Focus, integrity and enumeration
- `IsWindowVisible` still returns true for windows on other virtual desktops; they are cloaked, so
  enumeration must also read `DWMWA_CLOAKED` ([Old New Thing, 2020-03-02](https://devblogs.microsoft.com/oldnewthing/20200302-00/?p=103507), [DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)).
- `SendInput` is subject to UIPI: input goes only to windows at an equal or lower integrity level, and a
  blocked call reports no UIPI cause ([SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)).
  An elevated application window cannot be driven by Orbit at normal integrity. UIAccess needs a signed
  binary in a secure location and an administrator launch ([UI Automation security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- `SetForegroundWindow` has restrictions and may only flash the taskbar
  ([documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)).
  The design rule is therefore the same as the project rule: agent actions never call it.

### Input
- `SendInput` inserts into the global input stream. `KEYEVENTF_UNICODE` and scancode events reach the
  foreground thread ([KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)),
  so keyboard input through it needs focus. Absolute mouse coordinates are normalised to 0..65535 and map
  to the primary monitor unless `MOUSEEVENTF_VIRTUALDESK` is set ([MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)).
  The cursor is documented as a shared resource ([SetCursorPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcursorpos)).
- No documented API was found that delivers a real pointer click to another process's window without
  moving the system cursor and without activating it. That is a negative finding based on absence, so it
  is `unproven` until tested, but the plan assumes it.
- Window messages (`PostMessage`) and UI Automation patterns do not pass through the input stream, so
  they are the candidates for background action. Whether `InvokePattern`, `SetValue` or touch and pen
  injection move the cursor or change focus is `unsourced`; each needs a measurement on a real desktop.
  `SetFocus` on an automation element sets keyboard focus ([IUIAutomationElement::SetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-setfocus)).

### Capture
- Windows.Graphics.Capture can be created for a window through `IGraphicsCaptureItemInterop::CreateForWindow`,
  minimum Windows 10 1903 ([documentation](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)).
  The system draws a yellow border around the captured item ([screen capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)).
  Removing it needs user consent and a package capability, Windows 10 2104 or later
  ([IsBorderRequired](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)).
  Cursor capture can be switched off from 2004 ([IsCursorCaptureEnabled](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.iscursorcaptureenabled)).
  That an occluded or minimised window is captured is only a third party claim; `unmeasured`.
- `PrintWindow` documents only `PW_CLIENTONLY`; `PW_RENDERFULLCONTENT` appears in WebRTC source and
  community answers, not on Learn ([PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)).
- Origin mismatch, the same class we met on Firefox: `GetWindowRect` includes invisible resize borders and
  is DPI virtualised for unaware callers, while `DWMWA_EXTENDED_FRAME_BOUNDS` is the visible rectangle and is
  not DPI adjusted ([GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)).
  UI Automation coordinates are physical and a non DPI aware client gets wrong values at non 96 DPI
  ([screen scaling](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling)).
  Rule for the adapter: one DPI aware process, crop by extended frame bounds, derive click space from the same
  rectangle, and measure the origin with a fixture the way `docs/web-flows-campaign.md` did.
- `SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE` (Windows 10 2004) keeps the caller's own window out
  of capture ([documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)).
  It applies to the caller's own windows only, which is what the cursor overlay needs.

### Accessibility
- UI Automation is the tree and the text source. Chromium turns accessibility on when it detects automation
  clients and accepts `--force-renderer-accessibility` ([Chromium notes](https://textslashplain.com/2021/10/12/accessibility-uia-troubleshooting/),
  [Chrome UIA update](https://developer.chrome.com/blog/windows-uia-support-update)); both are search result
  sources, not fetched Learn pages. Whether an already running Electron application honours it after the fact is
  `unsourced`. Firefox's default UIA path was planned; whether it shipped as default is `unsourced`.
- Calling the COM interface from Bun through `bun:ffi` is a risk (`unsourced` but obvious); the plan uses a helper
  executable instead.

### Workspaces
- The documented `IVirtualDesktopManager` can read a window's desktop and test the current one, but
  `MoveWindowToDesktop` does not work for windows the calling process does not own, and there is no API to
  enumerate desktops ([Windows SDK blog](https://learn.microsoft.com/en-us/archive/blogs/winsdk/virtual-desktop-switching-in-windows-10), [Old New Thing, 2020-11-23](https://devblogs.microsoft.com/oldnewthing/20201123-00/?p=104476)).
  Arbitrary placement is described as the person's job. The undocumented internal interfaces change between builds
  (third party libraries such as pyvda and VirtualDesktopAccessor track them; `unmeasured` here). So a numbered
  visible workspace cannot be built on documented Windows APIs.

### Cursor overlay
- A second system cursor does not exist as a documented feature. The agent cursor is therefore a drawn overlay:
  a layered, click through, topmost, non activating window with per pixel alpha. The flags and their behaviour
  over fullscreen exclusive and elevated windows are `unsourced` in this research and must be measured.
  Excluding it from capture uses the affinity above.

### Runtime
- AF_UNIX exists on Windows (stream only, no ancillary data) ([announcement](https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/)).
  The repository already binds it with `Bun.serve({ unix })` and rewrites the DACL (`src/ipc.ts`, `src/socket-acl.ts`).
- Services run in session 0 and cannot show or drive the user's desktop ([Session 0](https://learn.microsoft.com/en-us/archive/blogs/winsdk/launching-an-interactive-process-from-windows-service-in-windows-vista-and-later)),
  which is why autostart is a logon task.

## 3. Capability table

`Supported now` means exercised by a runner run or source contract and no more. `Achievable` means Windows
documents a mechanism; the cell says what still has to be measured. `Blocked` carries its reason.

| Capability | Status | Condition or reason |
| --- | --- | --- |
| Install, launcher, broker, MCP adapter, doctor, preflight | Supported now (runner contracts) | Not measured on a person's desktop. |
| Logon task autostart | Supported now (source contract) | Tests run on the runner; a real logon is `unmeasured` here. |
| Update staging and activation | Supported now (source contract) | Real managed update `unmeasured`. |
| Application discovery | Supported now (metadata) | Packaged (MSIX) applications `unmeasured`. |
| Window enumeration with identity and geometry | Achievable | Cloaked check, extended frame bounds, per monitor DPI; packaged apps via ApplicationFrameHost `unsourced`. |
| Opening an original application | Achievable | Normal `CreateProcess` or shell launch; exact window identity binding needs measurement. |
| Window capture | Achievable | Windows.Graphics.Capture from 1903, yellow border unless consent; fallback PrintWindow. Settled capture reuses the TypeScript batching. |
| Text observation | Achievable | UI Automation helper; Chromium and Electron need the accessibility flag or a client signal. |
| Background actions on controls (invoke, set value, toggle) | Achievable for apps whose providers support the patterns | Per application; pointer and focus effect `unmeasured`. |
| Coordinate click, drag, hover through real input | Achievable with a stated cost | `SendInput` moves the owner's pointer and needs the target at foreground. Cannot honour "owner pointer unchanged". |
| Keyboard text and keys | Achievable with a stated cost | Needs the target focused, so it steals owner focus. UIA `SetValue` is the focus free path where supported. |
| Clipboard paste for untypeable text | Achievable | Paste still needs focus unless `SetValue` works for that control. |
| Elevated target windows | Blocked | UIPI; needs a signed UIAccess build, which is a separate distribution decision. |
| Owner pointer and focus preserved for coordinate input | Blocked | No documented background pointer delivery; same class of limit as Wayland, with a different cause. |
| Agent cursor drawn independently of the real pointer | Achievable | Layered overlay; excluded from capture by affinity; overlay behaviour `unmeasured`. |
| Curved motion, press, hold, release animation | Achievable | Render only on the overlay; moves the real pointer only in the `SendInput` tier. |
| Numbered visible workspaces | Blocked (documented APIs) | See workspaces above. An undocumented path is not a release claim. |
| Forwarded window placement | Achievable | `SetWindowPos` for windows we can address; DWM frame correction needed. |
| Desktop panel, About, Settings | Achievable with a new implementation | GTK4 on Windows is `unmeasured`; a tray application is the safer shape. CLI settings are unaffected. |
| Hyprland plugin, compositor ABI checks | Not applicable | Linux only. |

## 4. Architecture

Reuse everything above the native worker and add one process below it.

```
agent host -> MCP adapter -> broker (Bun, AF_UNIX + DACL) -> NativeWorker (stdio JSON) -> platform worker
                                                                 Linux:   Python workers + Hyprland plugin
                                                                 Windows: orbit-win.exe  (new)
```

`src/native-worker.ts` already launches the worker as a stdio subprocess and takes the entry command as a
parameter, and Linux hardcodes `/usr/bin/python3` and `PATH=/usr/bin:/bin` there. A Windows worker means:

1. A platform neutral adapter interface in TypeScript, selected by `process.platform`, replacing the
   `requireNativeAdapter` Linux check. Same request and reply schema as today so batching, settle policy,
   journal and policy gates stay shared.
2. `orbit-win.exe`, one native helper (C++/WinRT or Rust with `windows-rs`; the owner decides the language,
   the plan only requires a compiled helper, not `bun:ffi` COM and not PowerShell). It exposes: `windows`,
   `open`, `observe` (image, text, both), `act` (invoke, click, key, text, drag), `overlay`, `close`.
3. Input policy in three tiers, reported on every action result as `delivery`:
   semantic (UIA pattern, pointer and focus untouched), message (window message, per application), and
   input stream (`SendInput`, owner pointer moves and target takes focus). The tier is chosen per action and
   the result says which one ran. The input stream tier is off unless the owner turns it on in settings.
4. Capture: Windows.Graphics.Capture for the window, cropped by extended frame bounds, per monitor DPI aware
   process, with the origin fixture from section 7 gating release.
5. Overlay: a separate layered window in the same helper, excluded from capture by display affinity.
6. Workspaces: replace the number with Orbit's own session ordering on Windows; do not move windows between
   virtual desktops in the first release.
7. Panel: a tray or small native window in `orbit-win.exe` or a Bun launched helper; GTK stays Linux.
8. Build and test: build the helper on `windows-latest`; unit tests run there; acceptance needs a real desktop.

## 5. Runner evidence (source and service contracts only)

These runs launch no desktop application. The workflow is `.github/workflows/platform-probes.yml`, manual only.

| Run | Content | Result |
| --- | --- | --- |
| [40873113067](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/40873113067) | Every test file on its own, before the Windows fixes | Windows: 15 red files, 31 failed tests; macOS 14 red files, 24 failed |
| [40874360118](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/40874360118) | agent-contract, packaging, windows-autostart after the tar fix | Windows autostart still red: `whoami.exe` resolved to a GNU build |
| [40874684125](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/40874684125) | Every test file, after the System32 fixes | Windows: 11 red files, 16 failed of 441 passed; macOS 13 red files, 21 failed of 450 passed; Ubuntu 32 red files, 91 failed |
| [40875301293](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/40875301293) | Broker smoke and launcher status, plus the new system tool test | see the section below |

Fixed from these runs: GNU tar from Git for Windows read `C:\` as a host (`tarExecutable` in `src/platform.ts`);
GNU `whoami` rejected `/user`, which broke the logon task SID (`systemArgv`, applied in
`src/lifecycle-command.ts` and `src/installed-startup-diagnostic.ts`).

Windows files still red after the fixes (11 files, 16 tests). None was shown to be a Windows only product defect:
- Linux only subjects that are not skipped: `native-existing` and `native-only` fail with the Linux only
  refusals (`requireNativeAdapter`, `desktop-settings.ts`), and `native-window-geometry` spawns
  `/usr/bin/python3` (red on Windows only, green on Ubuntu). They need `linuxOnlySuite` markers or fixtures.
- Stale references to removed files, shown by the ENOENT in the reports: `theme` (`viewer/style.css`),
  `windows-crash-evidence` (`src/chrome.ts`), `cli-pipe-timeout-controlled` (`tests/cli-output.test.ts`).
- Red on Windows, macOS and Ubuntu alike, cause not triaged: `ci-desktop` (the installed smoke reports another
  routing than desktop-only), `readme-claims`, `semantic-taint`, `session-mcp`, `windows-owned-census`.

## 6. Order of work

Sizes are estimates, one engineer: S under 1 week, M 1 to 3, L 3 to 6, XL over 6.

| Step | Size | Needs | Files |
| --- | --- | --- | --- |
| 1. Windows honest surface: doctor capabilities by platform, clear `UNSUPPORTED` replies, settings path on Windows | S | Edits to files other sessions own | `src/session.ts`, `src/desktop-settings.ts`, `src/native-settings.ts`, `src/native-availability.ts` |
| 2. Adapter interface in TypeScript, Linux moved behind it | M | Step 1 | `src/native-worker.ts`, `src/hyprland.ts`, `src/native-availability.ts` |
| 3. `orbit-win.exe` skeleton: enumeration with cloak and frame bounds, DPI, identity | M | Real Windows desktop | new `windows/` |
| 4. Capture with origin fixture, settled capture on the shared TypeScript path | M | Step 3, real desktop | helper, `src/native/session.py` equivalent contract |
| 5. UI Automation text observation, Chromium flag handling | L | Step 3 | helper; mirrors `src/native/a11y*.py` output |
| 6. Semantic actions (invoke, value, toggle) with measured pointer and focus effect | L | Step 5 | helper |
| 7. Input stream tier, keyboard and mouse, with the cost reported | M | Step 6 | helper |
| 8. Overlay and cursor motion | M | Step 3 | helper; port of the curve in `ghostinput.cpp` |
| 9. Placement, clipboard paste, close and cleanup | M | Step 7 | helper |
| 10. Tray panel and settings | L | Step 2 | new, `desktop/` stays GTK |
| 11. Acceptance on a real Windows host (mixed DPI, multi monitor, Arabic input, save dialogs, elevated target refusal, update) | L | Owner machine or VM | `docs/windows-measured.md` |

Changes needed in files owned by other sessions during this work: `src/native/session.py` (settle and capture
contract kept backend neutral), `src/native/a11y*.py` (output schema is the contract for the UIA helper),
`desktop/panel*.py` (no change; Windows panel is separate), `experiments/ghost-cursor/` (curve parameters
shared with the overlay), `src/session.ts` (doctor capabilities by platform).

## 7. Risks

- No documented background pointer delivery: coordinate clicks will move the owner's pointer. Mitigation: the
  three delivery tiers and an explicit setting; the release notes must say it.
- Elevated windows cannot be driven without UIAccess and a signed build. Orbit should refuse them by name.
- Capture border and consent: the yellow border is the default; borderless needs consent and packaging.
- Origin mismatch between capture and click space: measure on Firefox, Chromium, a Win32 and a packaged app
  before claiming input and capture together.
- Accessibility depends on each application's provider; Electron and Chromium need activation.
- Antivirus and SmartScreen reactions to an unsigned helper that injects input; a signing decision is needed.
- Virtual desktops: do not ship an undocumented interface.
- Runner results are not a person's desktop.

## 8. What the next release notes can claim

Claim:
- Orbit installs and starts its broker, MCP adapter, doctor, preflight and logon task on Windows, and its
  installer and update contracts pass on a GitHub Windows runner (cite the run).
- Two Windows defects fixed: archive tools and account lookup resolved against a Git for Windows PATH.

Do not claim:
- Any desktop control on Windows: opening, input, capture, text observation, cursor, panel, placement or paste.
- Batching or settled capture on Windows. Their TypeScript orchestration exists, with no backend under it.
- Owner pointer or focus preservation on Windows.
- Numbered workspaces on Windows.

The release can therefore be described as "Windows: installable broker and tooling, native control not yet
available". Anything stronger needs the acceptance in step 11.
