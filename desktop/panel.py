"""A small always-visible strip on a screen edge that says what Orbit is doing.

Collapsed it shows a dot and a count. Hovering expands it into the session list: who is working,
on what, in which tab or window, and how many of each. Clicking a session opens its viewer.

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
INDICATOR_COLOR = "#4caf50"
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}

# The panel is drawn in the person's own colour names when their theme defines them, the way a
# libadwaita application is, and in GTK's defaults otherwise. The person's gtk.css is loaded at user
# priority, above this, so their definitions of these names win over the fallbacks below.
CSS = b"""
@define-color window_bg_color @theme_bg_color;
@define-color window_fg_color @theme_fg_color;
@define-color accent_bg_color @theme_selected_bg_color;
.orbit-panel { background: alpha(@window_bg_color, 0.92); color: @window_fg_color; border-radius: 12px; padding: 6px; }
.orbit-strip { padding: 2px 6px; }
.orbit-dot { min-width: 10px; min-height: 10px; border-radius: 5px; background: @insensitive_fg_color; }
.orbit-dot.working { background: #4caf50; }
.orbit-dot.paused { background: #ff9800; }
.orbit-count { font-weight: bold; }
.orbit-session { padding: 6px 8px; border-radius: 8px; }
.orbit-session:hover { background: alpha(@window_fg_color, 0.08); }
.orbit-title { font-weight: bold; }
.orbit-dim { opacity: 0.7; font-size: 90%; }
"""
INDICATOR_CSS = b"""
window.orbit-indicator.background, window.orbit-indicator drawingarea { background: transparent; background-color: transparent; }
"""


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


class Panel(Gtk.Application):
    def __init__(self, edge, monitor, indicator=False, indicator_color=INDICATOR_COLOR):
        super().__init__(application_id="io.sbar.orbit.panel", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.edge = edge
        self.monitor = monitor
        self.indicator = None
        self.indicator_wanted = indicator
        self.indicator_color = Gdk.RGBA()
        if not self.indicator_color.parse(indicator_color):
            self.indicator_color.parse(INDICATOR_COLOR)
        self.path = broker_socket()
        self.sessions = []
        self.reachable = False
        self.expanded = False
        self.last_shape = None
        self.polling = False

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Off the desktop, inside a private display for instance, there is no portal to say the
        # colour scheme; follow the same variable the session's applications follow. It is set
        # before any window exists, so the theme's colour scheme media queries see it.
        if os.environ.get("ADW_DEBUG_COLOR_SCHEME") == "prefer-dark":
            settings = Gtk.Settings.get_default()
            settings.set_property("gtk-application-prefer-dark-theme", True)
            # GTK 4.20 and later answer the theme's colour scheme media queries from this setting.
            if settings.find_property("gtk-interface-color-scheme") is not None:
                settings.set_property("gtk-interface-color-scheme", Gtk.InterfaceColorScheme.DARK)

    def do_activate(self):
        window = Gtk.Window(application=self)
        window.set_title("Orbit")
        if not LayerShell.is_supported():
            print("wlr-layer-shell is not available: either this compositor does not offer it, or libgtk4-layer-shell is not installed", file=sys.stderr)
            self.quit()
            return
        LayerShell.init_for_window(window)
        LayerShell.set_layer(window, LayerShell.Layer.TOP)
        LayerShell.set_namespace(window, "sbar-orbit-panel")
        LayerShell.set_anchor(window, EDGES[self.edge], True)
        LayerShell.set_margin(window, EDGES[self.edge], 8)
        if self.monitor is not None:
            monitors = window.get_display().get_monitors()
            if self.monitor < monitors.get_n_items():
                LayerShell.set_monitor(window, monitors.get_item(self.monitor))

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(window.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        # Above the person's own gtk.css, which may paint every window: the indicator frame must
        # stay transparent whatever their theme says, or it would cover the screen it decorates.
        overlay = Gtk.CssProvider()
        overlay.load_from_data(INDICATOR_CSS)
        Gtk.StyleContext.add_provider_for_display(window.get_display(), overlay, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)

        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.box.add_css_class("orbit-panel")
        strip = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        strip.add_css_class("orbit-strip")
        self.dot = Gtk.Box()
        self.dot.add_css_class("orbit-dot")
        self.dot.set_valign(Gtk.Align.CENTER)
        self.count = Gtk.Label(label="")
        self.count.add_css_class("orbit-count")
        strip.append(self.dot)
        strip.append(self.count)
        self.box.append(strip)
        self.details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.details.set_visible(False)
        self.box.append(self.details)

        hover = Gtk.EventControllerMotion()
        hover.connect("enter", lambda *_: self.set_expanded(True))
        hover.connect("leave", lambda *_: self.set_expanded(False))
        self.box.add_controller(hover)

        window.set_child(self.box)
        window.present()
        self.window = window
        if self.indicator_wanted:
            self.indicator = self.build_indicator()
        self.refresh()
        GLib.timeout_add(int(POLL_SECONDS * 1000), self.refresh)

    def build_indicator(self):
        """A frame around the whole output while an agent works: static, click-through, drawn once
        per state change, so it costs nothing while nothing changes. The centre is transparent and
        outside the input region, so every pointer event reaches whatever is underneath."""
        frame = Gtk.Window(application=self)
        frame.set_title("Orbit working")
        frame.add_css_class("orbit-indicator")
        LayerShell.init_for_window(frame)
        LayerShell.set_layer(frame, LayerShell.Layer.OVERLAY)
        LayerShell.set_namespace(frame, "sbar-orbit-indicator")
        for edge in EDGES.values():
            LayerShell.set_anchor(frame, edge, True)
        LayerShell.set_exclusive_zone(frame, -1)
        LayerShell.set_keyboard_mode(frame, LayerShell.KeyboardMode.NONE)
        if self.monitor is not None:
            monitors = frame.get_display().get_monitors()
            if self.monitor < monitors.get_n_items():
                LayerShell.set_monitor(frame, monitors.get_item(self.monitor))
        area = Gtk.DrawingArea()
        area.set_draw_func(self.draw_indicator)
        frame.set_child(area)

        def passthrough(*_):
            surface = frame.get_surface()
            if surface is not None:
                surface.set_input_region(cairo.Region())

        frame.connect("realize", passthrough)
        frame.connect("map", passthrough)
        return frame

    def draw_indicator(self, area, context, width, height):
        color = self.indicator_color
        context.set_source_rgba(color.red, color.green, color.blue, color.alpha)
        context.set_line_width(INDICATOR_WIDTH * 2)
        context.rectangle(0, 0, width, height)
        context.stroke()

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
                self.last_shape = shape
        except Exception as error:
            print(f"panel: could not render status: {error}", file=sys.stderr)
        return False

    def set_expanded(self, expanded):
        self.expanded = expanded
        self.details.set_visible(expanded and bool(self.sessions))

    def render(self):
        working = sum(1 for s in self.sessions if (s.get("activity") or {}).get("state") == "working")
        paused = sum(1 for s in self.sessions if s.get("state") == "paused")
        for name in ("working", "paused"):
            self.dot.remove_css_class(name)
        if working:
            self.dot.add_css_class("working")
        elif paused:
            self.dot.add_css_class("paused")
        if self.indicator is not None:
            self.indicator.set_visible(working > 0)
        tabs = sum(len((s.get("presence") or {}).get("tabs") or []) for s in self.sessions)
        if not self.reachable:
            self.count.set_text("off")
            self.count.set_tooltip_text("Orbit broker is not running")
        elif not self.sessions:
            self.count.set_text("0")
            self.count.set_tooltip_text("No Orbit sessions")
        else:
            self.count.set_text(f"{len(self.sessions)}/{tabs}")
            self.count.set_tooltip_text(f"{len(self.sessions)} sessions, {tabs} tabs or windows, {working} working")

        child = self.details.get_first_child()
        while child is not None:
            following = child.get_next_sibling()
            self.details.remove(child)
            child = following
        for session in self.sessions:
            self.details.append(self.row(session))
        self.details.set_visible(self.expanded and bool(self.sessions))

    def row(self, session):
        presence = session.get("presence") or {}
        activity = session.get("activity") or {}
        button = Gtk.Button()
        button.add_css_class("orbit-session")
        button.add_css_class("flat")
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        head = Gtk.Label(label=f"{session.get('agentName', 'Agent')} · {session.get('taskName', '')}", xalign=0)
        head.add_css_class("orbit-title")
        head.set_ellipsize(3)
        head.set_max_width_chars(36)
        column.append(head)
        where = Gtk.Label(label=presence.get("title") or session.get("backend", ""), xalign=0)
        where.set_ellipsize(3)
        where.set_max_width_chars(40)
        column.append(where)
        tabs = presence.get("tabs") or []
        active = next((t for t in tabs if isinstance(t, dict) and t.get("active")), None)
        kind = "window" if session.get("backend") == "fedora" else "tab"
        state = session.get("state", "")
        doing = f"{activity.get('type', 'idle')} · {activity.get('state', '')}" if activity else "idle"
        parts = [state, doing]
        if tabs:
            parts.append(f"{kind} {active.get('tab', '?') if active else '?'} of {len(tabs)}")
        pointer = presence.get("pointer")
        if isinstance(pointer, dict) and "x" in pointer and "y" in pointer:
            parts.append(f"pointer {pointer['x']},{pointer['y']}")
        meta = Gtk.Label(label=" · ".join(p for p in parts if p), xalign=0)
        meta.add_css_class("orbit-dim")
        column.append(meta)
        button.set_child(column)
        button.connect("clicked", lambda *_: self.open_viewer(session["sessionId"]))
        return button

    def open_viewer(self, session_id):
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
    edge = "right"
    monitor = None
    indicator = False
    color = INDICATOR_COLOR
    args = sys.argv[1:]
    while args:
        flag = args.pop(0)
        if flag == "--edge" and args and args[0] in EDGES:
            edge = args.pop(0)
        elif flag == "--monitor" and args and args[0].isdigit():
            monitor = int(args.pop(0))
        elif flag == "--indicator":
            indicator = True
        elif flag == "--indicator-color" and args:
            color = args.pop(0)
        elif flag in ("-h", "--help"):
            print("usage: sbar-orbit panel [--edge left|right|top|bottom] [--monitor N] [--indicator] [--indicator-color CSS]")
            return 0
    Panel(edge, monitor, indicator, color).run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
