# Desktop presence

Status: the status source, the edge panel, the working indicator and a quickshell bar module exist and are measured. A tray icon remains a proposal.

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
sbar-orbit panel                  # a capsule on the largest screen, right edge
sbar-orbit panel --edge left --monitor HDMI-A-5 --style count
sbar-orbit panel --edge top --position 0.2   # a fifth of the way along the top edge
sbar-orbit panel --no-motion      # arrive at the open shape without the morph
sbar-orbit panel --settings       # open the settings window at once
```

A wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks the protocol, and it never becomes one of the person's windows. By default it is a capsule, five pixels wide and about thirty tall, lying along the edge it is docked to, that says the current state by colour: grey when nothing runs, the working colour while an agent works, amber when a session is paused, dim when the broker is off. There is no number on it and nothing else on the screen. It blinks once when a session starts or an application or tab appears. Measured on the person's main screen the surface is 29 by 53 pixels, of which the capsule is 5 by 29 and the rest is transparent padding, so the pointer has something to hit without aiming at the very edge of the glass.

Resting the pointer on it opens one card per session: agent, a state chip, task, what is on screen, which tab or window of how many, and the current action, with a Viewer and a Settings button under them. Clicking a card opens the viewer, a left click on the capsule opens the viewer, a right click opens the settings. Opening waits 220 ms and closing waits 320 ms, so a pointer crossing the edge of the screen on its way elsewhere does not flash the whole list. The surface is pinned to one end of its edge with a margin that puts the capsule where the person left it, because a surface anchored to a single edge is centred by the compositor and the capsule would then jump by half the height of the cards every time they opened. The card keeps its place in the layout even while closed, so the surface never resizes under the pointer; what changes is the surface's input region, which is tightened back onto the capsule so a closed panel swallows no clicks in the card-sized rectangle beside it.

### One body, not two backgrounds

The whole panel is a single Cairo outline drawn behind the widgets, not a background on each of them: a capsule around the mark, a card growing out of it, and a concave fillet on each side where the two meet. Two rounded rectangles that merely touch read as two rectangles; an arc that curves inward at the join reads as one body of liquid being pulled apart. The fillet radius is driven by the gap and shrinks to nothing as the gap grows, so the neck thins and lets go rather than snapping. It is the same shape a metaball makes, and the same shape the Dynamic Island makes; the graphics term for the join is a smooth union of two distance fields, and on the web the trick is known as the gooey effect.

The morph runs on a frame-clock tick over 380 ms, a little quicker on the way out, with the card widening ahead of its growth so it swells out of the capsule rather than unrolling, and the rows fading in on the tail of it. `--no-motion`, or the switch in the settings, arrives at the open shape without any of that.

Drawing the body rather than styling it is also what keeps the surface honest. A generated theme on this workstation sets `window { background: @window_bg_color; }`, and a theme is loaded at user priority, above any application provider, so the panel appeared as an opaque dark rectangle sitting on the wallpaper. Whether the surface has a background at all is not a matter of taste, so those few rules are now installed above user priority in `SURFACE_CSS` while everything else stays below the theme, where the person's colours win.

### Carrying the mark to another edge

Dragging the mark carries it. A landing strip appears on each edge, the nearest one grows, and the drop under the hand is joined to it by a thread that thins and lets go as the hand moves away, which is the metaball connector rather than the fillet. On release the mark lands on the nearest edge, at the point along that edge where it was let go, and both are saved. A press that never travels is a click and still opens the viewer: one drag gesture decides between the two, because a click gesture and a drag gesture on the same button fight over the press and the viewer stops opening. The capsule is small on purpose, so a press within nine pixels of it counts as a press on it; a handle that has to be hit exactly is a handle nobody uses.

All of that is drawn on a surface of its own, on the overlay layer, over the whole monitor, click through, and mapped only while the mark is in the air. The first version stretched the panel's own surface instead, and it was measurably worse in three ways, each of which the person felt. The compositor took two or three motion events to answer the new anchors with a new size, so the first quarter of every drag drew the landing strips into a surface a few hundred pixels wide at the old edge, where none of them could be seen: the drag looked dead until it suddenly was not. Moving and resizing a surface out from under the pointer grab that is delivering the drag shifted the coordinate frame the gesture measures its offsets in, so the drop jumped away from the hand. And a separate surface needs no grab of its own: its input region is empty, so the press that started the drag stays with the panel from beginning to end.

Where a drop lands is where the hand let go. `position` names the place of the middle of the mark along the edge, and the margin that places the surface is measured to its start, so half the surface comes off it. Without that subtraction the mark landed short of the hand by half a card, and further out the closer to either end.

One thing the cards must do while the mark is in the air is close. Refusing to open them during a drag is right; refusing to close them as well left them standing open through the whole drag and open again at the new edge, on top of the mark, so the next press landed on a card and the mark could not be picked up a second time. Once the mark lands, the cards stay shut until the pointer has actually left it once: the surface arriving under a stationary hand counts as the pointer entering, and the cards would otherwise spring open in the same gesture that just moved them.

One warning about the settings, because it costs a person the whole feature. With **Hide it while nothing runs** on, the mark is on screen only while an agent is mid action, which is a second here and there; the rest of the time there is nothing to rest the pointer on and nothing to drag. That is the setting doing what it says, but it is the first thing to check when the panel seems to have stopped responding.

Everything is adjustable, from a settings window a right click opens: the screen edge, the monitor by its connector name, the distance from the edge, where along the edge the mark sits, whether the mark is a capsule, a bare dot or a dot with a count, its size, whether it hides itself while nothing runs, a colour for each of the four states including the one for a broker that is off, the working frame and its colour, whether the morph runs at all, how solid the card is over the wallpaper, desktop notifications and the blink. There is a reset to defaults, the file the settings live in is printed at the bottom, Escape closes the window and it scrolls when a large font makes it taller than the screen. Each control saves and applies at once, with nothing to confirm; the writing is held back until the hand stops, so dragging the size slider writes the file once rather than forty times, and it is written to a temporary file and renamed over the real one, since a write interrupted in place would leave the person with no settings at all. Settings persist in `~/.config/sbar-orbit/panel.json`; the flags `--edge`, `--monitor` (an index or a connector name such as `HDMI-A-5`), `--style bar|dot|count`, `--position 0..1`, `--frame`/`--no-frame`, `--frame-color`, `--no-motion`, `--no-notifications` and `--settings` override them for one run. With no monitor chosen the mark goes to the largest one, the person's main screen. Notifications go through the person's own daemon by way of `notify-send`, one when an agent starts a session, one when it opens an application or tab, one when it finishes.

It is written against GTK 4 with the Cairo renderer, because a body a few hundred pixels across needs no GPU and the GPU renderers retry failing surfaces in a loop on a software display. It runs as the person's own desktop process, outside Orbit's shared budget on purpose: it is part of their shell, not of the agents' work.

Watching is cheap, and measured rather than asserted: the panel costs 0.10 to 0.25% of one core at rest and 48 MB of private memory, and the broker 0.135 ms of CPU a second to answer it. The morph is the one thing that costs more, and only while it runs: opening and closing the cards without pause for twenty seconds measured 3.4% of one core, and between morphs the tick callback is removed and the figure returns to 0.1%. A drag is the same order, 3.3% while the hand is moving, and its monitor-sized surface exists only between the press and the release. Three things keep it there. It holds one connection open instead of making two a second, which halves the latency of a presence read from 0.39 ms to 0.19 ms. It runs one worker for its whole life instead of starting a thread every second, which was 0.37 ms of pure overhead per tick, a third of everything it spent. And it asks for presence only when something is going to read it: the capsule takes its colour from the session list alone, so while the cards are closed presence is fetched every ten seconds rather than every second, and the wait between looks stretches from one second to two or three when nothing is happening. See [resources](resources.md).

Three things it must not do. It sets no GTK tooltip on the layer surface: showing one makes GTK ask the compositor to export the toplevel, a layer surface is not an xdg_toplevel, and the protocol error kills the panel the moment the person rests the pointer on it. It hands no parent window to `Gtk.UriLauncher` either, for the same reason and with the same result, which is why a click on the mark used to end the process instead of opening the viewer. And it never grows the surface under the pointer without pinning it, for the reason above.

Verified where it can be captured without touching the person's screen: inside a private display, which is a layer-shell compositor like the desktop it is meant for, with a text editor open. The capsule read idle grey for one session whose action had finished. The pointer was moved onto it and the cards opened with the capsule still at the same pixel, reading `Claude`, `running`, `Checking the panel mark`, `New Document (Draft) - Text Editor`. The pointer was then moved to the middle of the display and the cards closed, leaving the capsule alone, which is the behaviour that was reported broken. `experiments/panel-check.ts` captures the collapsed and expanded frames. The drag is checked separately, because Orbit's own pointer moves and clicks in one step and cannot hold a button down: a test-only virtual pointer holds the press while the mark is carried, and the mark is found on screen before each drag rather than assumed, which is how the stuck-open cards were found at all. Five drags in a row, one per edge and one along the edge already docked to, each landed the middle of the mark within a pixel of where it was dropped. Re-run after the redesign: the collapsed frame is the working green capsule in its glass at the right edge with no rectangle behind it, the hover at the same coordinates opened the card beside it with the capsule still at the same pixel, and the working frame reported `shownWhileWorking` and `hiddenAfter`. The morph, the shape on each of the four edges and the carry were checked the same way, against a coloured backdrop so a surface that was secretly opaque could not hide against a black one.

The link the panel opens carries a fresh access token. It is requested at the moment of the click and handed to `Gtk.UriLauncher`, never written to a file or printed. On a desktop where the browser is already running the URL travels over its remoting channel rather than a new process's command line.

### The working indicator

```sh
sbar-orbit panel                                 # the frame is on by default
sbar-orbit panel --indicator-color "#fcb975"
sbar-orbit panel --no-indicator
```

Four layer surfaces on the overlay layer, one strip along each edge of the same monitor, each with an empty input region so every click, hover and edge gesture passes through to whatever is underneath. Together they draw a 3 px frame around the screen while at least one session's current action is in flight and are hidden otherwise, so a glance at any edge says whether an agent is working right now. Four strips cost a few hundred kilobytes of buffer between them; one surface covering the output with a transparent centre would cost 29 MB per buffer on a 2560 by 1600 display at its scale and 75 MB on the 4K one, uploaded again at every map. The strips are painted by a rule loaded above user priority, since the person's `gtk.css` may paint every window in their theme's colour.

It is a static frame on purpose. This machine keeps compositor effects off because two displays at 4K and 2560 by 1600 with fractional scaling make them expensive, and this whole line of work started with a processor complaint. The strips are mapped and unmapped once per state change and cost nothing between changes; the panel process's CPU across a capture with the indicator shown and hidden is recorded in the panel check report. An animated pulse is possible later, measured first.

Verified inside a private display by `experiments/panel-check.ts`: a launch that sleeps before it maps keeps the session working for a known time; the frame captured in the middle of it has green edge pixels with the text editor and calculator visible underneath, and the frame captured after it finished has none.

The panel and its rows take the person's own colour names, `window_bg_color`, `window_fg_color` and `accent_bg_color`, when their theme, their settings or their `gtk.css` defines them, and GTK's defaults otherwise; the defaults are loaded at fallback priority, below every theme, so the strip matches their applications rather than a fixed palette. Off the desktop it follows the same colour scheme variable the session's applications follow.

## What does not exist yet

### The bar module

```sh
ln -s "$PWD/desktop/orbit-stream.py" ~/.local/bin/orbit-stream
ln -s "$PWD/desktop/quickshell/SbarOrbit.qml" ~/.config/quickshell/ii/services/
ln -s "$PWD/desktop/quickshell/OrbitIndicator.qml" ~/.config/quickshell/ii/modules/ii/bar/
```

Links rather than copies, all three the same way, so a `git pull` updates the shell and nothing
drifts between the two repositories. Verified that quickshell resolves a module through a link from
a cold start, which is the part that was not obvious.

For a shell that has its own bar, the same presence as a widget in it rather than a surface of Orbit's own. This workstation runs quickshell with the `ii` configuration, so the module is QML: a singleton service, `SbarOrbit`, and a widget, `OrbitIndicator`, dropped into the configuration and named once in its bar layout beside the other indicators.

The widget is a capsule in the shell's own colours, drawn with `Appearance.colors`, so it follows the person's generated theme with nothing to configure. It shows the state by colour with no number on it, blinks once when a session or a window appears, lists the sessions on hover in the shell's own popup, and opens the viewer on click. Showing and hiding it is the bar layout's job, in the shell's own `Revealer`, the way every other indicator there is revealed, so a bar with no agents running looks exactly as it did before:

```qml
Revealer {
    reveal: SbarOrbit.count > 0
    Layout.fillHeight: true
    Layout.rightMargin: reveal ? indicatorsRowLayout.realSpacing : 0
    implicitHeight: reveal ? orbitIndicator.implicitHeight : 0
    implicitWidth: reveal ? orbitIndicator.implicitWidth : 0
    OrbitIndicator { id: orbitIndicator }
}
```

It reads `desktop/orbit-stream.py`, a helper that prints one JSON line whenever what a bar would show changes, through `desktop/orbit_client.py`, which is the broker client with no toolkit attached so a bar module never pulls in GTK. The helper is restarted if it exits, so the bar recovers on its own.

`sbar-orbit status --watch` answers the same question but not in the same shape, so it is not a drop in replacement: it carries no `reachable` field and no per session view count, both of which the widget reads. It would also cost more than the desktop it decorates: measured side by side, `sbar-orbit status --watch` holds 117 MB resident and spends 1.3% of one core, the helper 18 MB and 0.04%. Resident memory overstates the gap where other Bun processes share the runtime's pages, so the honest number is the processor one, about thirty times less. The panel still carries its own copy of the client and should import `orbit_client` too; that is a change to the panel, waiting on a concurrent rewrite of it.

Verified inside a private display, the same way the panel is: a second quickshell instance rendering the widget and the content of its popup, reading the live broker. The capsule drew in the theme's idle colour and the popup read `2 sessions · 5 windows` over one row per session with the agent, the task, the window count and the state.

**A shell-native module for another shell.** This workstation runs quickshell with the `ii` configuration, so a module for its bar would be QML. It belongs in the person's own configuration repository, which their autosave timer sweeps, not here. With `sbar-orbit status --watch` as the contract, it is a small piece of work. On this workstation the pill is started by the compositor at login instead, from the person's Hyprland autostart, beside the broker service.

**A tray icon.** Needs a StatusNotifierItem host; quickshell provides one. Not started, because the edge panel covers the same need without depending on the shell.

## Working beside the person's browser

A related request: "I have a tab open in my browser; I want the agent to read it and work on it in parallel, and I want to see that." The second half is what Orbit does. The first half has a boundary in it worth stating plainly.

Orbit never attaches to the person's own browser. That is the rule that keeps an agent's clicks out of their windows and their logged-in sessions out of the agent's reach, and it is what makes "in parallel" true rather than a race for one pointer. So the agent cannot read the person's tab as such. What it can do is open the same page in its own session: the person hands over the address, by pasting it or by asking the agent for it, and the agent navigates there in an isolated tab, visibly, in the viewer. If the page needs a login, an Orbit-owned account snapshot supplies one that the person saved on purpose, once, from inside a session; the person's own browser cookies are never copied. See [accounts](accounts.md).

Something in between, where a click in the person's browser sends the current address to Orbit, is a small browser extension and a broker method that does not exist yet. It would still open a separate tab in a separate session; it would only save the paste.

## What is not decided

Which edge and which monitor the panel should occupy by default, whether the indicator should be per monitor or only on the one showing the viewer, and whether the panel should also expose pause and stop or stay read only. It is read only today, since the viewer already offers pause, manual control and stop behind an access token.
