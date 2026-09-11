"""A small always-visible pill on a screen edge that says what Orbit is doing.

Collapsed it is one rounded pill: the number of sessions, tinted while an agent works, dimmed when
nothing runs. It pulses once when a session or an application appears. Hovering expands it into
one card per session: who is working, on what, which application or page, and how many tabs or
windows. Clicking a card opens the viewer. A right click opens the settings: notifications on or
off, the working frame on or off, the viewer, quit. Settings persist in the person's config.

It is a wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks that
protocol, and it stays out of the person's windows. It talks to the broker over the same Unix
socket the CLI uses and asks only for lists and presence, never a frame, so watching costs the
broker about a millisecond a second. The panel itself is the person's own desktop process and runs
outside Orbit's shared budget on purpose.

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

# A strip of text needs no GPU. The Cairo renderer is the cheapest GTK 4 has, and it is the one that
# works on a software-rendered display too, where the GPU renderers retry failing surfaces in a loop.
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
INDICATOR_WIDTH = 3
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}
DEFAULT_SETTINGS = {"edge": "right", "monitor": None, "indicator": True, "indicatorColor": "#4caf50", "notifications": True}
SETTINGS_PATH = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "sbar-orbit", "panel.json")

# The panel is drawn in the person's own colour names when their theme or their gtk.css defines
# them, the way a libadwaita application is, and in GTK's defaults otherwise. The fallbacks are
# loaded at the lowest priority there is, below every theme, so any definition of these names
# from a theme, the settings or the person's gtk.css wins over them.
FALLBACK_CSS = b"""
@define-color window_bg_color @theme_bg_color;
@define-color window_fg_color @theme_fg_color;
@define-color accent_bg_color @theme_selected_bg_color;
@define-color accent_fg_color @theme_selected_fg_color;
@define-color warning_bg_color #ff9800;
"""
CSS = b"""
@keyframes orbit-pulse {
  0% { box-shadow: 0 0 0 0 alpha(@accent_bg_color, 0.7); }
  100% { box-shadow: 0 0 0 14px alpha(@accent_bg_color, 0); }
}
.orbit-panel { background: alpha(@window_bg_color, 0.94); color: @window_fg_color; border-radius: 16px; padding: 4px;
  box-shadow: 0 2px 12px alpha(black, 0.25); }
.orbit-pill { min-width: 22px; min-height: 22px; padding: 2px 8px; border-radius: 14px; font-weight: 600;
  background: alpha(@window_fg_color, 0.08); color: alpha(@window_fg_color, 0.55);
  transition: background 250ms ease, color 250ms ease; }
.orbit-pill.idle { color: @window_fg_color; }
.orbit-pill.working { background: @accent_bg_color; color: @accent_fg_color; }
.orbit-pill.paused { background: alpha(@warning_bg_color, 0.85); color: @window_fg_color; }
.orbit-pill.pulse { animation: orbit-pulse 700ms ease-out 1; }
.orbit-card { padding: 8px 10px; border-radius: 12px; }
.orbit-card:hover { background: alpha(@window_fg_color, 0.08); }
.orbit-title { font-weight: 600; }
.orbit-dim { opacity: 0.65; font-size: 90%; }
.orbit-chip { font-size: 80%; font-weight: 600; padding: 1px 7px; border-radius: 8px; background: alpha(@window_fg_color, 0.1); }
.orbit-chip.working { background: @accent_bg_color; color: @accent_fg_color; }
.orbit-chip.paused { background: alpha(@warning_bg_color, 0.85); }
"""
# The indicator strips are painted by this rule alone, above the person's gtk.css, which may paint
# every window in their theme's colour.
INDICATOR_CSS = """window.orbit-indicator.background, window.orbit-indicator box { background: %s; background-color: %s; }
window.orbit-window.background { background: transparent; background-color: transparent; }"""


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
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            stored = json.load(handle)
        if isinstance(stored, dict):
            for key in DEFAULT_SETTINGS:
                if key in stored:
                    settings[key] = stored[key]
    except (OSError, ValueError):
        pass
    if settings["edge"] not in EDGES:
        settings["edge"] = DEFAULT_SETTINGS["edge"]
    return settings


def save_settings(settings):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), mode=0o700, exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as handle:
            json.dump({k: settings[k] for k in DEFAULT_SETTINGS}, handle, indent=2)
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
    """What the pill reacts to: which sessions exist and how many tabs or windows each has."""
    return {s["sessionId"]: (s.get("agentName", "Agent"), s.get("taskName", ""), len((s.get("presence") or {}).get("tabs") or []))
            for s in sessions if isinstance(s.get("sessionId"), str)}


class Panel(Gtk.Application):
    def __init__(self, settings):
        super().__init__(application_id="io.sbar.orbit.panel", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.settings = settings
        self.indicator = []
        self.indicator_shown = False
        self.indicator_color = Gdk.RGBA()
        if not self.indicator_color.parse(str(settings["indicatorColor"])):
            self.indicator_color.parse(DEFAULT_SETTINGS["indicatorColor"])
        self.path = broker_socket()
        self.sessions = []
        self.reachable = False
        self.expanded = False
        self.last_shape = None
        self.known = None
        self.polling = False
        self.pulse_source = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Off the desktop, inside a private display for instance, there is no portal to say the
        # colour scheme; follow the same variable the session's applications follow. It is set
        # before any window exists, so the theme's colour scheme media queries see it.
        scheme = os.environ.get("ADW_DEBUG_COLOR_SCHEME")
        if scheme in ("prefer-dark", "prefer-light"):
            gtk_settings = Gtk.Settings.get_default()
            dark = scheme == "prefer-dark"
            gtk_settings.set_property("gtk-application-prefer-dark-theme", dark)
            # GTK 4.20 and later answer the theme's colour scheme media queries from this setting.
            if gtk_settings.find_property("gtk-interface-color-scheme") is not None and hasattr(Gtk, "InterfaceColorScheme"):
                gtk_settings.set_property("gtk-interface-color-scheme", Gtk.InterfaceColorScheme.DARK if dark else Gtk.InterfaceColorScheme.LIGHT)

    def do_activate(self):
        window = Gtk.Window(application=self)
        window.set_title("Orbit")
        # The window itself stays transparent, above the person's gtk.css, so the pill's rounded
        # corners are real corners and not a square window behind them.
        window.add_css_class("orbit-window")
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

        display = window.get_display()
        self.install_css(display, FALLBACK_CSS, Gtk.STYLE_PROVIDER_PRIORITY_FALLBACK)
        self.install_css(display, CSS, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        color = self.indicator_color.to_string()
        self.install_css(display, (INDICATOR_CSS % (color, color)).encode(), Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)

        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.box.add_css_class("orbit-panel")
        self.pill = Gtk.Label(label="")
        self.pill.add_css_class("orbit-pill")
        self.pill.set_halign(Gtk.Align.CENTER)
        self.box.append(self.pill)
        self.details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.details.set_visible(False)
        self.box.append(self.details)

        hover = Gtk.EventControllerMotion()
        hover.connect("enter", lambda *_: self.set_expanded(True))
        hover.connect("leave", lambda *_: self.set_expanded(False))
        self.box.add_controller(hover)
        menu = Gtk.GestureClick(button=3)
        menu.connect("pressed", self.open_menu)
        self.box.add_controller(menu)
        self.menu = self.build_menu()
        self.menu.set_parent(self.pill)

        window.set_child(self.box)
        window.present()
        self.window = window
        self.indicator = [self.build_indicator_strip(edge) for edge in EDGES.values()]
        self.refresh()
        GLib.timeout_add(int(POLL_SECONDS * 1000), self.refresh)

    @staticmethod
    def install_css(display, data, priority):
        provider = Gtk.CssProvider()
        provider.load_from_data(data)
        Gtk.StyleContext.add_provider_for_display(display, provider, priority)

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

    def build_indicator_strip(self, edge):
        """One edge of the frame shown around the output while an agent works. Four strips a few
        pixels wide cost a few hundred kilobytes of buffer between them, where one surface covering
        the output would cost tens of megabytes for a transparent centre. Each strip is click
        through: its input region is empty, so pointer events reach what is underneath, and edge
        gestures keep working."""
        strip = Gtk.Window(application=self)
        strip.set_title("Orbit working")
        strip.add_css_class("orbit-indicator")
        LayerShell.init_for_window(strip)
        LayerShell.set_layer(strip, LayerShell.Layer.OVERLAY)
        LayerShell.set_namespace(strip, "sbar-orbit-indicator")
        LayerShell.set_exclusive_zone(strip, -1)
        LayerShell.set_keyboard_mode(strip, LayerShell.KeyboardMode.NONE)
        horizontal = edge in (LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM)
        LayerShell.set_anchor(strip, edge, True)
        for side in (LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT) if horizontal else (LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM):
            LayerShell.set_anchor(strip, side, True)
        self.place_on_monitor(strip)
        body = Gtk.Box()
        body.set_size_request(INDICATOR_WIDTH, INDICATOR_WIDTH)
        strip.set_child(body)

        def passthrough(*_):
            surface = strip.get_surface()
            if surface is not None:
                surface.set_input_region(cairo.Region())

        strip.connect("realize", passthrough)
        return strip

    def build_menu(self):
        model = Gio.Menu()
        model.append("Notifications", "panel.notifications")
        model.append("Working frame", "panel.indicator")
        model.append("Open viewer", "panel.viewer")
        model.append("Quit panel", "panel.quit")
        group = Gio.SimpleActionGroup()
        for key in ("notifications", "indicator"):
            action = Gio.SimpleAction.new_stateful(key, None, GLib.Variant.new_boolean(bool(self.settings[key])))
            action.connect("change-state", self.toggle_setting, key)
            group.add_action(action)
        viewer = Gio.SimpleAction.new("viewer", None)
        viewer.connect("activate", lambda *_: self.open_viewer())
        group.add_action(viewer)
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *_: self.quit())
        group.add_action(quit_action)
        self.box.insert_action_group("panel", group)
        popover = Gtk.PopoverMenu.new_from_model(model)
        popover.set_has_arrow(False)
        return popover

    def open_menu(self, gesture, n_press, x, y):
        self.menu.popup()

    def toggle_setting(self, action, value, key):
        action.set_state(value)
        self.settings[key] = value.get_boolean()
        save_settings(self.settings)
        if key == "indicator":
            self.sync_indicator(force=True)

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
        GLib.idle_add(self.apply, sessions, reachable)

    def apply(self, sessions, reachable):
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
        """A pulse, and a notification when allowed, for each session or application that appeared."""
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
        self.pulse()
        if self.settings["notifications"]:
            for title, body in events[:3]:
                notify(title, body)

    def pulse(self):
        self.pill.remove_css_class("pulse")
        if self.pulse_source is not None:
            GLib.source_remove(self.pulse_source)
        # Re-added on the next frame, so a second event restarts the animation.
        GLib.idle_add(self.start_pulse)
        self.pulse_source = GLib.timeout_add(800, self.end_pulse)

    def start_pulse(self):
        self.pill.add_css_class("pulse")
        return False

    def end_pulse(self):
        self.pill.remove_css_class("pulse")
        self.pulse_source = None
        return False

    def set_expanded(self, expanded):
        self.expanded = expanded
        self.details.set_visible(expanded and bool(self.sessions))

    def sync_indicator(self, force=False):
        working = any((s.get("activity") or {}).get("state") == "working" for s in self.sessions)
        wanted = working and bool(self.settings["indicator"])
        if self.indicator and (force or self.indicator_shown != wanted):
            self.indicator_shown = wanted
            for strip in self.indicator:
                strip.set_visible(wanted)

    def render(self):
        working = sum(1 for s in self.sessions if (s.get("activity") or {}).get("state") == "working")
        paused = sum(1 for s in self.sessions if s.get("state") == "paused")
        for name in ("working", "paused", "idle"):
            self.pill.remove_css_class(name)
        if working:
            self.pill.add_css_class("working")
        elif paused:
            self.pill.add_css_class("paused")
        elif self.sessions:
            self.pill.add_css_class("idle")
        self.sync_indicator()
        tabs = sum(len((s.get("presence") or {}).get("tabs") or []) for s in self.sessions)
        if not self.reachable:
            self.pill.set_text("·")
            self.pill.set_tooltip_text("Orbit is not running")
        elif not self.sessions:
            self.pill.set_text("0")
            self.pill.set_tooltip_text("No agent is working")
        else:
            self.pill.set_text(str(len(self.sessions)))
            self.pill.set_tooltip_text(f"{len(self.sessions)} sessions, {tabs} tabs or windows, {working} working")

        child = self.details.get_first_child()
        while child is not None:
            following = child.get_next_sibling()
            self.details.remove(child)
            child = following
        for session in self.sessions:
            self.details.append(self.card(session))
        self.details.set_visible(self.expanded and bool(self.sessions))

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
        if working:
            chip.add_css_class("working")
        elif state == "paused":
            chip.add_css_class("paused")
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


def main():
    settings = load_settings()
    args = sys.argv[1:]
    while args:
        flag = args.pop(0)
        if flag == "--edge" and args and args[0] in EDGES:
            settings["edge"] = args.pop(0)
        elif flag == "--monitor" and args:
            settings["monitor"] = args.pop(0)
        elif flag == "--indicator":
            settings["indicator"] = True
        elif flag == "--no-indicator":
            settings["indicator"] = False
        elif flag == "--indicator-color" and args:
            settings["indicatorColor"] = args.pop(0)
        elif flag == "--no-notifications":
            settings["notifications"] = False
        elif flag in ("-h", "--help"):
            print("usage: sbar-orbit panel [--edge left|right|top|bottom] [--monitor N|CONNECTOR] [--indicator|--no-indicator] "
                  "[--indicator-color CSS] [--no-notifications]")
            print(f"settings persist in {SETTINGS_PATH}; a right click on the pill changes them")
            return 0
    Panel(settings).run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
