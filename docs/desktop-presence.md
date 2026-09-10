# Desktop presence proposal

Status: proposal, nothing here is implemented. It records what was asked for, which parts are feasible on this workstation, and what each part costs.

## The request

Orbit sessions are invisible. Nothing on the desktop says an agent is working, so the person has to remember to open a viewer. The request is a permanent, customizable presence on the desktop: an edge docked element or a tray icon that reacts on hover with an animation and expands into a side panel, plus a visible signal on screen while an agent is working, in the style of a glow around the screen edges.

## One correction before the design

Two parts of the request assume Orbit sessions live on the person's desktop. They do not, and that is the property that makes the separation real.

- **"Switch to the workspace the agent is working in."** A session is a private compositor on its own `HEADLESS-1` output, or a headless browser with no window at all. No Hyprland workspace contains it, so no workspace switch can reach it. What the panel can do is name the session and open its viewer.
- **"See where the agent's mouse is."** The agent's pointer exists only inside its own session. That is why no operating system pointer moves while it works. The panel can show the pointer's coordinates within the session and draw it on the session image, which is what the viewer already does.

So the honest version of the feature is: the desktop presence tells you an agent is working, which session, what it is doing, and gets you into the viewer in one click. It is a launcher and a status light, not a window onto a desktop workspace.

If the goal really is "the agent's window sits among my windows", that is a different architecture: run the application on the person's own compositor instead of a private one. It would make the work navigable and would remove display separation at the same time. It is a legitimate option, and it is the opposite trade to the one Orbit currently makes.

## What this workstation actually runs

Checked, not assumed:

| Fact | Value |
|---|---|
| Shell | quickshell, `qs -c ii`, providing `quickshell:bar`, `quickshell:background`, `quickshell:screenCorners`, `quickshell:overview` layers |
| Bar | quickshell, not waybar, although waybar is installed |
| Layer shell libraries | `gtk4-layer-shell` 1.3.0 and `gtk-layer-shell` 0.10.0 present |
| Monitors | `eDP-1` 2560x1600 at scale 1.333, `HDMI-A-5` 3840x2160 at scale 1.5 |

This matters for two reasons. The person's shell is QML, so a native module would be QML, and it lives in their own configuration repository rather than in this project. And the second monitor is 4K at fractional scale, which is the surface any full screen effect has to paint.

## Feasibility, part by part

| Requested | Feasible | How, and what it costs |
|---|---|---|
| Permanent element docked to a screen edge | Yes | `wlr-layer-shell`, which is what the existing shell already uses. A small always visible surface on the `top` layer, anchored to one edge. |
| Reacts on hover and expands into a side panel | Yes | The surface keeps a narrow input region while collapsed and grows on pointer enter. Animation is a local property animation on a small surface, not a compositor effect. |
| Tray icon | Yes, with a caveat | Requires a StatusNotifierItem host. quickshell's `ii` config provides one; a standalone application would publish the item and let the shell render it. |
| Panel shows sessions, state and current activity | Yes | This data already exists. `session.list` returns session id, backend, state, agent name, task name and the current activity kind, actor and sequence. |
| Panel shows the agent's pointer position | Yes, within the session | `session.observe` already returns `presence.pointer`, plus title, location, and for the browser `pageCount` and `pageIndex`. |
| Click to open the session | Yes | The panel calls `preview.open` and hands the returned link to a browser. |
| "Navigate to the workspace it is working in" | No, as described | See the correction above. A session is not on a workspace. |
| Glow on the screen edges while an agent works | Yes, with a cost decision | A static border is a layer surface with an empty input region and a transparent centre. An animated pulse across 3840x2160 at fractional scale is a different proposition on this machine, where compositor effects are deliberately kept off and where a processor complaint started this work. Ship the static border, measure before animating. |

## What the panel should show

The request left this open. Everything below is already available from the broker, so the panel needs no new backend work except a read only status endpoint.

Per session: the agent name and task name, the backend, the state (running, pausing, paused, closing, closed), the current action kind and whether it is working, done or failed, and its sequence number. For a browser session, the page title, the origin and path without query or fragment, and which tab of how many is being followed. For a native session, the focused application title. Plus the pointer position inside the session.

Summary line: how many sessions are running, and whether the shared budget is under pressure, which `doctor` already reports.

Deliberately not shown: action text, selectors, command arguments and full URLs. The broker already withholds these from its activity record, and the panel must not reintroduce them.

## Security constraint that shapes the design

`preview.open` mints a fresh access token per call and returns it inside the viewer link. That link is a credential. It must never be written to a file, passed in a command line that other processes can read from `/proc`, logged, or displayed. The panel must request it at the moment of opening and hand it directly to the browser it spawns.

For the same reason the panel talks to the broker over the existing Unix socket, which is mode 600 inside a mode 700 directory, and it needs no new privileges of any kind. It reads status and opens viewers. It never needs to write to a session.

## Plan

Four steps, each independently useful, in the order that delivers something visible soonest.

1. **A read only status source in this project.** One CLI subcommand that prints the current sessions and their presence as JSON, and a `--watch` mode that emits a line whenever it changes. Everything it prints already exists in `session.list` and `session.observe`. This is the contract every front end uses, and it is testable without any graphical code.

2. **A standalone edge panel in this project**, built on `gtk4-layer-shell`, which is already installed. Collapsed it is a small anchored strip. On hover it expands into the session list described above. Clicking a session opens its viewer. This keeps the feature inside the project, works on any `wlr-layer-shell` compositor rather than only this machine's shell, and does not touch the person's configuration repository.

3. **The working indicator.** A second layer surface on the overlay layer, click through, drawn only while at least one session is running, a static border first. Measure it with the sampling already built for the viewer cost work before considering animation, and record the number the way every other claim in this project is recorded.

4. **An optional quickshell module.** Once step 1 exists, a QML module for the `ii` configuration is a small piece of work that matches the person's actual shell and their existing bar. It belongs in their configuration repository, not here, because that repository is theirs and is swept by their own autosave timer.

## What is not decided

Which edge and which monitor the panel should occupy, whether the indicator should be per monitor or only on the one showing the viewer, and whether the panel should also expose pause and stop or stay read only. Read only is the safer default, since the viewer already offers pause, manual control and stop behind an access token.
