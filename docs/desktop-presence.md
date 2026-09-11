# Desktop presence

Status: the status source, the edge panel and the working indicator exist and are measured. A shell-native module and a tray icon remain proposals.

## The request

Orbit sessions are invisible. Nothing on the desktop says an agent is working, so the person has to remember to open a viewer. The request is a permanent, customizable presence on the desktop: an edge docked element or a tray icon that reacts on hover with an animation and expands into a side panel showing the sessions, the tabs and windows open in each, and what the agent is doing, plus a visible signal on screen while an agent is working, in the style of a glow around the screen edges.

## One correction before the design

Two parts of the request assume Orbit sessions live on the person's desktop. They do not, and that is the property that makes the separation real.

- **"Switch to the workspace the agent is working in."** A session is a private compositor on its own `HEADLESS-1` output, or a headless browser with no window at all. No desktop workspace contains it, so no workspace switch can reach it. What the panel does is name the session and open its viewer in one click.
- **"See where the agent's mouse is."** The agent's pointer exists only inside its own session. That is why no operating system pointer moves while it works. The panel shows the pointer's coordinates within the session, and the viewer draws it on the session image.

If the goal really is "the agent's window sits among my windows", that is a different architecture: run the application on the person's own compositor instead of a private one. It would make the work navigable and would remove display separation at the same time. It is a legitimate option, and it is the opposite trade to the one Orbit currently makes.

## What exists

### The status source

```sh
sbar-orbit status
sbar-orbit status --watch
```

One read-only JSON view of everything the broker owns: each session's agent, task, state, backend, current activity, surface size, title, location, tabs or windows and pointer position, with counts on top and a one-line summary for a bar. It reaches the managed broker without `ORBIT_SOCKET`. `--watch` prints a line only when something changed, so a quiet desktop prints nothing.

It never captures a frame. It uses `session.list` and a new `session.presence` method, which returns what `observe` returns minus the image: a page title read for a browser session, a compositor tree query for a private display, both measured under a millisecond of broker time. Polling once a second costs one list call and one presence call per open session.

### The edge panel

```sh
sbar-orbit panel                  # right edge, current monitor
sbar-orbit panel --edge left --monitor 1
```

A wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks the protocol, and it never becomes one of the person's windows. Collapsed it is a dot and `sessions/tabs`: grey when idle, green while an agent is working, amber when a session is paused. Hovering expands it into one row per session: agent and task, what is on screen, the state and current action, which tab or window of how many, and the pointer position. Clicking a row opens the viewer.

It is written against GTK 4 with the Cairo renderer, because a strip of text needs no GPU and the GPU renderers retry failing surfaces in a loop on a software display. It runs as the person's own desktop process, outside Orbit's shared budget on purpose: it is part of their shell, not of the agents' work.

Verified where it can be captured without touching the person's screen: inside a private display, which is a layer-shell compositor like the desktop it is meant for, with a text editor and a calculator open. `experiments/panel-check.ts` saves the collapsed and the expanded frame. The strip read `1/2` for one session with two windows; the expanded row read `Hermes · Editing a document · Calculator · running · pointer · done · window 2 of 2 · pointer 1265,400`.

The link the panel opens carries a fresh access token. It is requested at the moment of the click and handed to `Gtk.UriLauncher`, never written to a file or printed. On a desktop where the browser is already running the URL travels over its remoting channel rather than a new process's command line.

### The working indicator

```sh
sbar-orbit panel --indicator
sbar-orbit panel --indicator --indicator-color "#fcb975"
```

A second layer surface on the overlay layer, anchored to all four edges of the same monitor, with an empty input region so every click and hover passes through to whatever is underneath. It draws a 3 px frame around the screen while at least one session's current action is in flight and is hidden otherwise, so a glance at any edge says whether an agent is working right now. The centre is transparent whatever the person's theme says: their `gtk.css` may paint every window, so the transparency rule is loaded above user priority.

It is a static frame on purpose. This machine keeps compositor effects off because two displays at 4K and 2560 by 1600 with fractional scaling make them expensive, and this whole line of work started with a processor complaint. The frame is drawn once per state change and costs nothing between changes: across a capture with the indicator shown and hidden, the panel process used 0 to 1 clock ticks of CPU. An animated pulse is possible later, measured first.

Verified inside a private display by `experiments/panel-check.ts`: a launch that sleeps before it maps keeps the session working for a known time; the frame captured in the middle of it has green edge pixels with the text editor and calculator visible underneath, and the frame captured after it finished has none.

The panel and its rows take the person's own colour names, `window_bg_color`, `window_fg_color` and `accent_bg_color`, when their theme defines them, and GTK's defaults otherwise, so the strip matches their applications rather than a fixed palette.

## What does not exist yet

**A shell-native module.** This workstation runs quickshell with the `ii` configuration, so a module for its bar would be QML. It belongs in the person's own configuration repository, which their autosave timer sweeps, not here. With `sbar-orbit status --watch` as the contract, it is a small piece of work.

**A tray icon.** Needs a StatusNotifierItem host; quickshell provides one. Not started, because the edge panel covers the same need without depending on the shell.

## Working beside the person's browser

A related request: "I have a tab open in my browser; I want the agent to read it and work on it in parallel, and I want to see that." The second half is what Orbit does. The first half has a boundary in it worth stating plainly.

Orbit never attaches to the person's own browser. That is the rule that keeps an agent's clicks out of their windows and their logged-in sessions out of the agent's reach, and it is what makes "in parallel" true rather than a race for one pointer. So the agent cannot read the person's tab as such. What it can do is open the same page in its own session: the person hands over the address, by pasting it or by asking the agent for it, and the agent navigates there in an isolated tab, visibly, in the viewer. If the page needs a login, an Orbit-owned account snapshot supplies one that the person saved on purpose, once, from inside a session; the person's own browser cookies are never copied. See [accounts](accounts.md).

Something in between, where a click in the person's browser sends the current address to Orbit, is a small browser extension and a broker method that does not exist yet. It would still open a separate tab in a separate session; it would only save the paste.

## What is not decided

Which edge and which monitor the panel should occupy by default, whether the indicator should be per monitor or only on the one showing the viewer, and whether the panel should also expose pause and stop or stay read only. It is read only today, since the viewer already offers pause, manual control and stop behind an access token.
