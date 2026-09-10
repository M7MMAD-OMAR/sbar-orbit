# Research and feasibility

Reviewed 10 September 2026. Source documentation establishes available primitives; it does not prove Orbit compatibility.

| Approach | Finding | Orbit decision |
|---|---|---|
| Background browser | Chrome supports headless operation without visible UI. [Chrome](https://developer.chrome.com/docs/automation-and-testing/headless) | First measured backend; add user-controlled preview separately |
| Independent local display | Weston supports headless and other backends. Headless alone provides no input or output interface for our agent. [Weston](https://wayland.pages.freedesktop.org/weston/toc/running-weston.html) | Investigate capture and input together; do not call display startup a completed desktop proof |
| X11 virtual display | Xvfb supplies an in-memory X server. [X.Org](https://xorg.freedesktop.org/archive/X11R6.8.2/doc/Xvfb.1.html) | Possible X11 compatibility experiment; not native Wayland coverage |
| Host input portal | RemoteDesktop combines input control with a session and optional ScreenCast. [Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) | Not evidence of independent input on the human's desktop |
| Local agent connector | MCP separates hosts, clients and servers; stdio supports local processes. [Architecture](https://modelcontextprotocol.io/specification/2024-11-05/architecture), [transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | Version-negotiate and test actual hosts; MCP is not OS input isolation |
| Personal browser profile | Concurrent instances cannot use one user data directory. [Playwright](https://playwright.dev/docs/api/class-browsertype) | Orbit-owned profile and explicit account connection |
| Default Chrome debugging | Chrome 136 changed default-profile debugging behavior. [Chrome](https://developer.chrome.com/blog/remote-debugging-port) | Do not design around attaching to the default personal profile |
| Windows desktops | Only one desktop in the interactive window station is active for user input. [Microsoft](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops) | Browser backend first; native independent input remains a research gate |
| Windows semantic control | UI Automation exposes provider-dependent control patterns. [Microsoft](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview) | Test per application; not a universal hidden cursor |
| Cloud AI desktop | Warmwind OS runs agents on a custom Linux in the cloud and streams the desktop to the browser over Wayland and VNC; the person watches, the agent works by seeing the screen and moving a virtual pointer. [BGR](https://www.bgr.com/tech/the-worlds-first-ai-operating-system-wants-to-automate-your-workflow/), [itechguides](https://www.itechguides.com/warmwind-os-explained-the-cloud-ai-operating-system-for-autonomous-work/) | The same shape as an Orbit session, viewer included, with two differences that are the point of Orbit: the desktop is the person's own machine with their own applications, files and theme, and nothing leaves it. Orbit trades the cloud's unlimited cores for a local one-core budget, which is why every feature here is measured against that budget |
| macOS semantic control | Apple exposes accessibility actions. [Apple](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction) | Candidate app adapter; page extraction was limited, so no stronger compatibility conclusion |

## Compatibility matrix

| Capability | Fedora | macOS | Windows |
|---|---|---|---|
| Owned background browser | Experiment in this repo | Not tested | Not tested |
| Optional live preview | Browser viewer implemented | Planned | Planned |
| Native application input and capture | [Wayland and X11 fixtures pass](fedora-results.md) | Research: app-specific adapters | Research: app-specific adapters |
| Existing personal window, independent input | Not promised | Not promised | Not promised |
| Custom tool-capable agent | MCP implemented; Claude handshake verified | Adapter planned | Adapter planned |
| Closed agent's built-in desktop tool | Cannot transparently intercept | Cannot transparently intercept | Cannot transparently intercept |

Compatibility statements require tests against the target host and platform. Research primitives alone do not establish support.
