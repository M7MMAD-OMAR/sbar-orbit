"""Owner-started visual guide. It renders overlays and never sends input."""
import argparse
import json
import os
import signal
import stat
import sys
from pathlib import Path


def read_position(path, width, height):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_size > 1024):
            raise ValueError('State must be an owned private regular file of at most 1024 bytes')
        raw = os.read(descriptor, 1025)
        if len(raw) > 1024:
            raise ValueError('State exceeds 1024 bytes')
        state = json.loads(raw)
    finally:
        os.close(descriptor)
    if not isinstance(state, dict) or set(state) != {'x', 'y'}:
        raise ValueError('State requires exactly x and y')
    if any(type(state[key]) is not int for key in ['x', 'y']):
        raise ValueError('Coordinates must be integers')
    if not 0 <= state['x'] < width or not 0 <= state['y'] < height:
        raise ValueError('Coordinates are outside the selected monitor')
    return state['x'], state['y']


def main():
    parser = argparse.ArgumentParser(description='Orbit visual guide preview. No mouse or keyboard input.')
    parser.add_argument('--state', type=Path, required=True, help='Absolute private JSON file containing x and y')
    parser.add_argument('--monitor', required=True, help='Exact GDK monitor model; ambiguous matches are refused')
    parser.add_argument('--seconds', type=int, default=300, help='Preview duration, 1 to 600 seconds')
    args = parser.parse_args()
    if not args.state.is_absolute() or not 1 <= args.seconds <= 600:
        parser.error('State must be absolute and seconds must be between 1 and 600')
    if sys.platform != 'linux':
        parser.error('Orbit visual guide requires Linux and a supporting Wayland display')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'native'))
    from budget import require_budget
    require_budget()

    import cairo
    import gi

    gi.require_version('Gtk', '3.0')
    gi.require_version('GtkLayerShell', '0.1')
    from gi.repository import Gtk, Gdk, GLib, GtkLayerShell

    if not GtkLayerShell.is_supported():
        raise RuntimeError('The selected display must support layer shell; no windows were created')
    display = Gdk.Display.get_default()
    matches = [display.get_monitor(i) for i in range(display.get_n_monitors())
               if display.get_monitor(i).get_model() == args.monitor]
    if len(matches) != 1:
        raise RuntimeError('Monitor model must match exactly one connected output')
    monitor = matches[0]
    read_position(args.state, monitor.get_geometry().width, monitor.get_geometry().height)
    windows = []
    edges = GtkLayerShell.Edge

    def draw(widget, context, side):
        width, height = widget.get_allocated_width(), widget.get_allocated_height()
        context.set_operator(cairo.OPERATOR_SOURCE)
        context.set_source_rgba(0, 0, 0, 0)
        context.paint()
        context.set_operator(cairo.OPERATOR_OVER)
        start_end = {'top': (0, 0, 0, height), 'bottom': (0, height, 0, 0),
                     'left': (0, 0, width, 0), 'right': (width, 0, 0, 0)}[side]
        gradient = cairo.LinearGradient(*start_end)
        gradient.add_color_stop_rgba(0, 0.12, 0.82, .90, .65)
        gradient.add_color_stop_rgba(.12, 0.12, 0.82, .90, .22)
        gradient.add_color_stop_rgba(1, 0.05, 0.85, 1, 0)
        context.set_source(gradient)
        context.paint()
        return False

    for side, edge in [('top', edges.TOP), ('bottom', edges.BOTTOM),
                       ('left', edges.LEFT), ('right', edges.RIGHT)]:
        window = Gtk.Window()
        window.set_title('Codex active screen')
        window.set_app_paintable(True)
        window.set_visual(window.get_screen().get_rgba_visual())
        GtkLayerShell.init_for_window(window)
        GtkLayerShell.set_namespace(window, 'codex-authorized-demo-glow')
        GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
        GtkLayerShell.set_monitor(window, monitor)
        GtkLayerShell.set_exclusive_zone(window, -1)
        GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.NONE)
        GtkLayerShell.set_anchor(window, edge, True)
        horizontal = side in ('top', 'bottom')
        for anchor in ([edges.LEFT, edges.RIGHT] if horizontal else [edges.TOP, edges.BOTTOM]):
            GtkLayerShell.set_anchor(window, anchor, True)
        window.set_size_request(18, 18)
        window.connect('draw', draw, side)
        window.connect('realize', lambda w: w.get_window().input_shape_combine_region(cairo.Region(), 0, 0))
        window.show_all()
        windows.append(window)

    badge = Gtk.Window()
    badge.set_title('Orbit')
    badge.set_app_paintable(True)
    badge.set_visual(badge.get_screen().get_rgba_visual())
    GtkLayerShell.init_for_window(badge)
    GtkLayerShell.set_namespace(badge, 'codex-authorized-demo-label')
    GtkLayerShell.set_layer(badge, GtkLayerShell.Layer.OVERLAY)
    GtkLayerShell.set_monitor(badge, monitor)
    GtkLayerShell.set_exclusive_zone(badge, -1)
    GtkLayerShell.set_keyboard_mode(badge, GtkLayerShell.KeyboardMode.NONE)
    GtkLayerShell.set_anchor(badge, edges.TOP, True)
    GtkLayerShell.set_margin(badge, edges.TOP, 40)
    badge.set_size_request(140, 48)

    def rounded(context, x, y, width, height, radius):
        from math import pi
        context.new_sub_path()
        context.arc(x + width - radius, y + radius, radius, -pi / 2, 0)
        context.arc(x + width - radius, y + height - radius, radius, 0, pi / 2)
        context.arc(x + radius, y + height - radius, radius, pi / 2, pi)
        context.arc(x + radius, y + radius, radius, pi, 3 * pi / 2)
        context.close_path()

    def clear(context):
        context.set_operator(cairo.OPERATOR_SOURCE)
        context.set_source_rgba(0, 0, 0, 0)
        context.paint()
        context.set_operator(cairo.OPERATOR_OVER)

    def draw_badge(widget, context):
        clear(context)
        rounded(context, 4, 6, 132, 38, 19)
        context.set_source_rgba(0, 0, 0, .20)
        context.fill()
        rounded(context, 4, 3, 132, 38, 19)
        context.set_source_rgba(.07, .085, .095, .96)
        context.fill_preserve()
        context.set_line_width(1)
        context.set_source_rgba(.65, .8, .85, .22)
        context.stroke()
        context.save()
        context.translate(25, 22)
        context.rotate(-.5)
        context.scale(1.2, .75)
        context.arc(0, 0, 8, 0, 6.283)
        context.set_source_rgba(.36, .9, .91, 1)
        context.set_line_width(1.8)
        context.stroke()
        context.restore()
        context.arc(25, 22, 2.4, 0, 6.283)
        context.set_source_rgba(.36, .9, .91, 1)
        context.fill()
        context.select_font_face('Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        context.set_font_size(16)
        context.set_source_rgba(.92, .95, .96, 1)
        context.move_to(44, 28)
        context.show_text('Orbit')
        context.arc(115, 22, 3.5, 0, 6.283)
        context.set_source_rgba(.36, .9, .91, 1)
        context.fill()
        return False

    badge.connect('draw', draw_badge)
    badge.connect('realize', lambda w: w.get_window().input_shape_combine_region(cairo.Region(), 0, 0))
    badge.show_all()
    windows.append(badge)

    cursor = Gtk.Window()
    cursor.set_title('Codex demo visual pointer')
    cursor.set_app_paintable(True)
    cursor.set_visual(cursor.get_screen().get_rgba_visual())
    GtkLayerShell.init_for_window(cursor)
    GtkLayerShell.set_namespace(cursor, 'codex-demo-visual-pointer')
    GtkLayerShell.set_layer(cursor, GtkLayerShell.Layer.OVERLAY)
    GtkLayerShell.set_monitor(cursor, monitor)
    GtkLayerShell.set_exclusive_zone(cursor, -1)
    GtkLayerShell.set_keyboard_mode(cursor, GtkLayerShell.KeyboardMode.NONE)
    GtkLayerShell.set_anchor(cursor, edges.TOP, True)
    GtkLayerShell.set_anchor(cursor, edges.LEFT, True)
    cursor.set_size_request(128, 54)
    cursor.connect('realize', lambda w: w.get_window().input_shape_combine_region(cairo.Region(), 0, 0))

    def draw_cursor(widget, context):
        clear(context)
        rounded(context, 39, 16, 78, 28, 14)
        context.set_source_rgba(0, 0, 0, .2)
        context.fill()
        rounded(context, 39, 13, 78, 28, 14)
        context.set_source_rgba(.07, .085, .095, .96)
        context.fill_preserve()
        context.set_source_rgba(.36, .9, .91, .3)
        context.set_line_width(1)
        context.stroke()
        context.move_to(5, 5)
        for point in [(7, 36), (15, 28), (23, 42), (30, 38), (22, 25), (34, 24)]:
            context.line_to(*point)
        context.close_path()
        context.set_source_rgba(.28, .86, .91, 1)
        context.fill_preserve()
        context.set_source_rgba(.015, .07, .09, .75)
        context.set_line_width(3)
        context.stroke_preserve()
        context.set_source_rgba(.88, 1, 1, 1)
        context.set_line_width(1.2)
        context.stroke()
        context.set_source_rgba(.9, .95, .96, 1)
        context.select_font_face('Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        context.set_font_size(13)
        context.move_to(53, 32)
        context.show_text('Codex')
        return False

    cursor.connect('draw', draw_cursor)
    cursor.show_all()
    windows.append(cursor)
    position = None

    def update_cursor():
        nonlocal position
        try:
            new_position = read_position(args.state, monitor.get_geometry().width, monitor.get_geometry().height)
            if new_position != position:
                GtkLayerShell.set_margin(cursor, edges.LEFT, max(0, new_position[0] - 5))
                GtkLayerShell.set_margin(cursor, edges.TOP, max(0, new_position[1] - 5))
                position = new_position
        except (OSError, ValueError, KeyError):
            cursor.hide()
            badge.hide()
            for strip in windows[:4]:
                strip.hide()
            return False
        return True

    update_cursor()
    GLib.timeout_add(100, update_cursor)
    GLib.timeout_add_seconds(args.seconds, lambda: Gtk.main_quit() or False)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: Gtk.main_quit() or False)
    Gtk.main()


if __name__ == '__main__':
    main()
