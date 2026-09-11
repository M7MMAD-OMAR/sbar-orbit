"""A tiny always-visible mark on a screen edge that says what Orbit is doing.

By default it is a small dot: grey when nothing runs, the working colour while an agent works, amber
when a session is paused, dim when the broker is off. It blinks once when a session or an application
appears. Hovering it opens a card per session; clicking a card opens the viewer. A right click opens
a settings window: the edge and monitor, the shape (a dot or a dot with a count), the size, a colour
for each state, the working frame and its colour, desktop notifications and the blink. Everything is
adjustable and persists in the person's config.

It is a wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks that
protocol, and it stays out of the person's windows. It talks to the broker over the same Unix socket
the CLI uses and asks only for lists and presence, never a frame, so watching costs the broker about
a millisecond a second. The panel is the person's own desktop process and runs outside Orbit's shared
budget on purpose.

Run with /usr/bin/python3: the system interpreter has the GTK bindings, a virtualenv usually does not.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading

# The layer-shell library must be loaded before GTK resolves its Wayland symbols, which for a Python
# process means before the interpreter starts. Re-run once with it preloaded; without it the panel
# would silently become an ordinary window.
LAYER_SHELL_LIBRARY = next((p for p in ("/usr/lib64/libgtk4-layer-shell.so", "/usr/lib/libgtk4-layer-shell.so",
                                        "/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so", "/usr/lib/aarch64-linux-gnu/libgtk4-layer-shell.so")
                            if os.path.exists(p)), None)
if os.environ.get("ORBIT_PANEL_PRELOADED") != "1" and LAYER_SHELL_LIBRARY:
    preload = os.environ.get("LD_PRELOAD", "")
    if LAYER_SHELL_LIBRARY not in preload.split(":"):
        os.environ["LD_PRELOAD"] = ":".join(p for p in (LAYER_SHELL_LIBRARY, preload) if p)
    os.environ["ORBIT_PANEL_PRELOADED"] = "1"
    os.execv(sys.executable, [sys.executable, *sys.argv])

# A layer-shell surface only exists on Wayland, so the choice is not GTK's to make. A shell that
# lost WAYLAND_DISPLAY, an agent's terminal for instance, still has the compositor's socket in the
# runtime directory.
os.environ["GDK_BACKEND"] = "wayland"
if not os.environ.get("WAYLAND_DISPLAY"):
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    sockets = sorted(n for n in os.listdir(runtime_dir) if n.startswith("wayland-") and not n.endswith(".lock")) if os.path.isdir(runtime_dir) else []
    if sockets:
        os.environ["WAYLAND_DISPLAY"] = sockets[-1]

# A dot needs no GPU. The Cairo renderer is the cheapest GTK 4 has, and it is the one that works on a
# software-rendered display too, where the GPU renderers retry failing surfaces in a loop.
os.environ.setdefault("GSK_RENDERER", "cairo")
os.environ.setdefault("GDK_DISABLE", "vulkan")

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Gtk4LayerShell as LayerShell  # noqa: E402
import cairo  # noqa: E402

# The preload was for this process only; nothing it launches should inherit it.
os.environ.pop("LD_PRELOAD", None)
os.environ.pop("ORBIT_PANEL_PRELOADED", None)

POLL_SECONDS = 1.0
FRAME_WIDTH = 3
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}
STYLES = ("dot", "count")
STATE_KEYS = ("idle", "working", "paused", "offline")
DEFAULT_SETTINGS = {
    "edge": "right",
    "monitor": None,
    "style": "dot",
    "size": 12,
    "colors": {"idle": "#8a8a8a", "working": "#4caf50", "paused": "#ff9800", "offline": "#585858"},
    "notifications": True,
    "blink": True,
    "frame": True,
    "frameColor": "#4caf50",
}
SETTINGS_PATH = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "sbar-orbit", "panel.json")

# The panel is drawn in the person's own colour names when their theme or their gtk.css defines them,
# the way a libadwaita application is, and in GTK's defaults otherwise. The fallbacks are loaded at the
# lowest priority there is, below every theme, so any definition of these names, from a theme, the
# settings or the person's gtk.css, wins over them.
FALLBACK_CSS = b"""
@define-color window_bg_color @theme_bg_color;
@define-color window_fg_color @theme_fg_color;
@define-color accent_bg_color @theme_selected_bg_color;
@define-color accent_fg_color @theme_selected_fg_color;
"""
# Structure and motion only. Colours and sizes come from the person's settings, in a second provider
# reloaded when they change, so a colour edit takes effect without a restart.
BASE_CSS = b"""
@keyframes orbit-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
.orbit-shell { padding: 3px; border-radius: 999px; background: transparent; }
.orbit-shell.expanded { padding: 6px; border-radius: 14px; background: alpha(@window_bg_color, 0.96);
  color: @window_fg_color; box-shadow: 0 2px 14px alpha(black, 0.28); }
.orbit-dot { border-radius: 999px; }
.orbit-dot.blink { animation: orbit-blink 380ms ease-in-out 2; }
.orbit-count { border-radius: 999px; font-weight: 700; padding: 0 7px; color: white; }
.orbit-count.blink { animation: orbit-blink 380ms ease-in-out 2; }
.orbit-card { padding: 8px 10px; border-radius: 12px; }
.orbit-card:hover { background: alpha(@window_fg_color, 0.09); }
.orbit-title { font-weight: 600; }
.orbit-dim { opacity: 0.65; font-size: 90%; }
.orbit-chip { font-size: 80%; font-weight: 600; padding: 1px 7px; border-radius: 8px; }
.orbit-frame.background, .orbit-frame box { background: transparent; background-color: transparent; }
.orbit-frame box.on { background: @orbit-frame-color; }
window.orbit-clear.background { background: transparent; background-color: transparent; }
"""


def dynamic_css(settings):
    colors = settings["colors"]
    size = max(6, int(settings["size"]))
    lines = [
        f".orbit-dot {{ min-width: {size}px; min-height: {size}px; }}",
        f".orbit-count {{ min-width: {size + 8}px; min-height: {size + 6}px; font-size: {max(9, size - 2)}px; }}",
        f"@define-color orbit-frame-color {settings['frameColor']};",
    ]
    for key in STATE_KEYS:
        lines.append(f".orbit-dot.{key} {{ background: {colors[key]}; }}")
        lines.append(f".orbit-count.{key} {{ background: {colors[key]}; }}")
        lines.append(f".orbit-chip.{key} {{ background: {colors[key]}; color: white; }}")
    return "\n".join(lines).encode()


class UnixConnection(http.client.HTTPConnection):
    """HTTP over the broker's Unix socket, which is how every Orbit client reaches it."""

    def __init__(self, path):
        super().__init__("localhost", timeout=3)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def rpc(path, method, params=None):
    connection = UnixConnection(path)
    try:
        connection.request("POST", "/rpc", body=json.dumps({"method": method, "params": params or {}}),
                           headers={"Content-Type": "application/json"})
        payload = json.loads(connection.getresponse().read(1 << 20))
    finally:
        connection.close()
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error", {}).get("message", "Broker request failed"))
    return payload["result"]


def broker_socket():
    if os.environ.get("ORBIT_SOCKET"):
        return os.environ["ORBIT_SOCKET"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


def read_status(path):
    sessions = [s for s in rpc(path, "session.list") if isinstance(s, dict) and s.get("state") not in ("closed", "closing")]
    for session in sessions:
        try:
            presence = rpc(path, "session.presence", {"sessionId": session["sessionId"]})
            session["presence"] = presence if isinstance(presence, dict) else None
        except Exception:
            session["presence"] = None
    return sessions


def viewer_link_is_local(url):
    """The only link the panel will open: the broker's own loopback viewer with its token fragment."""
    return isinstance(url, str) and url.startswith("http://127.0.0.1:") and "#" in url and len(url.split("#", 1)[1]) >= 32


def load_settings():
    """The person's choices, under their config directory; command line flags override them for one run."""
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            stored = json.load(handle)
    except (OSError, ValueError):
        stored = {}
    if isinstance(stored, dict):
        # Names used before this version, kept readable so an old config is not lost.
        if "indicator" in stored and "frame" not in stored:
            stored["frame"] = stored["indicator"]
        if "indicatorColor" in stored and "frameColor" not in stored:
            stored["frameColor"] = stored["indicatorColor"]
        for key, default in DEFAULT_SETTINGS.items():
            value = stored.get(key, default)
            if key == "colors" and isinstance(value, dict):
                value = {c: value.get(c, default[c]) for c in STATE_KEYS}
            settings[key] = value
    if settings["edge"] not in EDGES:
        settings["edge"] = DEFAULT_SETTINGS["edge"]
    if settings["style"] not in STYLES:
        settings["style"] = DEFAULT_SETTINGS["style"]
    return settings


def save_settings(settings):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), mode=0o700, exist_ok=True)
        payload = {k: settings[k] for k in DEFAULT_SETTINGS}
        with open(SETTINGS_PATH, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
    except OSError as error:
        print(f"panel: could not save settings: {error}", file=sys.stderr)


def notify(title, body):
    """A desktop notification through the person's own daemon, so it looks like every other one."""
    try:
        subprocess.Popen(["notify-send", "--app-name=Sbar Orbit", "--expire-time=4000", title, body],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def session_shape(sessions):
    """What the mark reacts to: which sessions exist and how many tabs or windows each has."""
    return {s["sessionId"]: (s.get("agentName", "Agent"), s.get("taskName", ""), len((s.get("presence") or {}).get("tabs") or []))
            for s in sessions if isinstance(s.get("sessionId"), str)}


class Panel(Gtk.Application):
    def __init__(self, settings):
        super().__init__(application_id="io.sbar.orbit.panel", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.settings = settings
        self.frame = []
        self.frame_shown = False
        self.path = broker_socket()
        self.sessions = []
        self.reachable = False
        self.expanded = False
        self.last_shape = None
        self.known = None
        self.polling = False
        self.blink_source = None
        self.settings_window = None
        self.dynamic_provider = None
        self.frame_provider = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Off the desktop, inside a private display for instance, there is no portal to say the colour
        # scheme; follow the same variable the session's applications follow. It is set before any
        # window exists, so the theme's colour scheme media queries see it.
        scheme = os.environ.get("ADW_DEBUG_COLOR_SCHEME")
        if scheme in ("prefer-dark", "prefer-light"):
            gtk_settings = Gtk.Settings.get_default()
            dark = scheme == "prefer-dark"
            gtk_settings.set_property("gtk-application-prefer-dark-theme", dark)
            if gtk_settings.find_property("gtk-interface-color-scheme") is not None and hasattr(Gtk, "InterfaceColorScheme"):
                gtk_settings.set_property("gtk-interface-color-scheme", Gtk.InterfaceColorScheme.DARK if dark else Gtk.InterfaceColorScheme.LIGHT)

    def do_activate(self):
        window = Gtk.Window(application=self)
        window.set_title("Orbit")
        window.add_css_class("orbit-clear")
        if not LayerShell.is_supported():
            print("wlr-layer-shell is not available: either this compositor does not offer it, or libgtk4-layer-shell is not installed", file=sys.stderr)
            self.quit()
            return
        LayerShell.init_for_window(window)
        LayerShell.set_layer(window, LayerShell.Layer.TOP)
        LayerShell.set_namespace(window, "sbar-orbit-panel")
        LayerShell.set_anchor(window, EDGES[self.settings["edge"]], True)
        LayerShell.set_margin(window, EDGES[self.settings["edge"]], 8)
        self.place_on_monitor(window)

        self.display = window.get_display()
        self.install_css(self.display, FALLBACK_CSS, Gtk.STYLE_PROVIDER_PRIORITY_FALLBACK)
        self.install_css(self.display, BASE_CSS, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.dynamic_provider = self.install_css(self.display, dynamic_css(self.settings), Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)

        self.shell = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.shell.add_css_class("orbit-shell")
        self.shell.set_halign(Gtk.Align.CENTER)
        self.mark = Gtk.Box()
        self.mark.set_halign(Gtk.Align.CENTER)
        self.mark.set_valign(Gtk.Align.CENTER)
        self.dot = Gtk.Box()
        self.dot.add_css_class("orbit-dot")
        self.count = Gtk.Label(label="0")
        self.count.add_css_class("orbit-count")
        self.mark.append(self.dot)
        self.mark.append(self.count)
        self.shell.append(self.mark)
        self.details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.details.set_visible(False)
        self.shell.append(self.details)

        hover = Gtk.EventControllerMotion()
        hover.connect("enter", lambda *_: self.set_expanded(True))
        hover.connect("leave", lambda *_: self.set_expanded(False))
        self.shell.add_controller(hover)
        menu = Gtk.GestureClick(button=3)
        menu.connect("pressed", lambda *_: self.open_settings())
        self.shell.add_controller(menu)

        window.set_child(self.shell)
        window.present()
        self.window = window
        self.frame = [self.build_frame_strip(edge) for edge in EDGES.values()]
        self.apply_style()
        self.refresh()
        GLib.timeout_add(int(POLL_SECONDS * 1000), self.refresh)

    @staticmethod
    def install_css(display, data, priority):
        provider = Gtk.CssProvider()
        provider.load_from_data(data)
        Gtk.StyleContext.add_provider_for_display(display, provider, priority)
        return provider

    def apply_style(self):
        """Reload the colours and sizes, and show the dot or the count as the person chose."""
        if self.dynamic_provider is not None:
            self.dynamic_provider.load_from_data(dynamic_css(self.settings))
        self.dot.set_visible(self.settings["style"] == "dot")
        self.count.set_visible(self.settings["style"] == "count")

    def place_on_monitor(self, window):
        """The chosen monitor by index or connector name, else the largest one: the person's main
        screen, where a glance lands, rather than whichever the compositor picks."""
        monitors = window.get_display().get_monitors()
        wanted = self.settings["monitor"]
        chosen = None

        def pixels(monitor):
            geometry = monitor.get_geometry()
            return geometry.width * geometry.height * monitor.get_scale_factor() ** 2

        for index in range(monitors.get_n_items()):
            monitor = monitors.get_item(index)
            if wanted is not None and str(wanted) in (str(index), monitor.get_connector() or ""):
                chosen = monitor
                break
            if chosen is None or pixels(monitor) > pixels(chosen):
                chosen = monitor
        if chosen is not None:
            LayerShell.set_monitor(window, chosen)

    def build_frame_strip(self, edge):
        """One edge of the frame shown around the output while an agent works. Four strips a few
        pixels wide cost a few hundred kilobytes of buffer between them, where one surface covering
        the output would cost tens of megabytes for a transparent centre. Each strip is click
        through: its input region is empty, so pointer events reach what is underneath."""
        strip = Gtk.Window(application=self)
        strip.set_title("Orbit working")
        strip.add_css_class("orbit-frame")
        LayerShell.init_for_window(strip)
        LayerShell.set_layer(strip, LayerShell.Layer.OVERLAY)
        LayerShell.set_namespace(strip, "sbar-orbit-frame")
        LayerShell.set_exclusive_zone(strip, -1)
        LayerShell.set_keyboard_mode(strip, LayerShell.KeyboardMode.NONE)
        horizontal = edge in (LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM)
        LayerShell.set_anchor(strip, edge, True)
        for side in (LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT) if horizontal else (LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM):
            LayerShell.set_anchor(strip, side, True)
        self.place_on_monitor(strip)
        body = Gtk.Box()
        body.add_css_class("on")
        body.set_size_request(FRAME_WIDTH, FRAME_WIDTH)
        strip.set_child(body)

        def passthrough(*_):
            surface = strip.get_surface()
            if surface is not None:
                surface.set_input_region(cairo.Region())

        strip.connect("realize", passthrough)
        return strip

    def refresh(self):
        """Poll off the main thread, so a slow broker never freezes the surface; skip a tick while one is in flight."""
        if self.polling:
            return True
        self.polling = True
        threading.Thread(target=self.poll, daemon=True).start()
        return True

    def poll(self):
        try:
            sessions = read_status(self.path)
            reachable = True
        except Exception:
            sessions, reachable = [], False
        GLib.idle_add(self.apply_status, sessions, reachable)

    def apply_status(self, sessions, reachable):
        self.polling = False
        self.sessions, self.reachable = sessions, reachable
        shape = json.dumps(sessions, sort_keys=True)
        try:
            if shape != self.last_shape:
                self.render()
                self.announce()
                self.last_shape = shape
        except Exception as error:
            print(f"panel: could not render status: {error}", file=sys.stderr)
        return False

    def announce(self):
        """A blink, and a notification when allowed, for each session or application that appeared."""
        current = session_shape(self.sessions)
        if self.known is None:
            self.known = current
            return
        events = []
        for session_id, (agent, task, tabs) in current.items():
            if session_id not in self.known:
                events.append((f"{agent} started", task or "a new session"))
            elif tabs > self.known[session_id][2]:
                title = next(((s.get("presence") or {}).get("title") for s in self.sessions if s.get("sessionId") == session_id), None)
                events.append((f"{agent} opened {title or 'a new window'}", task))
        for session_id, (agent, task, _) in self.known.items():
            if session_id not in current:
                events.append((f"{agent} finished", task))
        self.known = current
        if not events:
            return
        if self.settings["blink"]:
            self.blink()
        if self.settings["notifications"]:
            for title, body in events[:3]:
                notify(title, body)

    def blink(self):
        target = self.dot if self.settings["style"] == "dot" else self.count
        target.remove_css_class("blink")
        if self.blink_source is not None:
            GLib.source_remove(self.blink_source)
        GLib.idle_add(lambda t=target: (t.add_css_class("blink"), False)[1])
        self.blink_source = GLib.timeout_add(820, lambda t=target: self.end_blink(t))

    def end_blink(self, target):
        target.remove_css_class("blink")
        self.blink_source = None
        return False

    def set_expanded(self, expanded):
        self.expanded = expanded
        show = expanded and bool(self.sessions)
        self.details.set_visible(show)
        if show:
            self.shell.add_css_class("expanded")
        else:
            self.shell.remove_css_class("expanded")

    def sync_frame(self, force=False):
        working = any((s.get("activity") or {}).get("state") == "working" for s in self.sessions)
        wanted = working and bool(self.settings["frame"])
        if self.frame and (force or self.frame_shown != wanted):
            self.frame_shown = wanted
            for strip in self.frame:
                strip.set_visible(wanted)

    def state_of(self):
        if not self.reachable:
            return "offline"
        if any((s.get("activity") or {}).get("state") == "working" for s in self.sessions):
            return "working"
        if any(s.get("state") == "paused" for s in self.sessions):
            return "paused"
        return "idle"

    def render(self):
        state = self.state_of()
        for widget in (self.dot, self.count):
            for key in STATE_KEYS:
                widget.remove_css_class(key)
            widget.add_css_class(state)
        self.count.set_text("·" if state == "offline" else str(len(self.sessions)))
        self.sync_frame()
        tabs = sum(len((s.get("presence") or {}).get("tabs") or []) for s in self.sessions)
        tip = {"offline": "Orbit is not running", "idle": "No agent is working"}.get(state)
        self.mark.set_tooltip_text(tip or f"{len(self.sessions)} sessions, {tabs} tabs or windows")

        child = self.details.get_first_child()
        while child is not None:
            following = child.get_next_sibling()
            self.details.remove(child)
            child = following
        for session in self.sessions:
            self.details.append(self.card(session))
        self.set_expanded(self.expanded)

    def card(self, session):
        presence = session.get("presence") or {}
        activity = session.get("activity") or {}
        button = Gtk.Button()
        button.add_css_class("orbit-card")
        button.add_css_class("flat")
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        name = Gtk.Label(label=session.get("agentName", "Agent"), xalign=0)
        name.add_css_class("orbit-title")
        name.set_hexpand(True)
        head.append(name)
        state = session.get("state", "")
        working = activity.get("state") == "working"
        chip = Gtk.Label(label="working" if working else state)
        chip.add_css_class("orbit-chip")
        chip.add_css_class("working" if working else "paused" if state == "paused" else "idle")
        head.append(chip)
        column.append(head)
        task = Gtk.Label(label=session.get("taskName", ""), xalign=0)
        task.set_ellipsize(3)
        task.set_max_width_chars(40)
        column.append(task)
        tabs = presence.get("tabs") or []
        active = next((t for t in tabs if isinstance(t, dict) and t.get("active")), None)
        kind = "windows" if session.get("backend") == "fedora" else "tabs"
        parts = [presence.get("title") or session.get("backend", "")]
        if tabs:
            parts.append(f"{active.get('tab', '?') if active else '?'} of {len(tabs)} {kind}")
        if activity:
            parts.append(activity.get("type", ""))
        meta = Gtk.Label(label="  ·  ".join(p for p in parts if p), xalign=0)
        meta.add_css_class("orbit-dim")
        meta.set_ellipsize(3)
        meta.set_max_width_chars(44)
        column.append(meta)
        button.set_child(column)
        button.connect("clicked", lambda *_: self.open_viewer())
        return button

    def open_viewer(self):
        # The viewer link carries an access token, so it is requested now and handed straight to the
        # browser rather than written anywhere. Which session to show is selected in the viewer.
        try:
            url = rpc(self.path, "preview.open")["url"]
        except Exception as error:
            print(f"panel: could not open the viewer: {error}", file=sys.stderr)
            return
        if not viewer_link_is_local(url):
            print("panel: the broker returned something other than a local viewer link; not opening it", file=sys.stderr)
            return

        def done(launcher, result):
            try:
                launcher.launch_finish(result)
            except Exception as error:
                print(f"panel: the browser did not open the viewer: {error}", file=sys.stderr)

        Gtk.UriLauncher.new(url).launch(self.window, None, done)

    # --- Settings window -------------------------------------------------------------------------

    def change(self, key, value, restyle=True):
        self.settings[key] = value
        save_settings(self.settings)
        if restyle:
            self.apply_style()
        self.sync_frame(force=True)

    def open_settings(self):
        if self.settings_window is not None:
            self.settings_window.present()
            return
        self.settings_window = SettingsWindow(self)
        self.settings_window.connect("close-request", self.on_settings_closed)
        self.settings_window.present()

    def on_settings_closed(self, *_):
        self.settings_window = None
        return False


class SettingsWindow(Gtk.Window):
    """A plain top-level window, not a layer surface, so the compositor gives it focus and a title bar.
    Every control writes straight into the panel's settings, saves and applies, so there is no OK to
    press and nothing to lose."""

    def __init__(self, panel):
        super().__init__(title="Sbar Orbit")
        self.panel = panel
        self.set_default_size(360, -1)
        self.set_resizable(False)
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin_top=18, margin_bottom=18, margin_start=18, margin_end=18)

        outer.append(self.group("Placement", [
            self.dropdown_row("Screen edge", list(EDGES), self.panel.settings["edge"], lambda v: self.panel.change("edge", v)),
            self.monitor_row(),
        ]))
        outer.append(self.group("The mark", [
            self.dropdown_row("Shape", ["dot", "dot with count"], "dot" if self.panel.settings["style"] == "dot" else "dot with count",
                              lambda v: self.panel.change("style", "dot" if v == "dot" else "count")),
            self.scale_row("Size", 8, 22, self.panel.settings["size"], lambda v: self.panel.change("size", v)),
            self.color_row("Working colour", "working"),
            self.color_row("Paused colour", "paused"),
            self.color_row("Idle colour", "idle"),
        ]))
        outer.append(self.group("Working frame", [
            self.switch_row("Frame the screen while working", self.panel.settings["frame"], lambda v: self.panel.change("frame", v)),
            self.frame_color_row(),
        ]))
        outer.append(self.group("Notifications", [
            self.switch_row("Desktop notifications", self.panel.settings["notifications"], lambda v: self.panel.change("notifications", v, restyle=False)),
            self.switch_row("Blink when something happens", self.panel.settings["blink"], lambda v: self.panel.change("blink", v, restyle=False)),
        ]))
        viewer = Gtk.Button(label="Open the viewer")
        viewer.add_css_class("pill")
        viewer.connect("clicked", lambda *_: self.panel.open_viewer())
        outer.append(viewer)
        self.set_child(outer)

    def group(self, title, rows):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        heading = Gtk.Label(label=title, xalign=0)
        heading.add_css_class("heading")
        box.append(heading)
        listbox = Gtk.ListBox()
        listbox.add_css_class("boxed-list")
        listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        for row in rows:
            listbox.append(row)
        box.append(listbox)
        return box

    def row(self, label, control):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, margin_top=8, margin_bottom=8, margin_start=12, margin_end=12)
        text = Gtk.Label(label=label, xalign=0)
        text.set_hexpand(True)
        row.append(text)
        control.set_valign(Gtk.Align.CENTER)
        row.append(control)
        return row

    def switch_row(self, label, value, on_change):
        switch = Gtk.Switch(active=bool(value))
        switch.connect("state-set", lambda _s, state: (on_change(state), False)[1])
        return self.row(label, switch)

    def dropdown_row(self, label, options, current, on_change):
        model = Gtk.StringList()
        for option in options:
            model.append(option)
        drop = Gtk.DropDown(model=model)
        if current in options:
            drop.set_selected(options.index(current))
        drop.connect("notify::selected", lambda d, _p: on_change(options[d.get_selected()]))
        return self.row(label, drop)

    def monitor_row(self):
        connectors = ["Largest screen"]
        monitors = self.get_display().get_monitors()
        for index in range(monitors.get_n_items()):
            connectors.append(monitors.get_item(index).get_connector() or f"monitor {index}")
        wanted = self.panel.settings["monitor"]
        current = next((c for c in connectors if str(wanted) == c), "Largest screen")
        return self.dropdown_row("Monitor", connectors, current,
                                 lambda v: self.panel.change("monitor", None if v == "Largest screen" else v, restyle=False))

    def scale_row(self, label, low, high, value, on_change):
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, low, high, 1)
        scale.set_value(value)
        scale.set_size_request(140, -1)
        scale.set_draw_value(False)
        scale.connect("value-changed", lambda s: on_change(int(s.get_value())))
        return self.row(label, scale)

    def color_button(self, hex_value, on_set):
        rgba = Gdk.RGBA()
        rgba.parse(hex_value)
        button = Gtk.ColorDialogButton.new(Gtk.ColorDialog())
        button.set_rgba(rgba)
        button.connect("notify::rgba", lambda b, _p: on_set(rgba_to_hex(b.get_rgba())))
        return button

    def color_row(self, label, key):
        return self.row(label, self.color_button(self.panel.settings["colors"][key],
                                                  lambda hexv: self.set_color(key, hexv)))

    def set_color(self, key, hex_value):
        colors = dict(self.panel.settings["colors"])
        colors[key] = hex_value
        self.panel.change("colors", colors)

    def frame_color_row(self):
        return self.row("Frame colour", self.color_button(self.panel.settings["frameColor"],
                                                          lambda hexv: self.panel.change("frameColor", hexv)))


def rgba_to_hex(rgba):
    return "#%02x%02x%02x" % (round(rgba.red * 255), round(rgba.green * 255), round(rgba.blue * 255))


def main():
    settings = load_settings()
    args = sys.argv[1:]
    while args:
        flag = args.pop(0)
        if flag == "--edge" and args and args[0] in EDGES:
            settings["edge"] = args.pop(0)
        elif flag == "--monitor" and args:
            settings["monitor"] = args.pop(0)
        elif flag == "--style" and args and args[0] in STYLES:
            settings["style"] = args.pop(0)
        elif flag in ("--frame", "--indicator"):
            settings["frame"] = True
        elif flag in ("--no-frame", "--no-indicator"):
            settings["frame"] = False
        elif flag in ("--frame-color", "--indicator-color") and args:
            settings["frameColor"] = args.pop(0)
        elif flag == "--no-notifications":
            settings["notifications"] = False
        elif flag in ("-h", "--help"):
            print("usage: sbar-orbit panel [--edge left|right|top|bottom] [--monitor N|CONNECTOR] [--style dot|count]")
            print("                        [--frame|--no-frame] [--frame-color CSS] [--no-notifications]")
            print(f"settings persist in {SETTINGS_PATH}; a right click on the mark opens the settings window")
            return 0
    Panel(settings).run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
