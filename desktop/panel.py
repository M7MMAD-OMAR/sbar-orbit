"""A tiny always-visible mark on a screen edge that says what Orbit is doing.

A small capsule of glass with the project mark inside it, coloured by state: grey when nothing
runs, the working colour while an agent works, amber when a session is paused, dim when the broker
is off. The mark can be traded for a plain capsule, a dot or a dot with a count. It
blinks once when a session or an application appears. Resting the pointer on it draws a card out of
the capsule, one row per session, joined to it by a neck that thins as the two separate; clicking a
card opens the viewer. A left click on the mark opens the viewer, a right click opens a settings
window, and dragging the mark carries it to another screen edge, with a landing strip on each edge
and the drop reaching for the nearest one. Everything is adjustable and persists in the person's
config.

The body is one Cairo outline rather than a background on each widget, which is what lets the capsule
and the card read as one thing being pulled apart, and also what keeps a theme from painting an
opaque rectangle behind the surface. See `body_path` and `metaball`.

It is a wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks that
protocol, and it stays out of the person's windows. It talks to the broker over the same Unix socket
the CLI uses and asks only for lists and presence, never a frame. Measured on this workstation it
costs 0.1% of one core at rest and about 3% while a morph is actually running, which is a third of a
second per hover, and the broker 0.135 ms of CPU a second. The panel is the person's own desktop
process and runs outside Orbit's shared budget on purpose.

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

# The body is drawn with Cairo paths a few hundred pixels across, which no GPU is needed for. The
# Cairo renderer is the cheapest GTK 4 has, and it is the one that works on a software-rendered
# display too, where the GPU renderers retry failing surfaces in a loop. Measured: the morph costs
# about 3% of one core while it runs and nothing between morphs.
os.environ.setdefault("GSK_RENDERER", "cairo")
os.environ.setdefault("GDK_DISABLE", "vulkan")

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Graphene", "1.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, Gio, GLib, Graphene, Gtk, Gtk4LayerShell as LayerShell  # noqa: E402
import cairo  # noqa: E402
import math  # noqa: E402

# The preload was for this process only; nothing it launches should inherit it.
os.environ.pop("LD_PRELOAD", None)
os.environ.pop("ORBIT_PANEL_PRELOADED", None)

FRAME_WIDTH = 3
OPEN_DELAY_MS = 220
CLOSE_DELAY_MS = 320
PRESENCE_WHILE_COLLAPSED_S = 10
# The open and close morph. Long enough to read as a liquid, short enough that the cards are there
# before the hand has settled.
MORPH_MS = 380
# How far apart the capsule and the card may drift before the neck between them lets go.
NECK_SPAN = 26.0
NECK_RADIUS = 15.0
# Transparent room left around the capsule so the pointer has something to hit near the screen edge.
MARK_PADDING = 7
# A press that travels further than this is a drag to another edge, not a click on the mark.
DRAG_THRESHOLD = 6.0
# How far outside the capsule a press still counts as a press on it. The capsule is deliberately
# small, and a handle that has to be hit exactly is a handle nobody uses.
GRIP_SLACK = 9.0
DROP_TARGET = 78.0
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}
EDGE_LABELS = {"left": "Left", "right": "Right", "top": "Top", "bottom": "Bottom"}
STYLES = ("mark", "bar", "dot", "count")
SHAPE_LABELS = ["logo", "capsule", "dot", "dot with count"]
STATE_KEYS = ("idle", "working", "paused", "offline")
DEFAULT_SETTINGS = {
    "edge": "right",
    "monitor": None,
    "style": "mark",
    # What the person settled on after living with it: a slimmer capsule, flush against the glass.
    "size": 8,
    "margin": 0,
    "colors": {"idle": "#8a8a8a", "working": "#4caf50", "paused": "#ff9800", "offline": "#585858"},
    "notifications": True,
    "blink": True,
    "frame": True,
    "frameColor": "#4caf50",
    "hideWhenIdle": False,
    # Where along its edge the mark sits, from 0 at the start of the edge to 1 at the end. Set by
    # dragging the mark, so a person who wants it under their top bar can put it there.
    "position": 0.5,
    "motion": True,
    "blend": 80,
}
NUMBER_KEYS = {"size": (6, 40), "margin": (0, 64), "blend": (30, 100), "position": (0.0, 1.0)}
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
# Whether the surface has a background at all is not a matter of taste, so it is not left to the
# theme. A generated theme that says `window { background: @window_bg_color; }` is loaded at user
# priority, which outranks an application provider, and it painted an opaque rectangle behind the
# mark: the panel showed up as a dark box sitting on the wallpaper. These rules alone are installed
# above user priority. Everything else stays below the theme, where the person's colours win.
SURFACE_CSS = b"""
window.orbit-clear, window.orbit-clear.background { background: none; background-color: transparent;
  background-image: none; box-shadow: none; }
.orbit-shell, .orbit-plate, .orbit-frame, .orbit-frame.background, .orbit-frame box {
  background: none; background-color: transparent; background-image: none; box-shadow: none; }
.orbit-frame box.on { background-color: @orbit-frame-color; }
"""
# Structure and motion only. Colours and sizes come from the person's settings, in a second provider
# reloaded when they change, so a colour edit takes effect without a restart.
BASE_CSS = b"""
@keyframes orbit-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
.orbit-plate { padding: 10px 12px; color: @window_fg_color; }
.orbit-bar, .orbit-dot { border-radius: 999px; }
.orbit-glyph.blink, .orbit-bar.blink, .orbit-dot.blink, .orbit-count.blink { animation: orbit-blink 380ms ease-in-out 2; }
.orbit-count { border-radius: 999px; font-weight: 700; padding: 0 7px; color: white; }
.orbit-card { padding: 8px 10px; border-radius: 14px; }
.orbit-card:hover { background: alpha(@window_fg_color, 0.09); }
.orbit-title { font-weight: 600; }
.orbit-dim { opacity: 0.65; font-size: 90%; }
.orbit-chip { font-size: 80%; font-weight: 600; padding: 1px 7px; border-radius: 8px; }
.orbit-foot button { padding: 2px 10px; border-radius: 999px; font-size: 90%; }
"""


def shell_padding(settings):
    """Transparent room around the mark: a target the pointer can hit near the screen edge, and the
    space the shadow and the capsule are drawn into. It is CSS padding, so GTK starts a widget's own
    drawing inside it and every coordinate below is relative to that inner box."""
    return max(6, int(settings["size"]))


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
        f".orbit-shell {{ padding: {shell_padding(settings)}px; }}",
        f".orbit-bar {{ min-width: {thickness}px; min-height: {length}px; }}",
        f".orbit-dot {{ min-width: {size}px; min-height: {size}px; }}",
        f".orbit-count {{ min-width: {size + 8}px; min-height: {size + 6}px; font-size: {max(9, size - 2)}px; }}",
    ]
    for key in STATE_KEYS:
        for widget in (".orbit-bar", ".orbit-dot", ".orbit-count"):
            lines.append(f"{widget}.{key} {{ background: {colors[key]}; }}")
        lines.append(f".orbit-chip.{key} {{ background: {colors[key]}; color: white; }}")
    return "\n".join(lines).encode()


def surface_css(settings):
    """The rules that must outrank the theme. The frame colour rides along because the rule that uses
    it lives here too, and a colour name defined in a lower provider would be the theme's to shadow."""
    return SURFACE_CSS + f"\n@define-color orbit-frame-color {settings['frameColor']};\n".encode()


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
    # A number that arrived as text, or outside its range, would only fail later inside a draw call,
    # where the panel would be a blank surface with a traceback nobody reads.
    for key, (low, high) in NUMBER_KEYS.items():
        try:
            value = float(settings[key])
        except (TypeError, ValueError):
            value = float(DEFAULT_SETTINGS[key])
        value = min(high, max(low, value))
        settings[key] = value if isinstance(DEFAULT_SETTINGS[key], float) else int(round(value))
    settings["motion"] = bool(settings["motion"])
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


def clamp(value, low=0.0, high=1.0):
    return low if value < low else (high if value > high else value)


def ease_out(value):
    return 1.0 - (1.0 - value) ** 3


def ease_out_back(value):
    """A small overshoot, so the card widens past its resting width and comes back the way a drop
    settles. Past about 1.1 of overshoot it reads as a bounce rather than as a liquid."""
    back = 0.9
    past = value - 1.0
    return 1.0 + (back + 1.0) * past ** 3 + back * past ** 2


def rounded(cr, x, y, width, height, radius):
    radius = max(0.0, min(radius, width / 2.0, height / 2.0))
    cr.new_sub_path()
    cr.arc(x + width - radius, y + radius, radius, -math.pi / 2, 0)
    cr.arc(x + width - radius, y + height - radius, radius, 0, math.pi / 2)
    cr.arc(x + radius, y + height - radius, radius, math.pi / 2, math.pi)
    cr.arc(x + radius, y + radius, radius, math.pi, 3 * math.pi / 2)
    cr.close_path()


# The project mark, from brand/orbit-mark-small.svg, on its own 24 unit grid. The small variant is
# the one a panel needs: the canonical stroke and its two notches close up below 20 pixels. Its drawn
# box is 20 wide by 18.21 tall inside that grid, which is the ratio a caller has to keep.
MARK_ASPECT = 18.21 / 20.0


def orbit_mark(cr, width):
    """Paint the mark at `width` pixels wide, in the colour already set on the context.

    A drawing rather than an icon file, because the panel tints it by session state and a symbolic
    icon would be recoloured by whichever icon theme the desktop is running instead.
    """
    scale = width / 20.0
    cr.save()
    cr.translate(-2.0 * scale, -2.89 * scale)
    cr.scale(scale, scale)
    rounded(cr, 2.0, 8.94, 12.16, 12.16, 2.6)
    cr.fill()
    # One open stroke with round caps: it stops short of the filled square at both crossings, which
    # is the notch that keeps the two surfaces from touching.
    cr.move_to(9.15, 6.24)
    cr.arc(10.73, 5.57, 1.58, math.pi, 1.5 * math.pi)
    cr.arc(19.32, 5.57, 1.58, 1.5 * math.pi, 2 * math.pi)
    cr.arc(19.32, 14.16, 1.58, 0.0, 0.5 * math.pi)
    cr.line_to(16.86, 15.74)
    cr.set_line_width(2.2)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.stroke()
    cr.restore()


def body_path(cr, head, tail, neck, head_radius, tail_radius):
    """One outline around the capsule and the card below it, joined by a concave fillet on each side.

    That fillet is the whole effect. Two rounded rectangles that merely touch read as two rectangles;
    an arc that curves inward where they meet reads as one body of liquid being pulled apart, which
    is what a metaball does and what the Dynamic Island does. The radius comes from the caller and
    shrinks as the gap grows, so the neck thins and finally lets go rather than snapping.
    """
    if tail is None:
        rounded(cr, head[0], head[1], head[2], head[3], head_radius)
        return
    hx0, hy0, hw, hh = head
    hx1, hy1 = hx0 + hw, hy0 + hh
    tx0, ty0, tw, th = tail
    tx1, ty1 = tx0 + tw, ty0 + th
    head_radius = max(0.0, min(head_radius, hw / 2.0, hh / 2.0))
    tail_radius = max(0.0, min(tail_radius, tw / 2.0, th / 2.0))
    gap = ty0 - hy1
    # The fillet has to fit beside the card's own corner, and its tangent point has to land on the
    # straight part of the capsule's side rather than up on its top corner.
    room = min(hx0 - tx0 - tail_radius, tx1 - tail_radius - hx1)
    ceiling = gap + hh - head_radius
    fillet = min(neck, room, ceiling)
    if th < 2.0 or fillet <= 0.5 or fillet < gap:
        # Too far apart to hold a neck, or the card is still no wider than the capsule. Draw both,
        # with the capsule reaching down into the card so the two never show a seam between them.
        rounded(cr, hx0, hy0, hw, max(hh, ty0 + tail_radius - hy0), head_radius)
        rounded(cr, tx0, ty0, tw, th, tail_radius)
        return
    joint = ty0 - fillet
    cr.new_sub_path()
    cr.arc(hx1 - head_radius, hy0 + head_radius, head_radius, -math.pi / 2, 0)
    cr.line_to(hx1, joint)
    cr.arc_negative(hx1 + fillet, joint, fillet, math.pi, math.pi / 2)
    cr.arc(tx1 - tail_radius, ty0 + tail_radius, tail_radius, -math.pi / 2, 0)
    cr.arc(tx1 - tail_radius, ty1 - tail_radius, tail_radius, 0, math.pi / 2)
    cr.arc(tx0 + tail_radius, ty1 - tail_radius, tail_radius, math.pi / 2, math.pi)
    cr.arc(tx0 + tail_radius, ty0 + tail_radius, tail_radius, math.pi, 3 * math.pi / 2)
    cr.arc_negative(hx0 - fillet, joint, fillet, math.pi / 2, 0)
    cr.line_to(hx0, hy0 + head_radius)
    cr.arc(hx0 + head_radius, hy0 + head_radius, head_radius, math.pi, 3 * math.pi / 2)
    cr.close_path()


def metaball(cr, first, second, spread=0.62, handle=2.3, reach=4.2):
    """The neck between two circles being pulled apart, added to the current path.

    The same idea as the fillet in `body_path`, for two bodies that are not lined up on an axis: the
    tangent lines where the two circles would touch are bent inward into a waist that thins as they
    separate and vanishes once they are too far apart. This is the classic metaball connector, and it
    is what the drag borrows to make the mark look poured toward the edge it is about to land on.
    """
    (ax, ay, r1), (bx, by, r2) = first, second
    dx, dy = bx - ax, by - ay
    span = math.hypot(dx, dy)
    if span <= 0 or span > (r1 + r2) * reach or span <= abs(r1 - r2):
        return False
    if span < r1 + r2:
        first_half = math.acos(clamp((r1 * r1 + span * span - r2 * r2) / (2 * r1 * span), -1.0, 1.0))
        second_half = math.acos(clamp((r2 * r2 + span * span - r1 * r1) / (2 * r2 * span), -1.0, 1.0))
    else:
        first_half = second_half = 0.0
    line = math.atan2(dy, dx)
    taper = math.acos(clamp((r1 - r2) / span, -1.0, 1.0))
    a3 = line + first_half + (taper - first_half) * spread
    a4 = line - first_half - (taper - first_half) * spread
    a5 = line + math.pi - second_half - (math.pi - second_half - taper) * spread
    a6 = line - math.pi + second_half + (math.pi - second_half - taper) * spread
    p1 = (ax + r1 * math.cos(a3), ay + r1 * math.sin(a3))
    p2 = (ax + r1 * math.cos(a4), ay + r1 * math.sin(a4))
    p3 = (bx + r2 * math.cos(a5), by + r2 * math.sin(a5))
    p4 = (bx + r2 * math.cos(a6), by + r2 * math.sin(a6))
    total = r1 + r2
    pull = min(spread * handle, math.hypot(p1[0] - p3[0], p1[1] - p3[1]) / total)
    pull *= min(1.0, span * 2.0 / total)
    h1, h2 = r1 * pull, r2 * pull
    cr.new_sub_path()
    cr.move_to(*p1)
    cr.curve_to(p1[0] + h1 * math.cos(a3 - math.pi / 2), p1[1] + h1 * math.sin(a3 - math.pi / 2),
                p3[0] + h2 * math.cos(a5 + math.pi / 2), p3[1] + h2 * math.sin(a5 + math.pi / 2), p3[0], p3[1])
    cr.line_to(*p4)
    cr.curve_to(p4[0] + h2 * math.cos(a6 - math.pi / 2), p4[1] + h2 * math.sin(a6 - math.pi / 2),
                p2[0] + h1 * math.cos(a4 + math.pi / 2), p2[1] + h1 * math.sin(a4 + math.pi / 2), p2[0], p2[1])
    cr.close_path()
    return True


def glass(cr, build, fill, edge, shadow=1.0, lift=(0.0, 2.0)):
    """Fill an outline, over a soft shadow and under a hairline edge.

    Cairo has no blur, and a blur on this renderer would cost more than the whole panel does. Four
    strokes of the same outline, each wider and fainter than the last, give a shadow that is close
    enough at this size and stays inside a tenth of a millisecond.
    """
    if shadow > 0:
        cr.save()
        cr.translate(*lift)
        build(cr)
        for width, alpha in ((14.0, 0.045), (9.0, 0.055), (5.0, 0.065), (2.0, 0.075)):
            cr.set_line_width(width)
            cr.set_source_rgba(0, 0, 0, alpha * shadow)
            cr.stroke_preserve()
        cr.new_path()
        cr.restore()
    build(cr)
    cr.set_source_rgba(*fill)
    cr.fill_preserve()
    cr.set_line_width(1.0)
    cr.set_source_rgba(*edge)
    cr.stroke()


class Liquid(Gtk.Box):
    """The panel's own body, drawn rather than styled.

    Everything the person sees behind the mark and the cards is one Cairo outline: a capsule around
    the mark, a card growing out of it, and a neck between them. Drawing it instead of giving each
    widget a background is what lets the two merge, and it is also what stops a generated theme from
    painting an opaque rectangle behind the surface.
    """

    __gtype_name__ = "OrbitLiquid"

    def __init__(self, panel):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=MARK_PADDING + 6)
        self.panel = panel
        self.progress = 0.0
        self.target = 0.0
        self.ticking = False
        self.last_frame = 0
        self.palette = None

    # --- Motion ----------------------------------------------------------------------------------

    def morph(self, target):
        """Run to the open or the closed shape. With motion off it arrives at once."""
        self.target = 1.0 if target else 0.0
        if not self.panel.settings["motion"]:
            self.progress = self.target
            self.queue_draw()
            self.panel.morph_settled(self.target)
            return
        if not self.ticking:
            self.ticking = True
            self.last_frame = 0
            self.add_tick_callback(self.step)

    def step(self, _widget, clock):
        now = clock.get_frame_time()
        if not self.last_frame:
            self.last_frame = now
        elapsed = (now - self.last_frame) / 1000.0
        self.last_frame = now
        # Closing is quicker than opening: a panel that lingers on its way out feels stuck.
        span = MORPH_MS if self.target > self.progress else MORPH_MS * 0.72
        travel = max(0.0, min(0.25, elapsed / span))
        if self.target > self.progress:
            self.progress = min(self.target, self.progress + travel)
        else:
            self.progress = max(self.target, self.progress - travel)
        self.queue_draw()
        if abs(self.progress - self.target) > 1e-3:
            return GLib.SOURCE_CONTINUE
        self.progress = self.target
        self.ticking = False
        self.panel.morph_settled(self.target)
        return GLib.SOURCE_REMOVE

    # --- Geometry --------------------------------------------------------------------------------

    def colours(self):
        """The person's own window colours, looked up once and kept until a setting changes them.
        A lookup per frame would be a theme query sixty times a second for an answer that does not
        move, and the only API GTK 4 offers for it is a deprecated one."""
        if self.palette is not None:
            return self.palette
        style = self.get_style_context()
        found, background = style.lookup_color("window_bg_color")
        if not found:
            found, background = style.lookup_color("theme_bg_color")
        if not found:
            background = Gdk.RGBA()
            background.parse("#1f1f1f")
        found, foreground = style.lookup_color("window_fg_color")
        if not found:
            foreground = self.get_color()
        blend = clamp(self.panel.settings["blend"] / 100.0, 0.3, 1.0)
        fill = (background.red, background.green, background.blue, blend)
        # The hairline is the person's own text colour at a whisper, so the body keeps an edge over a
        # bright wallpaper without ever reading as a border.
        rim = (foreground.red, foreground.green, foreground.blue, 0.14)
        self.palette = (fill, rim)
        return self.palette

    def primed(self, x, y, width, height):
        """A rectangle moved into the space the body is built in, where the card always grows
        downward out of the capsule, whichever edge the panel is docked to. One outline is drawn and
        the context is turned, rather than four versions of the same geometry."""
        edge = self.panel.settings["edge"]
        span_x, span_y = self.get_width(), self.get_height()
        if edge == "top":
            return (x, y, width, height)
        if edge == "bottom":
            return (x, span_y - y - height, width, height)
        if edge == "right":
            return (y, span_x - x - width, height, width)
        return (span_y - y - height, x, height, width)

    def unprimed(self, rect):
        edge = self.panel.settings["edge"]
        span_x, span_y = self.get_width(), self.get_height()
        x, y, width, height = rect
        if edge == "top":
            return (x, y, width, height)
        if edge == "bottom":
            return (x, span_y - y - height, width, height)
        if edge == "right":
            return (span_x - y - height, x, height, width)
        return (y, span_y - x - width, height, width)

    # Where a shadow falling down the screen points once the context has been turned. Left in the
    # rotated frame it would lean sideways, or upward, depending on which edge the panel is docked to.
    LIFT = {"top": (0.0, 2.0), "bottom": (0.0, -2.0), "right": (2.0, 0.0), "left": (-2.0, 0.0)}

    def orient(self, cr):
        edge = self.panel.settings["edge"]
        span_x, span_y = self.get_width(), self.get_height()
        if edge == "bottom":
            cr.translate(0, span_y)
            cr.scale(1, -1)
        elif edge == "right":
            cr.translate(span_x, 0)
            cr.rotate(math.pi / 2)
        elif edge == "left":
            cr.translate(0, span_y)
            cr.rotate(-math.pi / 2)

    def shape(self):
        """The capsule, the card and the neck between them, built in the primed space.

        The card is measured from the plate's real allocation and then scaled by the morph, so the
        shape at rest is exactly the shape GTK laid out and nothing drifts by a pixel.
        """
        found, mark = self.panel.mark.compute_bounds(self)
        if not found or mark.size.height <= 0 or self.get_height() <= 0:
            return None, None, 0.0, 0.0, 0.0
        pad = MARK_PADDING
        head = self.primed(mark.origin.x - pad, mark.origin.y - pad,
                           mark.size.width + pad * 2, mark.size.height + pad * 2)
        head_radius = min(head[2], head[3]) / 2.0
        progress = self.progress
        found, plate = self.panel.plate.compute_bounds(self)
        if not found or not self.panel.plate.get_visible() or progress <= 0.004 or plate.size.height <= 0:
            return head, None, head_radius, 0.0, 0.0
        card = self.primed(plate.origin.x, plate.origin.y, plate.size.width, plate.size.height)
        # The card widens faster than it grows, so it reads as a drop swelling out of the capsule
        # rather than as a rectangle unrolling.
        widen = ease_out_back(clamp(progress * 1.5))
        grow = ease_out(progress)
        width = head[2] + (card[2] - head[2]) * widen
        length = max(1.0, card[3] * grow)
        gap = 6.0 * grow
        tail = (card[0] + card[2] / 2.0 - width / 2.0, head[1] + head[3] + gap, width, length)
        neck = NECK_RADIUS * clamp(1.0 - gap / NECK_SPAN)
        return head, tail, head_radius, neck, 18.0 * clamp(grow * 1.6)

    # --- Drawing ---------------------------------------------------------------------------------

    def do_snapshot(self, snapshot):
        width, height = self.get_width(), self.get_height()
        if width <= 0 or height <= 0:
            return
        if self.panel.drag is not None:
            # While the mark is being carried it is drawn on the carry surface, which covers the
            # whole monitor. Nothing is drawn here, but a node is still handed over: a snapshot with
            # no nodes at all leaves the compositor holding the previous buffer, and the mark stays
            # painted at the edge it has just left.
            snapshot.append_cairo(Graphene.Rect().init(0, 0, width, height))
            return
        # A widget draws from its content box, and the body deliberately spills into the padding
        # around it. A node the size of the content box would cut the capsule and its shadow off.
        room = shell_padding(self.panel.settings) + 8
        area = Graphene.Rect().init(-room, -room, width + room * 2, height + room * 2)
        head, tail, head_radius, neck, tail_radius = self.shape()
        if head is None:
            # The mark is hidden, so there is no body to draw the card into. Drawing the children
            # anyway would leave the rows standing on the wallpaper with nothing behind them.
            return
        fill, rim = self.colours()
        cr = snapshot.append_cairo(area)
        cr.save()
        self.orient(cr)
        glass(cr, lambda ctx: body_path(ctx, head, tail, neck, head_radius, tail_radius), fill, rim,
              lift=self.LIFT[self.panel.settings["edge"]])
        cr.restore()
        self.snapshot_child(self.panel.mark, snapshot)
        if tail is None:
            return
        # The words arrive on the tail of the motion. Showing them from the first frame is what makes
        # a morph look like a box appearing behind a shape rather than the shape becoming the box.
        alpha = clamp((self.progress - 0.38) / 0.42)
        if alpha <= 0.004:
            return
        visible = Graphene.Rect().init(*self.unprimed(tail))
        snapshot.push_opacity(alpha)
        snapshot.push_clip(visible)
        self.snapshot_child(self.panel.plate, snapshot)
        snapshot.pop()
        snapshot.pop()


class Glyph(Gtk.DrawingArea):
    """The project mark as the panel's own indicator, tinted by session state.

    The other three shapes are styled boxes, so their colour comes from the generated CSS. A shape
    cannot be a box, so this one reads the same colour directly and paints it.
    """

    def __init__(self, panel):
        super().__init__()
        self.panel = panel
        self.add_css_class("orbit-glyph")
        self.set_draw_func(self.draw)

    def resize(self, width):
        self.set_content_width(width)
        self.set_content_height(max(1, round(width * MARK_ASPECT)))

    def draw(self, _area, cr, width, _height):
        colour = Gdk.RGBA()
        if not colour.parse(self.panel.settings["colors"][self.panel.state_of()]):
            colour.parse("#8a8a8a")
        cr.set_source_rgba(colour.red, colour.green, colour.blue, 1.0)
        orbit_mark(cr, width)


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
        self.surface_provider = None
        self.drag = None
        self.drag_start = (0.0, 0.0)
        self.carrying = False
        self.carry_window = None
        self.carry_area = None
        self.awaiting_leave = False
        self.along = 0
        self.extent = -1
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
        self.surface_provider = self.install_css(self.display, surface_css(self.settings), Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)

        self.shell = Liquid(self)
        self.shell.add_css_class("orbit-shell")
        self.shell.set_halign(Gtk.Align.CENTER)
        self.mark = Gtk.Box()
        self.mark.set_halign(Gtk.Align.CENTER)
        self.mark.set_valign(Gtk.Align.CENTER)
        self.mark.update_property([Gtk.AccessibleProperty.LABEL], ["Sbar Orbit sessions"])
        self.glyph = Glyph(self)
        self.bar = Gtk.Box()
        self.bar.add_css_class("orbit-bar")
        self.dot = Gtk.Box()
        self.dot.add_css_class("orbit-dot")
        self.count = Gtk.Label(label="0")
        self.count.add_css_class("orbit-count")
        for widget in self.shapes():
            self.mark.append(widget)

        # The cards live on their own rounded plate, so the mark keeps no background of its own and
        # the surface stays transparent where there is nothing to show.
        self.plate = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.plate.add_css_class("orbit-plate")
        # Room for a name and a window title. Without a floor the cards squeeze to the width of the
        # capsule and every line reads as three words and an ellipsis. The floor belongs to the rows
        # rather than to the card, so the card's own padding is added to it instead of eaten out of it.
        self.details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.details.set_size_request(280, -1)
        self.scroller = Gtk.ScrolledWindow()
        self.scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.scroller.set_propagate_natural_height(True)
        self.scroller.set_max_content_height(420)
        self.scroller.set_child(self.details)
        self.plate.append(self.scroller)
        self.plate.append(self.footer())

        self.shell.append(self.mark)
        self.shell.append(self.plate)
        self.layout_shell()

        self.hover = Gtk.EventControllerMotion()
        self.hover.connect("notify::contains-pointer", lambda controller, _: self.hover_changed(controller.get_property("contains-pointer")))
        self.shell.add_controller(self.hover)
        # One gesture for both, because a click gesture and a drag gesture on the same widget and the
        # same button fight over the press and the viewer stops opening. A press that stays put is a
        # click, a press that travels is the mark being carried to another edge.
        carry = Gtk.GestureDrag(button=1)
        carry.connect("drag-begin", self.drag_begin)
        carry.connect("drag-update", self.drag_update)
        carry.connect("drag-end", self.drag_end)
        # On the shell rather than on the mark itself, because the mark is a few pixels wide and a
        # press has to land on the capsule drawn around it, which is the part the person can see. The
        # press still reaches a card's button first, so a click on a card is not a drag of the panel.
        self.shell.add_controller(carry)
        menu = Gtk.GestureClick(button=3)
        menu.connect("pressed", lambda *_: self.open_settings())
        self.shell.add_controller(menu)

        window.set_child(self.shell)
        self.anchor(window)
        window.present()
        self.apply_style()
        GLib.idle_add(self.settle)
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
        """Dock the mark to the chosen edge and pin the surface to one end of that edge, with a margin
        that puts the mark where the person left it. Anchored to a single edge the compositor centres
        the whole surface, so the mark would jump by half the height of the cards every time they
        opened. The pin is never the docked edge itself, or the margin along it would overwrite the
        distance from the edge and the two settings would fight.
        """
        monitor = self.monitor_for(window)
        if monitor is not None:
            LayerShell.set_monitor(window, monitor)
        edge = self.settings["edge"]
        vertical = edge in ("left", "right")
        pin = "top" if vertical else "left"
        for name, value in EDGES.items():
            LayerShell.set_anchor(window, value, name in (edge, pin))
            LayerShell.set_margin(window, value, 0)
        gap = max(0, int(self.settings["margin"]))
        LayerShell.set_margin(window, EDGES[edge], gap)
        along = 0
        if monitor is not None:
            geometry = monitor.get_geometry()
            span = geometry.height if vertical else geometry.width
            extent = window.get_height() if vertical else window.get_width()
            # The setting names where the middle of the mark sits along the edge, and the margin is
            # measured to the start of the surface, so half the surface has to come off it. Without
            # that the mark lands short of the hand by half a card, further out the nearer the end.
            extent = max(1, extent)
            along = round(clamp(float(self.settings["position"])) * span - extent / 2.0)
            along = max(0, min(span - extent, along))
            LayerShell.set_margin(window, EDGES[pin], along)
            self.along = along

    # --- Carrying the mark to another edge --------------------------------------------------------

    def paint_carry(self, cr, width, height):
        """While the mark is being carried: a landing strip on each edge, and the mark itself under
        the hand, poured toward whichever strip it would land on."""
        drag = self.drag
        fill, rim = self.shell.colours()
        pointer = (drag["x"], drag["y"])
        chosen_spot = None
        for name, spot, extent in self.drop_targets(width, height):
            chosen = name == drag["edge"]
            if chosen:
                chosen_spot = (spot, extent)
                continue
            box = (spot[0] - extent[0] / 2.0, spot[1] - extent[1] / 2.0, extent[0], extent[1])
            glass(cr, lambda ctx, b=box: rounded(ctx, b[0], b[1], b[2], b[3], min(b[2], b[3]) / 2.0),
                  (fill[0], fill[1], fill[2], fill[3] * 0.4), (rim[0], rim[1], rim[2], 0.08), shadow=0.0)
        colour = Gdk.RGBA()
        if not colour.parse(self.settings["colors"][self.state_of()]):
            colour.parse("#8a8a8a")
        carried = max(10.0, MARK_PADDING + max(6, int(self.settings["size"])) / 2.0)
        if chosen_spot is None:
            glass(cr, lambda ctx: ctx.arc(pointer[0], pointer[1], carried, 0, 2 * math.pi),
                  (colour.red, colour.green, colour.blue, 0.92), rim)
            return
        spot, extent = chosen_spot
        grown = (spot[0] - extent[0] / 2.0 - 5, spot[1] - extent[1] / 2.0 - 5, extent[0] + 10, extent[1] + 10)
        # The strip is a long capsule, so the drop reaches for the point on it nearest the hand rather
        # than for its middle, and the thread follows the hand along the edge.
        near = (min(max(pointer[0], grown[0] + grown[3] / 2.0), grown[0] + grown[2] - grown[3] / 2.0)
                if grown[2] > grown[3] else spot[0],
                min(max(pointer[1], grown[1] + grown[2] / 2.0), grown[1] + grown[3] - grown[2] / 2.0)
                if grown[3] > grown[2] else spot[1])
        waist = min(grown[2], grown[3]) / 2.0

        def body(ctx):
            rounded(ctx, grown[0], grown[1], grown[2], grown[3], waist)
            metaball(ctx, (pointer[0], pointer[1], carried), (near[0], near[1], waist))
            ctx.new_sub_path()
            ctx.arc(pointer[0], pointer[1], carried, 0, 2 * math.pi)
            ctx.close_path()

        # The strip, the thread and the drop overlap, and they do not all wind the same way, so a
        # single fill would cancel itself where they cross. Each is painted opaque into a group and
        # the group is laid down once at the final alpha, which is one body with no seam in it.
        cr.save()
        cr.translate(0, 2)
        body(cr)
        for line_width, alpha in ((12.0, 0.05), (7.0, 0.06), (3.0, 0.07)):
            cr.set_line_width(line_width)
            cr.set_source_rgba(0, 0, 0, alpha)
            cr.stroke_preserve()
        cr.new_path()
        cr.restore()
        cr.push_group()
        cr.set_source_rgba(colour.red, colour.green, colour.blue, 1.0)
        rounded(cr, grown[0], grown[1], grown[2], grown[3], waist)
        cr.fill()
        if metaball(cr, (pointer[0], pointer[1], carried), (near[0], near[1], waist)):
            cr.fill()
        cr.arc(pointer[0], pointer[1], carried, 0, 2 * math.pi)
        cr.fill()
        cr.pop_group_to_source()
        cr.paint_with_alpha(0.92)

    def build_carry(self):
        """The surface the carry is drawn on: its own layer, over the whole monitor, click through.

        The first version stretched the panel's own surface to the monitor for the length of the
        drag. Measured, the compositor took two or three motion events to answer that with a new
        size, so the first quarter of every drag drew the landing strips into a surface a few hundred
        pixels wide at the old edge, where nothing of them could be seen; and resizing and moving a
        surface out from under the pointer grab that is delivering the drag is a good way to lose the
        drag. This surface is separate, it is mapped only while the mark is in the air, and its input
        region is empty, so the press that started the drag stays with the panel throughout.
        """
        window = Gtk.Window(application=self)
        window.set_title("Orbit carrying")
        window.add_css_class("orbit-clear")
        LayerShell.init_for_window(window)
        LayerShell.set_layer(window, LayerShell.Layer.OVERLAY)
        LayerShell.set_namespace(window, "sbar-orbit-carry")
        LayerShell.set_exclusive_zone(window, -1)
        LayerShell.set_keyboard_mode(window, LayerShell.KeyboardMode.NONE)
        for value in EDGES.values():
            LayerShell.set_anchor(window, value, True)
            LayerShell.set_margin(window, value, 0)
        area = Gtk.DrawingArea()
        area.set_draw_func(lambda _area, cr, width, height: self.paint_carry(cr, width, height))
        window.set_child(area)

        def passthrough(mapped):
            surface = mapped.get_surface()
            if surface is not None:
                surface.set_input_region(cairo.Region())

        window.connect("realize", passthrough)
        window.connect("map", passthrough)
        self.carry_area = area
        self.carry_window = window

    def surface_origin(self):
        """Where the panel's surface sits on the monitor. The compositor never tells a layer surface
        its position, so this is the same arithmetic the compositor is about to do from the anchors
        and margins the panel just gave it."""
        monitor = self.monitor_for(self.window) if self.window is not None else None
        if monitor is None or self.window is None:
            return (0, 0)
        geometry = monitor.get_geometry()
        width, height = self.window.get_width(), self.window.get_height()
        gap = max(0, int(self.settings["margin"]))
        edge = self.settings["edge"]
        if edge in ("left", "right"):
            return (gap if edge == "left" else geometry.width - width - gap, self.along)
        return (self.along, gap if edge == "top" else geometry.height - height - gap)

    def drop_targets(self, width, height):
        """Where a dropped mark would land, one landing strip per edge, drawn on the carry surface."""
        thick, long_side = 16.0, DROP_TARGET
        return [
            ("left", (26.0, height / 2.0), (thick, long_side)),
            ("right", (width - 26.0, height / 2.0), (thick, long_side)),
            ("top", (width / 2.0, 26.0), (long_side, thick)),
            ("bottom", (width / 2.0, height - 26.0), (long_side, thick)),
        ]

    def monitor_size(self):
        monitor = self.monitor_for(self.window) if self.window is not None else None
        if monitor is None:
            return 1920, 1080
        geometry = monitor.get_geometry()
        return geometry.width, geometry.height

    def on_mark(self, x, y):
        """Whether a point is on the capsule the person sees, which is wider than the mark inside it."""
        head = self.shell.shape()[0]
        if head is None:
            return False
        left, top, width, height = self.shell.unprimed(head)
        pad = shell_padding(self.settings)
        x, y = x - pad, y - pad
        return (left - GRIP_SLACK <= x <= left + width + GRIP_SLACK
                and top - GRIP_SLACK <= y <= top + height + GRIP_SLACK)

    def drag_begin(self, gesture, start_x, start_y):
        self.drag = None
        self.carrying = self.on_mark(start_x, start_y)
        # The gesture reports points inside the shell's content box, which starts one padding in from
        # the surface, which in turn starts at the origin. Both are needed to name a place on screen.
        pad = shell_padding(self.settings)
        origin = self.surface_origin()
        self.drag_start = (origin[0] + pad + start_x, origin[1] + pad + start_y)

    def drag_update(self, gesture, offset_x, offset_y):
        if not self.carrying:
            return
        if self.drag is None:
            if abs(offset_x) < DRAG_THRESHOLD and abs(offset_y) < DRAG_THRESHOLD:
                return
            self.enter_carry()
        self.aim(self.drag_start[0] + offset_x, self.drag_start[1] + offset_y)

    def drag_end(self, gesture, offset_x, offset_y):
        if self.drag is None:
            # It never travelled, so it was a click, and only a click on the mark opens the viewer.
            if self.carrying:
                self.open_viewer()
            return
        self.aim(self.drag_start[0] + offset_x, self.drag_start[1] + offset_y)
        edge, position = self.drag["edge"], self.drag["position"]
        self.leave_carry()
        self.settings["edge"] = edge
        self.settings["position"] = position
        self.schedule_save()
        self.relocate()
        self.apply_style()

    def aim(self, x, y):
        """Which edge the mark would land on, and where along it. Nearest edge wins, so the mark falls
        to the side the hand is closest to rather than to wherever it happens to be released."""
        width, height = self.monitor_size()
        x, y = clamp(x, 0, width), clamp(y, 0, height)
        distances = {"left": x, "right": width - x, "top": y, "bottom": height - y}
        edge = min(distances, key=distances.get)
        along = y / height if edge in ("left", "right") else x / width
        self.drag.update({"x": x, "y": y, "edge": edge, "position": round(clamp(along), 3)})
        if self.carry_area is not None:
            self.carry_area.queue_draw()

    def enter_carry(self):
        """The mark leaves its edge: it stops being drawn in the panel's surface and appears on the
        carry surface under the hand instead. The panel's own surface is not touched, so the pointer
        grab that is delivering this drag stays exactly where it started."""
        self.drag = {"x": 0.0, "y": 0.0, "edge": self.settings["edge"], "position": self.settings["position"]}
        self.set_expanded(False)
        self.shell.progress = 0.0
        # Transparent rather than hidden. A hidden widget stops receiving events, and this one is
        # carrying the gesture; and an empty snapshot alone left the compositor holding the last
        # buffer, so the mark stayed painted at its old edge while its copy followed the hand.
        self.shell.queue_draw()
        if self.carry_window is None:
            self.build_carry()
        monitor = self.monitor_for(self.window) if self.window is not None else None
        if monitor is not None:
            LayerShell.set_monitor(self.carry_window, monitor)
        self.carry_window.set_visible(True)
        self.shell.queue_draw()

    def leave_carry(self):
        self.drag = None
        self.extent = -1
        if self.carry_window is not None:
            self.carry_window.set_visible(False)
        self.shell.queue_draw()
        # The hand is now sitting wherever it let go, often right on top of the mark's new place, and
        # the surface moving under it counts as the pointer entering. The cards stay shut until the
        # hand has actually left once, which is a fact rather than a guess at how long that takes.
        self.awaiting_leave = True

    def layout_shell(self):
        """The card grows inward from the edge the mark is docked to: sideways on a side edge, down
        or up on a top or bottom one. The mark keeps the anchored end, and both are centred across
        the surface, so the mark sits at the same pixel whether the card is open or not."""
        edge = self.settings["edge"]
        upright = edge in ("top", "bottom")
        self.shell.set_orientation(Gtk.Orientation.VERTICAL if upright else Gtk.Orientation.HORIZONTAL)
        first, second = (self.mark, self.plate) if edge in ("top", "left") else (self.plate, self.mark)
        self.shell.reorder_child_after(first, None)
        self.shell.reorder_child_after(second, first)
        self.mark.set_halign(Gtk.Align.CENTER)
        self.mark.set_valign(Gtk.Align.CENTER)
        self.shell.set_halign(Gtk.Align.CENTER)
        self.shell.set_valign(Gtk.Align.CENTER)
        # The card fills its cell rather than centring inside it. Centred, it keeps its natural size
        # while the box hands it more, and the body would be drawn around a rectangle the rows have
        # already outgrown.
        self.plate.set_halign(Gtk.Align.FILL)
        self.plate.set_valign(Gtk.Align.FILL)

    def settle(self):
        """Re-anchor when the surface has changed size, and keep the input region on the part of the
        surface the person can see. Without that region a collapsed mark would still swallow every
        click in the whole card-sized rectangle it keeps laid out beside it."""
        window = self.window
        if window is None or self.drag is not None:
            return False
        extent = window.get_height() if self.settings["edge"] in ("left", "right") else window.get_width()
        if extent != self.extent:
            self.extent = extent
            self.anchor(window)
        surface = window.get_surface()
        width, height = window.get_width(), window.get_height()
        if surface is None or width <= 0 or height <= 0:
            # Called before the surface has a size. Nothing would be set, and nothing else would
            # come back to set it, so ask again on the next turn of the loop.
            GLib.timeout_add(120, self.settle)
            return False
        head = self.shell.shape()[0]
        if head is None:
            # Nothing is drawn, so nothing should be clickable: an empty region lets every event
            # through to the person's windows instead of into a surface they cannot see.
            surface.set_input_region(cairo.Region())
            return False
        if self.expanded or self.shell.progress > 0.01:
            region = cairo.Region(cairo.RectangleInt(0, 0, width, height))
        else:
            x, y, w, h = self.shell.unprimed(head)
            # Back out to surface coordinates: the shape is measured from the shell's content box,
            # and the surface starts one padding earlier in both directions.
            pad = shell_padding(self.settings)
            region = cairo.Region(cairo.RectangleInt(int(x) + pad - 2, int(y) + pad - 2, int(w) + 4, int(h) + 4))
        surface.set_input_region(region)
        return False

    def relocate(self):
        """Applied live from the settings: the mark moves, and the frame follows it to the monitor."""
        if self.window is None:
            return
        self.layout_shell()
        self.anchor(self.window)
        GLib.idle_add(self.settle)
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

    def shapes(self):
        return (self.glyph, self.bar, self.dot, self.count)

    def mark_widget(self):
        return dict(zip(STYLES, self.shapes()))[self.settings["style"]]

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
        if self.surface_provider is not None:
            self.surface_provider.load_from_data(surface_css(self.settings))
        self.shell.palette = None
        # A logo needs pixels in a way a capsule does not, so it takes its own floor rather than the
        # thickness the capsule was tuned to.
        self.glyph.resize(max(16, round(max(6, int(self.settings["size"])) * 2.0)))
        for style, widget in zip(STYLES, self.shapes()):
            widget.set_visible(self.settings["style"] == style)
        self.render()

    def render(self):
        state = self.state_of()
        for widget in self.shapes():
            for key in STATE_KEYS:
                widget.remove_css_class(key)
            widget.add_css_class(state)
        self.glyph.queue_draw()
        self.count.set_text("0" if state == "offline" else str(len(self.sessions)))
        if self.drag is None:
            # Not while the mark is being carried. Showing or hiding it changes how big the shell is,
            # which moves the surface, which moves the frame the drag measures its offsets in, and the
            # drop would step sideways because an agent happened to start work mid gesture.
            self.mark.set_visible(not (self.settings["hideWhenIdle"] and state in ("idle", "offline")))
        self.shell.queue_draw()
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
        # A scrolling view asks for almost no height of its own, so the card would be laid out at its
        # minimum and the last row would be cut in half. The rows are measured and made the floor,
        # up to the ceiling where scrolling takes over.
        wanted = self.details.measure(Gtk.Orientation.VERTICAL, -1)[1]
        self.scroller.set_min_content_height(min(420, wanted))
        # A row appearing or leaving changes how long the surface is, and the margin that places the
        # mark along its edge is measured from that length. Without this the mark drifts when a
        # session starts while the cards are open, and jumps back when they close.
        GLib.idle_add(self.settle)

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
        if self.drag is not None:
            return
        if self.awaiting_leave:
            if inside:
                return
            self.awaiting_leave = False
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
        # Only opening is refused while the mark is in the air. Refusing to close as well left the
        # cards standing open through the whole drag and open at the new edge afterwards, on top of
        # the mark, so the next press landed on a card and the mark could not be picked up again.
        if expanded and self.drag is not None:
            return
        if expanded == self.expanded and not (expanded and self.cards_stale):
            return
        self.expanded = expanded
        if expanded:
            self.fill_cards()
            # Ask for presence at once, so the cards do not open showing a ten second old title.
            self.wake.set()
        self.shell.morph(expanded)
        GLib.idle_add(self.settle)

    def morph_settled(self, _target):
        """The card keeps its place in the layout even when closed, so the surface never resizes
        under the pointer; what changes is the input region, which is tightened back onto the mark."""
        GLib.idle_add(self.settle)

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

        # No parent window. Handing a layer surface to a launcher makes GTK ask the compositor to
        # export it as a toplevel, which a layer surface is not, and the protocol error ends the
        # panel the moment the person clicks the mark.
        Gtk.UriLauncher.new(url).launch(None, None, done)

    def change(self, key, value, restyle=True):
        self.settings[key] = value
        self.schedule_save()
        if key in ("edge", "monitor", "margin", "size", "position"):
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
            self.scale_row("Place along the edge", 0, 100, round(panel.settings["position"] * 100),
                           lambda v: panel.change("position", v / 100.0)),
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
        outer.append(self.group("Motion and blending", [
            self.switch_row("Liquid motion", panel.settings["motion"], lambda v: panel.change("motion", v)),
            self.scale_row("How solid the card is", 30, 100, panel.settings["blend"], lambda v: panel.change("blend", v)),
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
        outer.append(self.note(f"Saved in {SETTINGS_PATH}"))
        outer.append(self.note("A right click on the mark opens this window, a left click opens the viewer, and resting the pointer on it lists the sessions. Dragging it carries it to another edge: the nearest landing strip lights up, and where the mark is released along that edge is where it stays."))

        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroller.set_child(outer)
        self.set_child(scroller)

        # Escape closes a preferences window everywhere else on this desktop.
        escape = Gtk.ShortcutController()
        escape.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("Escape"),
                                             Gtk.CallbackAction.new(lambda *_: (self.close(), True)[1])))
        self.add_controller(escape)

    @staticmethod
    def note(text):
        """A line of explanation, which wraps rather than being cut short the way a row label is."""
        wrapped = Gtk.Label(label=text)
        wrapped.set_halign(Gtk.Align.START)
        wrapped.set_xalign(0)
        wrapped.set_wrap(True)
        wrapped.set_max_width_chars(44)
        wrapped.add_css_class("orbit-dim")
        return wrapped

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
        elif flag == "--position" and args:
            try:
                settings["position"] = min(1.0, max(0.0, float(args.pop(0))))
            except ValueError:
                pass
        elif flag == "--no-motion":
            settings["motion"] = False
        elif flag == "--no-notifications":
            settings["notifications"] = False
        elif flag == "--settings":
            open_settings = True
        elif flag in ("-h", "--help"):
            print("usage: sbar-orbit panel [--edge left|right|top|bottom] [--monitor N|CONNECTOR] [--style mark|bar|dot|count]")
            print("                        [--position 0..1] [--frame|--no-frame] [--frame-color CSS] [--no-motion]")
            print("                        [--no-notifications] [--settings]")
            print(f"settings persist in {SETTINGS_PATH}; a right click on the mark opens the settings window")
            return 0
    panel = Panel(settings)
    if open_settings:
        panel.connect("activate", lambda *_: GLib.idle_add(panel.open_settings))
    panel.run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
