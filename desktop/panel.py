"""A tiny always-visible mark on a screen edge that says what Orbit is doing.

A small capsule of glass with the project mark inside it, coloured by state: grey when nothing
runs, the working colour while an agent works, amber when a session is paused, dim when the broker
is off. The mark can be traded for a plain capsule, a dot or a dot with a count. It
blinks once when a session or an application appears. Resting the pointer on it draws a card out of
the capsule, one row per session, joined to it by a neck that thins as the two separate; clicking a
card opens the viewer. A left click on the mark opens the viewer, a right click opens Orbit's
settings in the viewer, and dragging the mark carries it to another screen edge, with a landing strip
on each edge and the drop reaching for the nearest one. Everything is adjustable and persists in the
person's config.

The body is one Cairo outline rather than a background on each widget, which is what lets the capsule
and the card read as one thing being pulled apart, and also what keeps a theme from painting an
opaque rectangle behind the surface. See `body_path` and `metaball` in `panel_draw`.

This file is the application: the window, where it sits, and what it does when the person touches it.
Two neighbours carry the rest. `panel_broker` is everything that speaks to Orbit,
with no GTK in it, which is what lets `tests/panel-broker.test.ts` reach it without a display.
`panel_draw` is the geometry and the paint, and the two widgets that carry them.

It is a wlr-layer-shell surface, so it works on Hyprland, sway and anything else that speaks that
protocol, and it stays out of the person's windows. It talks to the broker over the same Unix socket
the CLI uses and asks only for lists and presence, never a frame. Measured on this workstation it
costs 0.1% of one core at rest and about 3% while a morph is actually running, which is a third of a
second per hover, and the broker 0.135 ms of CPU a second. The panel is the person's own desktop
process and runs outside Orbit's shared budget on purpose.

Run with /usr/bin/python3: the system interpreter has the GTK bindings, a virtualenv usually does not.
"""
import json
import os
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orbit_settings  # noqa: E402  the path above is what makes this importable when run by absolute path

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
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Gtk4LayerShell as LayerShell  # noqa: E402
try:  # The unix helpers moved out of GLib; the old names still work and warn on every call.
    from gi.repository import GLibUnix  # noqa: E402
except ImportError:
    GLibUnix = None
import cairo  # noqa: E402
import math  # noqa: E402

from panel_broker import (BrokerClient, broker_socket, claim_the_mark, command_socket_path, launcher_json,
                           notify, read_status, rpc, session_shape, viewer_link_is_local)  # noqa: E402
from panel_draw import (MARK_PADDING, Glyph, Liquid, clamp, glass, label, metaball, rounded,
                        shell_padding)  # noqa: E402

# The preload was for this process only; nothing it launches should inherit it.
os.environ.pop("LD_PRELOAD", None)
os.environ.pop("ORBIT_PANEL_PRELOADED", None)

# How deep the working glow reaches in from the screen edge. A hairline had nothing to fade across;
# this is the distance the wash has to die out over. The depth is what makes the glow readable from
# across the room: at a shallow depth the only way to be seen is to be dense, and dense against the
# edge is a border. So the wash keeps a bright core against the edge and spends the rest of this
# distance dying out, which is a large soft area rather than a small hard one. Four strips at this
# depth cost about 3.8 MiB of buffer between them on a 2560 by 1440 output, against tens of megabytes
# for one surface covering the whole output with a transparent middle.
FRAME_GLOW = 120
OPEN_DELAY_MS = 220
CLOSE_DELAY_MS = 320
PRESENCE_WHILE_COLLAPSED_S = 10
# A press that travels further than this is a drag to another edge, not a click on the mark.
DRAG_THRESHOLD = 6.0
# How far outside the capsule a press still counts as a press on it. The capsule is deliberately
# small, and a handle that has to be hit exactly is a handle nobody uses.
GRIP_SLACK = 9.0
DROP_TARGET = 78.0
EDGES = {"left": LayerShell.Edge.LEFT, "right": LayerShell.Edge.RIGHT, "top": LayerShell.Edge.TOP, "bottom": LayerShell.Edge.BOTTOM}
# Defaults, ranges, validation and the words a person might search for all live in one module, which the
# settings view in the viewer, `sbar-orbit config` and this file all read. A setting described in only one of the
# three is a setting one of them silently disagrees about.
STYLES = orbit_settings.STYLES
STATE_KEYS = orbit_settings.STATE_KEYS
DEFAULT_SETTINGS = orbit_settings.DEFAULT_SETTINGS
NUMBER_KEYS = orbit_settings.NUMBER_KEYS
SETTINGS_PATH = orbit_settings.SETTINGS_PATH

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
/* The working glow. Not a border: a wash that is densest against the screen edge and gone before it
   reaches anything the person is reading, so the screen reads as in use without a line drawn round
   it. The stops are bunched near the edge and thin out over the rest of the depth, which is what
   lets the glow cover a large part of the screen while the part with any weight in it stays out at
   the edge. The four strips overlap at the corners, and the overlap is wanted: two soft washes
   crossing is what gives a corner its vignette instead of a mitred join. */
.orbit-frame box.on.pulse {
  animation: orbit-glow 2600ms ease-in-out infinite;
}
.orbit-frame box.on.top { background-image: linear-gradient(to bottom,
  alpha(@orbit-frame-color, 0.80) 0%, alpha(@orbit-frame-color, 0.45) 18%,
  alpha(@orbit-frame-color, 0.20) 40%, alpha(@orbit-frame-color, 0.07) 68%,
  alpha(@orbit-frame-color, 0) 100%); }
.orbit-frame box.on.bottom { background-image: linear-gradient(to top,
  alpha(@orbit-frame-color, 0.80) 0%, alpha(@orbit-frame-color, 0.45) 18%,
  alpha(@orbit-frame-color, 0.20) 40%, alpha(@orbit-frame-color, 0.07) 68%,
  alpha(@orbit-frame-color, 0) 100%); }
.orbit-frame box.on.left { background-image: linear-gradient(to right,
  alpha(@orbit-frame-color, 0.80) 0%, alpha(@orbit-frame-color, 0.45) 18%,
  alpha(@orbit-frame-color, 0.20) 40%, alpha(@orbit-frame-color, 0.07) 68%,
  alpha(@orbit-frame-color, 0) 100%); }
.orbit-frame box.on.right { background-image: linear-gradient(to left,
  alpha(@orbit-frame-color, 0.80) 0%, alpha(@orbit-frame-color, 0.45) 18%,
  alpha(@orbit-frame-color, 0.20) 40%, alpha(@orbit-frame-color, 0.07) 68%,
  alpha(@orbit-frame-color, 0) 100%); }
/* Breathing, not flashing. A working indicator is looked at out of the corner of an eye for minutes
   at a time, so the swing is small and slow enough to read as alive rather than as an alarm. */
@keyframes orbit-glow { 0%, 100% { opacity: 0.62; } 50% { opacity: 1; } }
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
    chosen = settings["frameColor"]
    # Orbit's own blue by default, the same value the agent pointer is drawn in, because both sit over
    # a wallpaper and an application nobody chose and neither can borrow its contrast from a palette.
    # The word accent asks for the desktop's colour instead, as a name rather than a value, so the
    # glow moves with the theme instead of being pinned to whatever the accent was that day.
    value = "@accent_bg_color" if chosen == "accent" else chosen
    return SURFACE_CSS + f"\n@define-color orbit-frame-color {value};\n".encode()

def load_settings():
    """The person's choices, under their config directory; command line flags override them for one run."""
    settings, note = orbit_settings.load()
    if note:
        print(f"panel: {note}", file=sys.stderr)
    return settings


def save_settings(settings):
    failure = orbit_settings.save(settings)
    if failure:
        print(f"panel: {failure}", file=sys.stderr)


class Panel(Gtk.Application):
    def __init__(self, settings, listener=None):
        super().__init__(application_id="io.sbar.orbit.panel", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.settings = settings
        self.listener = listener
        self.settings_monitor = None
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

        self.listen_for_commands()
        self.watch_settings_file()
        self.publish_monitors()

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
        viewer = Gtk.Button(label="Open the viewer")
        viewer.add_css_class("flat")
        viewer.connect("clicked", lambda *_: self.open_viewer())
        # "A browser of my own" is gone. It read as a choice between the viewer and the person's own
        # browser, next to a button that opens the viewer, and that is not what it did: it created an
        # Orbit session, paused it, and opened the viewer on it. Two buttons that both end in the
        # viewer, one of them named after the thing this project exists NOT to touch.
        #
        # A private browser to drive by hand is still one click away, from inside the viewer where
        # every other session action already lives, so nothing was removed except the ambiguity.
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
            self.apply_region(surface, cairo.Region())
            # A hidden mark is meant to take no input, and render() settles again when it comes
            # back. A visible mark with no shape yet is mid layout, and nothing else would come
            # back to open the region again, so ask on the next turn of the loop.
            if self.mark.get_visible():
                GLib.timeout_add(120, self.settle)
            return False
        if self.expanded or self.shell.progress > 0.01:
            region = cairo.Region(cairo.RectangleInt(0, 0, width, height))
        else:
            x, y, w, h = self.shell.unprimed(head)
            # Back out to surface coordinates: the shape is measured from the shell's content box,
            # and the surface starts one padding earlier in both directions.
            pad = shell_padding(self.settings)
            region = cairo.Region(cairo.RectangleInt(int(x) + pad - 2, int(y) + pad - 2, int(w) + 4, int(h) + 4))
        self.apply_region(surface, region)
        return False

    def apply_region(self, surface, region):
        """A region reaches the compositor with the next frame this surface commits, and a mark that
        is not animating commits nothing on its own. Without the redraw the region written when the
        mark comes back after an idle spell sat in GDK unsent, and the mark drew at the edge and
        took neither a hover nor a click until something else happened to repaint it."""
        surface.set_input_region(region)
        self.shell.queue_draw()

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
        for name, edge in EDGES.items():
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
            # Which way this strip's wash fades: inward, away from the edge it is anchored to.
            body.add_css_class(name)
            if self.settings["framePulse"]:
                body.add_css_class("pulse")
            body.set_size_request(FRAME_GLOW, FRAME_GLOW)
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
            wanted = not (self.settings["hideWhenIdle"] and state in ("idle", "offline"))
            if wanted != self.mark.get_visible():
                self.mark.set_visible(wanted)
                # The input region is written once per settle, and hiding the mark writes an empty
                # one. Without this the mark drew again when work started and stayed deaf to the
                # pointer, because nothing else calls settle() until the cards open, and the cards
                # only open on a hover the empty region swallows.
                GLib.idle_add(self.settle)
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

    def open_viewer(self, view=None):
        # The viewer link carries an access token, so it is requested now and handed straight to the
        # browser rather than written anywhere. Which session to show is selected in the viewer.
        try:
            answer = rpc(self.path, "preview.open", {"launch": True, "view": view or "sessions",
                                                     "browser": self.settings["viewerBrowser"],
                                                     "appWindow": self.settings["viewerAppWindow"]})
        except Exception as error:
            print(f"panel: could not open the viewer: {error}", file=sys.stderr)
            return
        url = answer.get("url", "")
        if not viewer_link_is_local(url):
            print("panel: the broker returned something other than a local viewer link; not opening it", file=sys.stderr)
            return
        # The broker opened it in the chosen browser, which is the only path that can give the viewer a
        # window of its own. The launcher below is the fallback for a broker too old to have opened it,
        # and it always produces a tab in whatever the desktop's default browser is.
        if answer.get("opened"):
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

    def listen_for_commands(self):
        """Do what another invocation asked for, rather than letting it start a second mark."""
        if self.listener is None:
            return
        def ready(fd, condition):
            try:
                message = self.listener.recv(64)
            except OSError:
                return True
            if message.strip() == b"settings":
                GLib.idle_add(self.open_settings)
            elif message.strip() == b"viewer":
                GLib.idle_add(self.open_viewer)
            return True
        # GLibUnix where the bindings have it, GLib where they do not: the function moved and the old
        # name warns on every start, which in a service means a warning in the journal forever.
        adder = getattr(GLibUnix, "fd_add_full", None) if GLibUnix is not None else None
        (adder or GLib.unix_fd_add_full)(GLib.PRIORITY_DEFAULT, self.listener.fileno(), GLib.IOCondition.IN, ready)

    def publish_monitors(self):
        """Say which monitors exist, for the settings page in the viewer.

        Only a client of the compositor can answer this, and the viewer is a web page. So the mark,
        which is already such a client, writes the list where the broker can read it, and rewrites it
        when a screen is plugged in or unplugged. It lives in the runtime directory because it
        describes this login session and should not survive it: a stale list of yesterday's monitors is
        worse than no list, which the page renders as the monitor's name in a plain box.
        """
        monitors = self.display.get_monitors()
        runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
        path = os.path.join(runtime, "sbar-orbit", "monitors.json")

        def publish(*_):
            listed = []
            for index in range(monitors.get_n_items()):
                monitor = monitors.get_item(index)
                geometry = monitor.get_geometry()
                listed.append({"connector": monitor.get_connector() or str(index),
                               "width": geometry.width, "height": geometry.height})
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                temporary = f"{path}.{os.getpid()}"
                with open(temporary, "w", encoding="utf-8") as handle:
                    json.dump(listed, handle)
                os.replace(temporary, path)
            except OSError as error:
                print(f"panel: could not publish the monitor list ({error}); the settings page will ask for a name instead", file=sys.stderr)

        monitors.connect("items-changed", publish)
        publish()

    def watch_settings_file(self):
        """Apply a change made anywhere else, so `sbar-orbit config set` is visible on screen at once.

        The panel's own saves come back through here too, since a write and a rename both look like a
        change to the file. Comparing the loaded settings against the ones in memory is what makes that a
        no-op, and it needs no bookkeeping to stay correct.
        """
        try:
            Gio.File.new_for_path(os.path.dirname(SETTINGS_PATH)).make_directory_with_parents(None)
        except GLib.Error:
            pass
        try:
            self.settings_monitor = Gio.File.new_for_path(SETTINGS_PATH).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, None)
        except GLib.Error as error:
            print(f"panel: not watching {SETTINGS_PATH} ({error}); changes made elsewhere need a restart", file=sys.stderr)
            return
        self.settings_monitor.connect("changed", lambda *_: self.reload_settings())

    def reload_settings(self):
        stored = load_settings()
        if stored == self.settings:
            return
        moved = any(stored[key] != self.settings[key] for key in ("edge", "monitor", "margin", "size", "position"))
        self.settings = stored
        if moved:
            self.relocate()
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

    def open_settings(self):
        """Settings live in the viewer, which is where the rest of Orbit's interface already lives.

        The mark keeps what only a mark can do, and one interface is designed, translated and tested
        instead of two. Nothing about the settings themselves moved: the file is still the source of
        truth, the Python schema still validates every value, and `sbar-orbit config` still works over
        ssh, inside a service, and while no browser is running at all.
        """
        self.open_viewer(view="settings")


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
        elif flag == "--no-pulse":
            settings["framePulse"] = False
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
            print("                        [--position 0..1] [--frame|--no-frame] [--no-pulse] [--frame-color CSS] [--no-motion]")
            print("                        [--no-notifications] [--settings]")
            print(f"settings persist in {SETTINGS_PATH}; a right click on the mark opens them in the viewer")
            return 0
    # Before anything is drawn: if a panel already owns the mark, this invocation's job is to ask it and
    # leave. That is how `sbar-orbit settings` reaches a running panel, and how two autostart paths
    # produce one mark.
    listener, claim = claim_the_mark("settings" if open_settings else "ping")
    if claim == "handed":
        print("panel: a panel is already running; handed it the request instead of starting a second mark", file=sys.stderr)
        return 0
    panel = Panel(settings, listener)
    if open_settings:
        panel.connect("activate", lambda *_: GLib.idle_add(panel.open_settings))
    panel.run([])
    return 0


if __name__ == "__main__":
    sys.exit(main())
