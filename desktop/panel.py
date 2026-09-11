"""A tiny always-visible mark on a screen edge that says what Orbit is doing.

By default it is a small capsule: grey when nothing runs, the working colour while an agent works,
amber when a session is paused, dim when the broker is off. It blinks once when a session or an
application appears. Resting the pointer on it opens a card per session; clicking a card opens the
viewer. A left click on the mark opens the viewer, a right click opens a settings window covering
the edge and monitor, the shape, the size, a colour for each state, the working frame, desktop
notifications and the blink. Everything is adjustable and persists in the person's config.

It is a wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks that
protocol, and it stays out of the person's windows. It talks to the broker over the same Unix socket
the CLI uses and asks only for lists and presence, never a frame. Measured on this workstation it
costs 0.1% of one core and the broker 0.135 ms of CPU a second. The panel is the person's own
desktop process and runs outside Orbit's shared budget on purpose.

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

# A capsule needs no GPU. The Cairo renderer is the cheapest GTK 4 has, and it is the one that works
# on a software-rendered display too, where the GPU renderers retry failing surfaces in a loop.
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

FRAME_WIDTH = 3
OPEN_DELAY_MS = 220
CLOSE_DELAY_MS = 320
PRESENCE_WHILE_COLLAPSED_S = 10
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}
EDGE_LABELS = {"left": "Left", "right": "Right", "top": "Top", "bottom": "Bottom"}
STYLES = ("bar", "dot", "count")
SHAPE_LABELS = ["capsule", "dot", "dot with count"]
STATE_KEYS = ("idle", "working", "paused", "offline")
DEFAULT_SETTINGS = {
    "edge": "right",
    "monitor": None,
    "style": "bar",
    "size": 12,
    "margin": 8,
    "colors": {"idle": "#8a8a8a", "working": "#4caf50", "paused": "#ff9800", "offline": "#585858"},
    "notifications": True,
    "blink": True,
    "frame": True,
    "frameColor": "#4caf50",
    "hideWhenIdle": False,
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
.orbit-shell { background: transparent; }
.orbit-plate { padding: 6px; border-radius: 16px; background: alpha(@window_bg_color, 0.96);
  color: @window_fg_color; box-shadow: 0 2px 14px alpha(black, 0.28); }
.orbit-bar, .orbit-dot { border-radius: 999px; }
.orbit-bar.blink, .orbit-dot.blink, .orbit-count.blink { animation: orbit-blink 380ms ease-in-out 2; }
.orbit-count { border-radius: 999px; font-weight: 700; padding: 0 7px; color: white; }
.orbit-card { padding: 8px 10px; border-radius: 12px; }
.orbit-card:hover { background: alpha(@window_fg_color, 0.09); }
.orbit-title { font-weight: 600; }
.orbit-dim { opacity: 0.65; font-size: 90%; }
.orbit-chip { font-size: 80%; font-weight: 600; padding: 1px 7px; border-radius: 8px; }
.orbit-foot button { padding: 2px 10px; border-radius: 999px; font-size: 90%; }
.orbit-frame.background, .orbit-frame box { background: transparent; background-color: transparent; }
.orbit-frame box.on { background: @orbit-frame-color; }
window.orbit-clear.background { background: transparent; background-color: transparent; }
"""


def dynamic_css(settings):
    colors = settings["colors"]
    size = max(6, int(settings["size"]))
    # A capsule lies along the edge it is docked to: tall on a side edge, wide on a top or bottom one.
    thickness, length = max(3, round(size * 0.42)), max(12, round(size * 2.4))
    if settings["edge"] in ("top", "bottom"):
        thickness, length = length, thickness
    # Transparent padding around the mark. The capsule stays a few pixels wide while the pointer gets
    # a target it can actually hit without aiming at the very edge of the screen.
    lines = [
        f".orbit-shell {{ padding: {max(6, size)}px; }}",
        f".orbit-bar {{ min-width: {thickness}px; min-height: {length}px; }}",
        f".orbit-dot {{ min-width: {size}px; min-height: {size}px; }}",
        f".orbit-count {{ min-width: {size + 8}px; min-height: {size + 6}px; font-size: {max(9, size - 2)}px; }}",
        f"@define-color orbit-frame-color {settings['frameColor']};",
    ]
    for key in STATE_KEYS:
        for widget in (".orbit-bar", ".orbit-dot", ".orbit-count"):
            lines.append(f"{widget}.{key} {{ background: {colors[key]}; }}")
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


def request_once(connection, method, params):
    connection.request("POST", "/rpc", body=json.dumps({"method": method, "params": params or {}}),
                       headers={"Content-Type": "application/json"})
    payload = json.loads(connection.getresponse().read(1 << 20))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error", {}).get("message", "Broker request failed"))
    return payload["result"]


def rpc(path, method, params=None):
    """One off, for the main thread. The poll loop uses BrokerClient instead."""
    connection = UnixConnection(path)
    try:
        return request_once(connection, method, params)
    finally:
        connection.close()


class BrokerClient:
    """One connection held open for the poll loop. A fresh connection per call cost two socket
    lifetimes a second and doubled the latency of every presence read: measured, a kept connection
    takes a presence call from 0.39 ms to 0.19 ms. Used from the poll thread only."""

    def __init__(self, path):
        self.path = path
        self.connection = None

    def call(self, method, params=None):
        for attempt in (0, 1):
            try:
                if self.connection is None:
                    self.connection = UnixConnection(self.path)
                    self.connection.connect()
                return request_once(self.connection, method, params)
            except RuntimeError:
                raise
            except Exception:
                # A broker restart or an idle timeout closes the socket under us; reconnect once.
                self.close()
                if attempt:
                    raise
        return None

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
            self.connection = None


def broker_socket():
    if os.environ.get("ORBIT_SOCKET"):
        return os.environ["ORBIT_SOCKET"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


def read_status(client, with_presence=True):
    """The session list, and presence only when something is going to read it. The collapsed mark
    takes its colour from the list alone, so presence is one call per session that nobody sees."""
    sessions = [s for s in client.call("session.list") if isinstance(s, dict) and s.get("state") not in ("closed", "closing")]
    for session in sessions:
        session["presence"] = None
        if with_presence:
            try:
                presence = client.call("session.presence", {"sessionId": session["sessionId"]})
                session["presence"] = presence if isinstance(presence, dict) else None
            except Exception:
                pass
    return sessions


def viewer_link_is_local(url):
    """The only link the panel will open: the broker's own loopback viewer with its token fragment."""
    return isinstance(url, str) and url.startswith("http://127.0.0.1:") and "#" in url and len(url.split("#", 1)[1]) >= 32


def load_settings():
    """The person's choices, under their config directory; command line flags override them for one run."""
    settings = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_SETTINGS.items()}
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            stored = json.load(handle)
    except FileNotFoundError:
        return settings
    except (OSError, ValueError) as error:
        # Say so rather than silently reverting every choice the person made.
        print(f"panel: could not read {SETTINGS_PATH} ({error}); using defaults and leaving the file alone", file=sys.stderr)
        return settings
    if isinstance(stored, dict):
        for key in DEFAULT_SETTINGS:
            if key not in stored:
                continue
            if key == "colors" and isinstance(stored[key], dict):
                settings[key].update({k: v for k, v in stored[key].items() if k in STATE_KEYS and isinstance(v, str)})
            else:
                settings[key] = stored[key]
    if settings["edge"] not in EDGES:
        settings["edge"] = DEFAULT_SETTINGS["edge"]
    if settings["style"] not in STYLES:
        settings["style"] = DEFAULT_SETTINGS["style"]
    return settings


def save_settings(settings):
    """Written beside the real file and renamed over it. A truncating write that is interrupted
    leaves an empty file, which reads back as no settings at all."""
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), mode=0o700, exist_ok=True)
        temporary = SETTINGS_PATH + ".new"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({k: settings[k] for k in DEFAULT_SETTINGS}, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, SETTINGS_PATH)
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
    """What the mark and the cards actually read. Comparing this instead of the whole payload keeps a
    live pointer position or an activity counter from rebuilding the cards under the person's hand."""
    return {s["sessionId"]: (s.get("agentName", "Agent"), s.get("taskName", ""), s.get("state", ""),
                             (s.get("activity") or {}).get("state", ""), (s.get("activity") or {}).get("type", ""),
                             (s.get("presence") or {}).get("title", ""), len((s.get("presence") or {}).get("tabs") or []))
            for s in sessions if isinstance(s.get("sessionId"), str)}


def start(widget):
    """Align to the start of the line, which is the right in a right to left locale."""
    widget.set_halign(Gtk.Align.START)
    return widget


def label(text, *classes):
    text_label = Gtk.Label(label=text)
    start(text_label)
    text_label.set_ellipsize(3)
    text_label.set_max_width_chars(34)
    for name in classes:
        text_label.add_css_class(name)
    return text_label


class Panel(Gtk.Application):
    def __init__(self, settings):
        super().__init__(application_id="io.sbar.orbit.panel", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.settings = settings
        self.frame = []
        self.frame_shown = False
        self.path = broker_socket()
        self.client = BrokerClient(self.path)
        self.sessions = []
        self.reachable = False
        self.expanded = False
        self.cards_stale = True
        self.last_shape = None
        self.known = None
        self.hover = None
        self.open_source = None
        self.close_source = None
        self.blink_source = None
        self.save_source = None
        self.settings_window = None
        self.window = None
        self.dynamic_provider = None
        self.stopping = False
        self.wake = threading.Event()
        self.presence_due = 0.0

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

    def do_shutdown(self):
        self.stopping = True
        self.wake.set()
        if self.save_source is not None:
            GLib.source_remove(self.save_source)
            self.save_source = None
            save_settings(self.settings)
        Gtk.Application.do_shutdown(self)

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
        # On demand, so a click can reach the cards with a keyboard; the panel never takes focus by itself.
        LayerShell.set_keyboard_mode(window, LayerShell.KeyboardMode.ON_DEMAND)
        self.window = window

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
        self.mark.update_property([Gtk.AccessibleProperty.LABEL], ["Sbar Orbit sessions"])
        self.bar = Gtk.Box()
        self.bar.add_css_class("orbit-bar")
        self.dot = Gtk.Box()
        self.dot.add_css_class("orbit-dot")
        self.count = Gtk.Label(label="0")
        self.count.add_css_class("orbit-count")
        for widget in (self.bar, self.dot, self.count):
            self.mark.append(widget)

        # The cards live on their own rounded plate, so the mark keeps no background of its own and
        # the surface stays transparent where there is nothing to show.
        self.plate = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.plate.add_css_class("orbit-plate")
        self.plate.set_visible(False)
        # Room for a name and a window title. Without a floor the cards squeeze to the width of the
        # capsule and every line reads as three words and an ellipsis.
        self.plate.set_size_request(280, -1)
        self.details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroller.set_propagate_natural_height(True)
        scroller.set_max_content_height(420)
        scroller.set_child(self.details)
        self.plate.append(scroller)
        self.plate.append(self.footer())

        # The mark sits at the anchored end so the cards grow away from it and it never slides out
        # from under the pointer as the surface changes size.
        if self.settings["edge"] == "bottom":
            self.shell.append(self.plate)
            self.shell.append(self.mark)
        else:
            self.shell.append(self.mark)
            self.shell.append(self.plate)

        self.hover = Gtk.EventControllerMotion()
        self.hover.connect("notify::contains-pointer", lambda controller, _: self.hover_changed(controller.get_property("contains-pointer")))
        self.shell.add_controller(self.hover)
        opening = Gtk.GestureClick(button=1)
        opening.connect("pressed", lambda *_: self.open_viewer())
        self.mark.add_controller(opening)
        menu = Gtk.GestureClick(button=3)
        menu.connect("pressed", lambda *_: self.open_settings())
        self.shell.add_controller(menu)

        window.set_child(self.shell)
        self.anchor(window)
        window.present()
        self.apply_style()
        threading.Thread(target=self.poll_loop, daemon=True).start()

    @staticmethod
    def install_css(display, data, priority):
        provider = Gtk.CssProvider()
        provider.load_from_data(data)
        Gtk.StyleContext.add_provider_for_display(display, provider, priority)
        return provider

    def footer(self):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        row.add_css_class("orbit-foot")
        viewer = Gtk.Button(label="Viewer")
        viewer.add_css_class("flat")
        viewer.connect("clicked", lambda *_: self.open_viewer())
        settings = Gtk.Button(label="Settings")
        settings.add_css_class("flat")
        settings.connect("clicked", lambda *_: self.open_settings())
        row.append(viewer)
        row.append(settings)
        return row

    # --- Placement -------------------------------------------------------------------------------

    def monitor_for(self, window):
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
                return monitor
            if chosen is None or pixels(monitor) > pixels(chosen):
                chosen = monitor
        return chosen

    def anchor(self, window):
        """Dock the mark to the chosen edge, and pin the surface to one end of that edge with a margin
        that centres the mark. Anchored to a single edge the compositor centres the whole surface, so
        the mark would jump by half the height of the cards every time they opened."""
        monitor = self.monitor_for(window)
        if monitor is not None:
            LayerShell.set_monitor(window, monitor)
        edge = self.settings["edge"]
        vertical = edge in ("left", "right")
        pin = "bottom" if edge == "bottom" else ("top" if vertical else "left")
        for name, value in EDGES.items():
            LayerShell.set_anchor(window, value, name in (edge, pin))
            LayerShell.set_margin(window, value, 0)
        LayerShell.set_margin(window, EDGES[edge], max(0, int(self.settings["margin"])))
        if monitor is not None:
            geometry = monitor.get_geometry()
            span = geometry.height if vertical else geometry.width
            size = max(6, int(self.settings["size"]))
            extent = (size * 2.4 if vertical else size) + size * 2
            LayerShell.set_margin(window, EDGES[pin], max(0, round((span - extent) / 2)))

    def relocate(self):
        """Applied live from the settings: the mark moves, and the frame follows it to the monitor."""
        if self.window is None:
            return
        self.anchor(self.window)
        for strip in self.frame:
            monitor = self.monitor_for(strip)
            if monitor is not None:
                LayerShell.set_monitor(strip, monitor)

    def build_frame(self):
        """The frame shown around the output while an agent works. Four strips a few pixels wide cost
        a few hundred kilobytes of buffer between them, where one surface covering the output would
        cost tens of megabytes for a transparent centre. Each strip is click through: its input region
        is empty, so pointer events reach what is underneath."""
        for edge in EDGES.values():
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
            monitor = self.monitor_for(strip)
            if monitor is not None:
                LayerShell.set_monitor(strip, monitor)
            body = Gtk.Box()
            body.add_css_class("on")
            body.set_size_request(FRAME_WIDTH, FRAME_WIDTH)
            strip.set_child(body)

            def passthrough(mapped):
                surface = mapped.get_surface()
                if surface is not None:
                    surface.set_input_region(cairo.Region())

            strip.connect("realize", passthrough)
            self.frame.append(strip)

    # --- Polling ---------------------------------------------------------------------------------

    def interval(self):
        """How long to wait before the next look. One second while the person is watching or an agent
        is acting, slower when nothing is happening: the same information, a third of the calls."""
        if self.expanded or any((s.get("activity") or {}).get("state") == "working" for s in self.sessions):
            return 1.0
        if self.sessions:
            return 2.0
        return 3.0 if self.reachable else 5.0

    def poll_loop(self):
        """One worker for the life of the panel. A thread per tick measured 0.37 ms of pure overhead
        every second, a third of everything the panel spent."""
        while not self.stopping:
            want_presence = self.expanded or GLib.get_monotonic_time() / 1e6 >= self.presence_due
            try:
                sessions = read_status(self.client, want_presence)
                reachable = True
            except Exception:
                self.client.close()
                sessions, reachable = [], False
            if want_presence:
                self.presence_due = GLib.get_monotonic_time() / 1e6 + PRESENCE_WHILE_COLLAPSED_S
            elif sessions:
                # Carry the last presence forward so the cards and the counts do not blink to empty.
                carried = {s.get("sessionId"): s.get("presence") for s in self.sessions}
                for session in sessions:
                    session["presence"] = carried.get(session.get("sessionId"))
            GLib.idle_add(self.apply_status, sessions, reachable)
            self.wake.wait(self.interval())
            self.wake.clear()
        self.client.close()

    def apply_status(self, sessions, reachable):
        self.sessions, self.reachable = sessions, reachable
        shape = (session_shape(sessions), reachable)
        try:
            if shape != self.last_shape:
                self.last_shape = shape
                self.render()
                self.announce()
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
        for session_id, fields in current.items():
            agent, task, tabs = fields[0], fields[1], fields[6]
            if session_id not in self.known:
                events.append((f"{agent} started", task or "a new session"))
            elif tabs > self.known[session_id][6]:
                events.append((f"{agent} opened {fields[5] or 'a new window'}", task))
        for session_id, fields in self.known.items():
            if session_id not in current:
                events.append((f"{fields[0]} finished", fields[1]))
        self.known = current
        if not events:
            return
        if self.settings["blink"]:
            self.blink()
        if self.settings["notifications"]:
            for title, body in events[:3]:
                notify(title, body)

    def blink(self):
        target = self.mark_widget()
        target.remove_css_class("blink")
        if self.blink_source is not None:
            GLib.source_remove(self.blink_source)
        GLib.idle_add(lambda t=target: (t.add_css_class("blink"), False)[1])
        self.blink_source = GLib.timeout_add(820, lambda t=target: self.end_blink(t))

    def end_blink(self, target):
        target.remove_css_class("blink")
        self.blink_source = None
        return False

    # --- Rendering -------------------------------------------------------------------------------

    def mark_widget(self):
        return {"bar": self.bar, "dot": self.dot}.get(self.settings["style"], self.count)

    def state_of(self):
        if not self.reachable:
            return "offline"
        if any((s.get("activity") or {}).get("state") == "working" for s in self.sessions):
            return "working"
        if any(s.get("state") == "paused" for s in self.sessions):
            return "paused"
        return "idle"

    def apply_style(self):
        """Reload the colours and sizes, and show the shape the person chose."""
        if self.dynamic_provider is not None:
            self.dynamic_provider.load_from_data(dynamic_css(self.settings))
        for style, widget in (("bar", self.bar), ("dot", self.dot), ("count", self.count)):
            widget.set_visible(self.settings["style"] == style)
        self.render()

    def render(self):
        state = self.state_of()
        for widget in (self.bar, self.dot, self.count):
            for key in STATE_KEYS:
                widget.remove_css_class(key)
            widget.add_css_class(state)
        self.count.set_text("0" if state == "offline" else str(len(self.sessions)))
        self.mark.set_visible(not (self.settings["hideWhenIdle"] and state in ("idle", "offline")))
        self.sync_frame()
        self.cards_stale = True
        if self.expanded:
            self.fill_cards()

    def fill_cards(self):
        """One card per session, built when the list is about to be shown. Building them on every poll
        behind a hidden box was a screenful of widgets a second that nobody ever saw, and rebuilding
        them under the pointer took the highlight off the card the person was about to click."""
        child = self.details.get_first_child()
        while child is not None:
            following = child.get_next_sibling()
            self.details.remove(child)
            child = following
        if not self.sessions:
            self.details.append(label("Orbit is not running" if not self.reachable else "No agent is working", "orbit-dim"))
        for session in self.sessions:
            self.details.append(self.card(session))
        self.cards_stale = False

    def card(self, session):
        presence = session.get("presence") or {}
        activity = session.get("activity") or {}
        button = Gtk.Button()
        button.add_css_class("orbit-card")
        button.add_css_class("flat")
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        name = label(session.get("agentName", "Agent"), "orbit-title")
        name.set_hexpand(True)
        head.append(name)
        state = session.get("state", "")
        working = activity.get("state") == "working"
        chip = Gtk.Label(label="working" if working else state)
        chip.add_css_class("orbit-chip")
        chip.add_css_class("working" if working else ("paused" if state == "paused" else "idle"))
        head.append(chip)
        column.append(head)
        column.append(label(session.get("taskName", "")))
        tabs = presence.get("tabs") or []
        active = next((t for t in tabs if isinstance(t, dict) and t.get("active")), None)
        kind = "windows" if session.get("backend") == "fedora" else "tabs"
        parts = [presence.get("title") or session.get("backend", "")]
        if tabs:
            parts.append(f"{active.get('tab', '?') if active else '?'} of {len(tabs)} {kind}")
        if activity:
            parts.append(activity.get("type", ""))
        # Isolated so a window title in Arabic and a count in English keep their own direction.
        column.append(label("  ·  ".join(f"⁨{p}⁩" for p in parts if p), "orbit-dim"))
        button.set_child(column)
        button.update_property([Gtk.AccessibleProperty.LABEL], [f"{session.get('agentName', 'Agent')}: {session.get('taskName', '')}"])
        button.connect("clicked", lambda *_: self.open_viewer())
        return button

    def sync_frame(self, force=False):
        working = any((s.get("activity") or {}).get("state") == "working" for s in self.sessions)
        wanted = working and bool(self.settings["frame"])
        if wanted and not self.frame:
            self.build_frame()
        if self.frame and (force or self.frame_shown != wanted):
            self.frame_shown = wanted
            for strip in self.frame:
                strip.set_visible(wanted)

    # --- Hover -----------------------------------------------------------------------------------

    def hover_changed(self, inside):
        """A delay each way. Without it, a pointer crossing the edge of the screen on its way
        somewhere else opens and closes the whole card list in a flicker."""
        for attribute in ("open_source", "close_source"):
            source = getattr(self, attribute)
            if source is not None:
                GLib.source_remove(source)
                setattr(self, attribute, None)
        if inside:
            self.open_source = GLib.timeout_add(OPEN_DELAY_MS, self.finish_open)
        else:
            self.close_source = GLib.timeout_add(CLOSE_DELAY_MS, self.finish_close)

    def finish_open(self):
        self.open_source = None
        self.set_expanded(True)
        return False

    def finish_close(self):
        self.close_source = None
        # The pointer is read again rather than trusted: a surface that resizes under the pointer can
        # swallow the crossing event that would have closed this.
        if self.hover is not None and self.hover.get_property("contains-pointer"):
            return False
        self.set_expanded(False)
        return False

    def set_expanded(self, expanded):
        if expanded == self.expanded and not (expanded and self.cards_stale):
            return
        self.expanded = expanded
        if expanded:
            self.fill_cards()
            # Ask for presence at once, so the cards do not open showing a ten second old title.
            self.wake.set()
        self.plate.set_visible(expanded)

    # --- Actions ---------------------------------------------------------------------------------

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

    def change(self, key, value, restyle=True):
        self.settings[key] = value
        self.schedule_save()
        if key in ("edge", "monitor", "margin", "size"):
            self.relocate()
        if restyle:
            self.apply_style()
        self.sync_frame(force=True)

    def schedule_save(self):
        """A drag along the size slider fires on every pixel. Writing the file once when the hand
        stops keeps a settings window from being a stream of writes to the disk."""
        if self.save_source is not None:
            GLib.source_remove(self.save_source)
        self.save_source = GLib.timeout_add(400, self.flush_save)

    def flush_save(self):
        self.save_source = None
        save_settings(self.settings)
        return False

    def reset(self):
        self.settings = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_SETTINGS.items()}
        self.schedule_save()
        self.relocate()
        self.apply_style()
        self.sync_frame(force=True)
        if self.settings_window is not None:
            self.settings_window.close()
            self.open_settings()

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
        super().__init__(title="Orbit panel settings")
        self.panel = panel
        self.set_default_size(400, 660)
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin_top=18, margin_bottom=18, margin_start=18, margin_end=18)

        outer.append(self.group("Placement", [
            self.dropdown_row("Screen edge", [EDGE_LABELS[e] for e in EDGES], EDGE_LABELS[panel.settings["edge"]],
                              lambda v: panel.change("edge", next(e for e in EDGES if EDGE_LABELS[e] == v))),
            self.monitor_row(),
            self.scale_row("Distance from the edge", 0, 64, panel.settings["margin"], lambda v: panel.change("margin", v)),
        ]))
        outer.append(self.group("The mark", [
            self.dropdown_row("Shape", SHAPE_LABELS, SHAPE_LABELS[STYLES.index(panel.settings["style"])],
                              lambda v: panel.change("style", STYLES[SHAPE_LABELS.index(v)])),
            self.scale_row("Size", 8, 22, panel.settings["size"], lambda v: panel.change("size", v)),
            self.switch_row("Hide it while nothing runs", panel.settings["hideWhenIdle"], lambda v: panel.change("hideWhenIdle", v)),
            self.color_row("Working colour", "working"),
            self.color_row("Paused colour", "paused"),
            self.color_row("Idle colour", "idle"),
            self.color_row("Colour when Orbit is off", "offline"),
        ]))
        outer.append(self.group("Working frame", [
            self.switch_row("Frame the screen while working", panel.settings["frame"], lambda v: panel.change("frame", v)),
            self.row("Frame colour", self.color_button(panel.settings["frameColor"], lambda hexv: panel.change("frameColor", hexv))),
        ]))
        outer.append(self.group("Notifications", [
            self.switch_row("Desktop notifications", panel.settings["notifications"], lambda v: panel.change("notifications", v, restyle=False)),
            self.switch_row("Blink when something happens", panel.settings["blink"], lambda v: panel.change("blink", v, restyle=False)),
        ]))

        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        viewer = Gtk.Button(label="Open the viewer")
        viewer.set_hexpand(True)
        viewer.connect("clicked", lambda *_: panel.open_viewer())
        reset = Gtk.Button(label="Reset to defaults")
        reset.connect("clicked", lambda *_: panel.reset())
        buttons.append(viewer)
        buttons.append(reset)
        outer.append(buttons)
        outer.append(start(label(f"Saved in {SETTINGS_PATH}", "orbit-dim")))
        outer.append(start(label("A right click on the mark opens this window. A left click opens the viewer.", "orbit-dim")))

        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroller.set_child(outer)
        self.set_child(scroller)

        # Escape closes a preferences window everywhere else on this desktop.
        escape = Gtk.ShortcutController()
        escape.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("Escape"),
                                             Gtk.CallbackAction.new(lambda *_: (self.close(), True)[1])))
        self.add_controller(escape)

    def group(self, title, rows):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.append(label(title, "heading"))
        listbox = Gtk.ListBox()
        listbox.add_css_class("boxed-list")
        listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        for row in rows:
            listbox.append(row)
        box.append(listbox)
        return box

    def row(self, text, control):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, margin_top=8, margin_bottom=8, margin_start=12, margin_end=12)
        name = label(text)
        name.set_hexpand(True)
        row.append(name)
        control.set_valign(Gtk.Align.CENTER)
        # Without this a screen reader announces "switch" and "slider" with no idea what they change.
        # The label is copied onto the control rather than related to it, because the relation form
        # that takes a list of accessibles does not marshal correctly through PyGObject.
        control.update_property([Gtk.AccessibleProperty.LABEL], [text])
        row.append(control)
        return row

    def switch_row(self, text, value, on_change):
        switch = Gtk.Switch(active=bool(value))
        switch.connect("state-set", lambda _s, state: (on_change(state), False)[1])
        return self.row(text, switch)

    def dropdown_row(self, text, options, current, on_change):
        model = Gtk.StringList()
        for option in options:
            model.append(option)
        drop = Gtk.DropDown(model=model)
        drop.set_selected(options.index(current) if current in options else 0)
        drop.connect("notify::selected", lambda d, _: on_change(options[d.get_selected()]))
        return self.row(text, drop)

    def scale_row(self, text, low, high, value, on_change):
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, low, high, 1)
        scale.set_value(value)
        scale.set_size_request(160, -1)
        scale.set_draw_value(True)
        scale.connect("value-changed", lambda s: on_change(int(s.get_value())))
        return self.row(text, scale)

    def monitor_row(self):
        """Every monitor by its connector name, which is what the person reads on their own screen
        layout, with the value stored being that same name so the choice survives a restart."""
        names, values = ["Largest screen"], [None]
        window = self.panel.window
        if window is not None:
            monitors = window.get_display().get_monitors()
            for index in range(monitors.get_n_items()):
                monitor = monitors.get_item(index)
                connector = monitor.get_connector() or str(index)
                geometry = monitor.get_geometry()
                names.append(f"{connector} ({geometry.width} by {geometry.height})")
                values.append(connector)
        current = self.panel.settings["monitor"]
        current = str(current) if current is not None else None
        chosen = names[values.index(current)] if current in values else names[0]
        return self.dropdown_row("Monitor", names, chosen, lambda v: self.panel.change("monitor", values[names.index(v)]))

    def color_row(self, text, key):
        return self.row(text, self.color_button(self.panel.settings["colors"][key], lambda hexv: self.set_color(key, hexv)))

    def color_button(self, current, on_change):
        rgba = Gdk.RGBA()
        if not rgba.parse(current):
            rgba.parse("#808080")
        dialog = Gtk.ColorDialog()
        dialog.set_with_alpha(False)
        button = Gtk.ColorDialogButton(dialog=dialog)
        button.set_rgba(rgba)
        button.connect("notify::rgba", lambda b, _: on_change(rgba_to_hex(b.get_rgba())))
        return button

    def set_color(self, key, hex_value):
        colors = dict(self.panel.settings["colors"])
        colors[key] = hex_value
        self.panel.change("colors", colors)


def rgba_to_hex(rgba):
    return "#%02x%02x%02x" % (round(rgba.red * 255), round(rgba.green * 255), round(rgba.blue * 255))


def main():
    settings = load_settings()
    args = sys.argv[1:]
    open_settings = False
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
        elif flag == "--settings":
            open_settings = True
        elif flag in ("-h", "--help"):
            print("usage: sbar-orbit panel [--edge left|right|top|bottom] [--monitor N|CONNECTOR] [--style bar|dot|count]")
            print("                        [--frame|--no-frame] [--frame-color CSS] [--no-notifications] [--settings]")
            print(f"settings persist in {SETTINGS_PATH}; a right click on the mark opens the settings window")
            return 0
    panel = Panel(settings)
    if open_settings:
        panel.connect("activate", lambda *_: GLib.idle_add(panel.open_settings))
    panel.run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
