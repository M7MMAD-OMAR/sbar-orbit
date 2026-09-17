"""The panel's body, drawn rather than styled, and the two widgets that carry it.

Split out of `panel.py`. Everything here is geometry and paint: the easing curves, the outline of the
capsule and the card and the neck between them, the glass fill, and the widgets that draw them. It
knows nothing about the broker or the settings file, and takes the panel it draws for as an object it
only reads from.

Importing this needs the GTK versions already pinned, which `panel.py` does before importing it. The
`require_version` calls below are what let it be imported on its own too; they are a no-op once the
same version is loaded.
"""
import math

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Graphene", "1.0")
from gi.repository import Gdk, GLib, Graphene, Gtk  # noqa: E402

import cairo  # noqa: E402


# The open and close morph. Long enough to read as a liquid, short enough that the cards are there
# before the hand has settled.
MORPH_MS = 380
# How far apart the capsule and the card may drift before the neck between them lets go.
NECK_SPAN = 26.0
NECK_RADIUS = 15.0
# Transparent room left around the capsule so the pointer has something to hit near the screen edge.
MARK_PADDING = 7
# How solid the part of the body with words on it is, whatever the blend setting says. Transparency
# is worth having over a wallpaper, and it is unreadable over a terminal full of text; the card is
# the half that is read, so it never drops below this. Nothing of the glass is lost by it, because
# what makes this shape read as glass is the gradient down it and the light along its top edge,
# not what shows through it.
CARD_FLOOR = 0.97


def shell_padding(settings):
    """Transparent room around the mark: a target the pointer can hit near the screen edge, and the
    space the shadow and the capsule are drawn into. It is CSS padding, so GTK starts a widget's own
    drawing inside it and every coordinate below is relative to that inner box."""
    return max(6, int(settings["size"]))


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


def source(cr, paint):
    """Set either a plain colour or a ready-made pattern on the context, so a caller that has a
    gradient to lay down and a caller that has four numbers can both go through the same drawing."""
    if isinstance(paint, cairo.Pattern):
        cr.set_source(paint)
    else:
        cr.set_source_rgba(*paint)


def body_paint(head, tail, fill):
    """The gradient the body is filled with, built in the primed space where the card always grows
    downward out of the capsule.

    Two jobs in one pattern. Down the capsule it holds the blend the person set, which is where
    seeing the wallpaper through the panel is the whole point and where there is nothing to read.
    Over the card it climbs to `CARD_FLOOR`, so a row of text sits on a solid surface no matter what
    is behind the panel. The climb happens across the neck, in the few pixels where the two shapes
    are already narrowing into each other, so it reads as depth in one body of glass rather than as
    a line drawn across it.
    """
    red, green, blue, base = fill
    top = head[1]
    bottom = (tail[1] + tail[3]) if tail is not None else (head[1] + head[3])
    span = max(1.0, bottom - top)
    pattern = cairo.LinearGradient(0.0, top, 0.0, bottom)
    if tail is None:
        pattern.add_color_stop_rgba(0.0, red, green, blue, base)
        pattern.add_color_stop_rgba(1.0, red, green, blue, base)
        return pattern
    solid = max(base, CARD_FLOOR)
    # A touch of light carried into the top of the card, the way a lit pane of glass is brightest
    # where it catches the edge. Added to the colour rather than blended with white, so a light
    # theme lifts as little as a dark one does.
    lift = 0.05
    neck_top = clamp((head[1] + head[3] - top) / span)
    card_top = clamp((tail[1] + 3.0 - top) / span)
    pattern.add_color_stop_rgba(0.0, red, green, blue, base)
    pattern.add_color_stop_rgba(neck_top, red, green, blue, base)
    pattern.add_color_stop_rgba(max(neck_top, card_top),
                                min(1.0, red + lift), min(1.0, green + lift), min(1.0, blue + lift), solid)
    pattern.add_color_stop_rgba(1.0, red, green, blue, solid)
    return pattern


def body_sheen(head, tail, fill):
    """The light along the top edge, which is the half of the glass that transparency was carrying.

    A hairline of white, brightest where the body meets the light and gone before it reaches the
    card, stroked over the rim. It is what keeps a nearly solid card reading as a pane rather than
    as a box. Its weight follows how dark the surface is: a highlight is what a dark pane is lit by,
    and on a light theme the same stroke at the same strength would only wash the edge out.

    Only the open body gets one. A closed capsule is a few pixels of a shape the person recognises,
    it is still at their own blend, and a bright lip along the top of it would read as a change to
    the mark rather than as light on glass.
    """
    red, green, blue = fill[0], fill[1], fill[2]
    strength = 0.16 + 0.24 * clamp(1.0 - (0.2126 * red + 0.7152 * green + 0.0722 * blue))
    top = head[1]
    bottom = (tail[1] + tail[3]) if tail is not None else (head[1] + head[3])
    fade = min(max(1.0, bottom - top), head[3] * 2.4)
    pattern = cairo.LinearGradient(0.0, top, 0.0, top + fade)
    pattern.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, strength)
    pattern.add_color_stop_rgba(0.55, 1.0, 1.0, 1.0, strength * 0.35)
    pattern.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.0)
    return pattern


def glass(cr, build, fill, edge, shadow=1.0, lift=(0.0, 2.0), sheen=None):
    """Fill an outline, over a soft shadow and under a hairline edge.

    Cairo has no blur, and a blur on this renderer would cost more than the whole panel does. Four
    strokes of the same outline, each wider and fainter than the last, give a shadow that is close
    enough at this size and stays inside a tenth of a millisecond.

    `fill` is a colour or a pattern; `sheen`, when given, is a second hairline stroked over the edge
    and is where the pane catches the light.
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
    source(cr, fill)
    cr.fill_preserve()
    cr.set_line_width(1.0)
    source(cr, edge)
    if sheen is None:
        cr.stroke()
        return
    cr.stroke_preserve()
    cr.set_source(sheen)
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
        # Built per frame rather than cached with the colours: both patterns are cut to the shape the
        # morph is passing through, and a gradient over a few hundred pixels costs nothing next to
        # the theme lookup the cache exists to avoid.
        glass(cr, lambda ctx: body_path(ctx, head, tail, neck, head_radius, tail_radius),
              body_paint(head, tail, fill), rim, lift=self.LIFT[self.panel.settings["edge"]],
              sheen=body_sheen(head, tail, fill) if tail is not None else None)
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
