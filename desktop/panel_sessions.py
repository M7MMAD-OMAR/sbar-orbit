"""The session cards and the detail page of the panel: what the owner reads and presses.

`Panel` owns the state (which session is selected, which Stop is awaiting its answer, which action is in
flight) and the threads; this module draws it. Every widget here is updated in place and only when the
text it shows has changed, which is what keeps the list from flickering, from taking the highlight off
the card under the pointer, and from destroying a Stop confirmation or a keyboard focus on every poll.
"""
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402

from panel_draw import label, start  # noqa: E402
from panel_broker import card_plan, short_id  # noqa: E402
from panel_text import CHIPS, clock, state_key, text  # noqa: E402

# How tall the journal may grow inside the detail page before it scrolls: six rows.
JOURNAL_HEIGHT = 150

# Spacing is a 4 pixel grid: 4 inside a group, 8 between groups, 12 around a page.
SESSIONS_CSS = b"""
.orbit-session { padding: 0; border-radius: 14px; }
.orbit-session:hover { background: alpha(@window_fg_color, 0.06); }
.orbit-select { padding: 8px 10px 4px 10px; border-radius: 14px; min-height: 0; }
.orbit-select:hover, .orbit-select:active { background: none; }
.orbit-controls { padding: 0 8px 8px 8px; }
.orbit-copy { padding: 2px 10px; min-height: 24px; border-radius: 999px; font-size: 90%; }
.orbit-controls button { padding: 2px 10px; min-height: 24px; border-radius: 999px; font-size: 90%; }
.orbit-page .orbit-controls { padding-left: 0; padding-right: 0; }
.orbit-note { font-size: 85%; padding: 0 10px 6px 10px; }
.orbit-ask { font-size: 90%; }
.orbit-page { padding: 4px 14px 4px 4px; }
.orbit-page-title { font-weight: 700; }
.orbit-key { opacity: 0.65; font-size: 90%; }
.orbit-row { padding: 2px 0; }
.orbit-mono { font-feature-settings: "tnum"; }
.orbit-chip { font-size: 80%; font-weight: 600; padding: 1px 7px; border-radius: 8px; }
.orbit-chip.offline { background: alpha(@window_fg_color, 0.35); }
.orbit-foot button { padding: 2px 10px; border-radius: 999px; font-size: 90%; }
"""


def put_text(widget, value):
    """Set a label only when it differs, so an unchanged poll does not invalidate it."""
    if widget.get_label() != value:
        widget.set_label(value)


def wrapped(value, *classes):
    """A label that wraps instead of eliding, for sentences the person has to read whole."""
    item = Gtk.Label(label=value)
    start(item)
    item.set_wrap(True)
    item.set_xalign(0.0)
    item.set_max_width_chars(34)
    for name in classes:
        item.add_css_class(name)
    return item


def session_button(words):
    """A button whose only child is its label widget. A button made with a `label` is named from that
    label by the toolkit, which overrides the accessible name set on it; this one keeps the name it is
    given, which is how a control carries the id of the session it belongs to."""
    button = Gtk.Button()
    button.set_child(Gtk.Label(label=words))
    return button


def button_words(button, words=None):
    child = button.get_child()
    if words is None:
        return child.get_label()
    if child.get_label() != words:
        child.set_label(words)
    return None


class Chip(Gtk.Label):
    """The state, as a shape and a word on a colour. Never a colour alone."""

    def __init__(self):
        super().__init__()
        self.add_css_class("orbit-chip")
        self.shown = None

    def show_state(self, key):
        if key == self.shown:
            return
        if self.shown is not None:
            self.remove_css_class(CHIPS[self.shown][1])
        glyph, colour = CHIPS[key]
        self.add_css_class(colour)
        self.set_label(f"{glyph} {text(key)}")
        self.shown = key


class Controls(Gtk.Stack):
    """Pause or Resume, Stop and Remove for one session, with Stop asking once in place.

    The question replaces the buttons rather than opening a dialog, so it cannot be lost behind another
    window and it says, on the control itself, what stopping does.
    """

    def __init__(self, panel, session_id):
        super().__init__()
        self.panel, self.session_id = panel, session_id
        self.set_hhomogeneous(False)
        self.set_vhomogeneous(False)
        self.add_css_class("orbit-controls")
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.toggle = session_button("")
        self.stop = session_button(text("stop"))
        self.remove = session_button(text("remove"))
        for button in (self.toggle, self.stop, self.remove):
            row.append(button)
        self.toggle.connect("clicked", lambda *_: panel.act("resume" if self.toggle_verb == "resume" else "pause", session_id))
        self.stop.connect("clicked", lambda *_: panel.ask_stop(session_id))
        self.remove.connect("clicked", lambda *_: panel.act("forget", session_id))
        self.toggle_verb = "pause"
        self.suffix = short_id(session_id)
        self.name(self.stop, text("stop-hint"))
        self.stop.set_tooltip_text(text("stop-hint"))
        self.name(self.remove, text("remove-hint"))
        self.remove.set_tooltip_text(text("remove-hint"))
        self.add_named(row, "buttons")

        ask = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        ask.append(wrapped(text("stop-ask"), "orbit-ask"))
        answers = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.confirm = session_button(text("stop-confirm"))
        self.confirm.add_css_class("destructive-action")
        self.cancel = session_button(text("cancel"))
        answers.append(self.confirm)
        answers.append(self.cancel)
        ask.append(answers)
        self.confirm.connect("clicked", lambda *_: panel.act("stop", session_id))
        self.cancel.connect("clicked", lambda *_: panel.ask_stop(None))
        self.add_named(ask, "ask")
        self.name(self.confirm, text("stop-confirm"))
        self.name(self.cancel, text("cancel"))
        self.set_visible_child_name("buttons")
        self.asking = False

    def name(self, button, words):
        """The accessible name carries the session's id, so a control is addressed by which session it
        belongs to and not by where it happens to be drawn."""
        button.update_property([Gtk.AccessibleProperty.LABEL], [f"{words} [{self.suffix}]"])

    def update(self, session, busy):
        key = state_key(session)
        over = key in ("closed", "closing")
        verb = "resume" if key in ("paused",) else "pause"
        if verb != self.toggle_verb or not button_words(self.toggle):
            self.toggle_verb = verb
            button_words(self.toggle, text(verb))
            self.name(self.toggle, text(f"{verb}-hint"))
            self.toggle.set_tooltip_text(text(f"{verb}-hint"))
        self.toggle.set_visible(not over)
        # A pause is acknowledged before it can be undone; the broker refuses a resume until then.
        self.toggle.set_sensitive(not busy and key != "pausing")
        self.stop.set_visible(not over)
        self.stop.set_sensitive(not busy)
        self.remove.set_visible(key == "closed")
        self.remove.set_sensitive(not busy)
        self.confirm.set_sensitive(not busy)
        asking = self.panel.confirming == self.session_id and not over
        if asking != self.asking:
            self.asking = asking
            self.set_visible_child_name("ask" if asking else "buttons")
            if asking:
                self.cancel.grab_focus()
        self.set_visible(not (over and key == "closing"))


class SessionCard(Gtk.Box):
    """One session: who, what, where and in what state, then the controls. Selecting it opens the detail."""

    def __init__(self, panel, session_id):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.panel, self.session_id = panel, session_id
        self.add_css_class("orbit-session")
        self.select = Gtk.Button()
        self.select.add_css_class("flat")
        self.select.add_css_class("orbit-select")
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.agent = label("", "orbit-title")
        self.agent.set_hexpand(True)
        self.chip = Chip()
        head.append(self.agent)
        head.append(self.chip)
        self.task = label("")
        self.where = label("", "orbit-dim")
        self.meta = label("", "orbit-dim", "orbit-mono")
        for part in (head, self.task, self.where, self.meta):
            column.append(part)
        self.select.set_child(column)
        self.select.connect("clicked", lambda *_: panel.show_detail(session_id))
        self.append(self.select)
        self.controls = Controls(panel, session_id)
        self.append(self.controls)
        self.note = wrapped("", "orbit-dim", "orbit-note")
        self.note.set_visible(False)
        self.append(self.note)

    def update(self, session, busy, note):
        key = state_key(session)
        presence = session.get("presence") or {}
        handoff = session.get("handoff") or {}
        agent = session.get("agentName") or "Agent"
        task = session.get("taskName", "")
        put_text(self.agent, agent)
        self.chip.show_state(key)
        put_text(self.task, task)
        line = self.where_line(session, presence)
        put_text(self.where, line)
        self.where.set_visible(bool(line))
        workspace = handoff.get("workspace")
        parts = [text("workspace", n=workspace) if workspace is not None else text("no-workspace")]
        when = clock(session.get("lastActivityAt"))
        if when:
            parts.append(text("last-activity", time=when))
        put_text(self.meta, "  ·  ".join(f"⁨{p}⁩" for p in parts))
        description = text("label-card", agent=agent, task=task, state=text(key))
        self.select.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                    [f"{description} [{short_id(self.session_id)}]", text("details")])
        self.controls.update(session, busy)
        put_text(self.note, note or "")
        self.note.set_visible(bool(note))

    @staticmethod
    def where_line(session, presence):
        """The window the session is working in. The application and its window title are one string in
        Orbit's presence, so this shows that string and, when the session has several windows, how many."""
        windows = presence.get("tabs") or []
        title = presence.get("title") or ""
        parts = [title] if title and title != "Native target not selected" else []
        if len(windows) > 1:
            parts.append(f"{len(windows)}")
        return "  ·  ".join(f"⁨{p}⁩" for p in parts)


class SessionList(Gtk.Box):
    """The cards, keyed by session id and updated in place. A card is created when its session first
    appears and destroyed when it leaves; nothing is rebuilt in between."""

    def __init__(self, panel):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.panel = panel
        self.cards = {}
        self.empty = label("", "orbit-dim")
        self.append(self.empty)

    def update(self, sessions, reachable, frozen=False):
        """Bring the cards up to date. Returns whether the set or the order of cards changed.

        While frozen, the cards that are there are refreshed in place and none is added, removed or moved,
        so a session starting or ending cannot shift a control away from under the pointer."""
        panel = self.panel
        by_id = {s["sessionId"]: s for s in sessions}
        shown = [c.session_id for c in self.card_order()]
        wanted = [s["sessionId"] for s in sessions]
        plan = card_plan(shown, wanted, frozen)
        previous = None
        for session_id in plan:
            card = self.cards.get(session_id)
            if card is None:
                card = self.cards[session_id] = SessionCard(panel, session_id)
                self.insert_child_after(card, previous if previous is not None else self.empty)
            elif card.get_prev_sibling() is not (previous if previous is not None else self.empty):
                self.reorder_child_after(card, previous if previous is not None else self.empty)
            session = by_id.get(session_id)
            if session is not None:
                card.update(session, session_id in panel.busy, panel.notes.get(session_id))
            else:
                # Gone from the broker while the list is held still: keep the card, and make it inert.
                card.set_sensitive(False)
            previous = card
        for session_id in [i for i in self.cards if i not in plan]:
            self.remove(self.cards.pop(session_id))
        put_text(self.empty, "" if plan else text("offline" if not reachable else "no-sessions"))
        self.empty.set_visible(not plan)
        return plan != shown

    def card_order(self):
        child = self.empty.get_next_sibling()
        while child is not None:
            yield child
            child = child.get_next_sibling()


class DetailPage(Gtk.Box):
    """What the agent is doing and whether it worked: the target window, the handoff, and the journal."""

    def __init__(self, panel):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.panel = panel
        self.session_id = None
        self.add_css_class("orbit-page")
        self.set_size_request(280, -1)
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.back = Gtk.Button(label=text("back"))
        self.back.add_css_class("flat")
        self.back.connect("clicked", lambda *_: panel.show_list())
        self.back.update_property([Gtk.AccessibleProperty.LABEL], [text("back")])
        self.title = label("", "orbit-page-title")
        self.title.set_hexpand(True)
        self.chip = Chip()
        self.chip.set_valign(Gtk.Align.CENTER)
        bar.append(self.back)
        bar.append(self.title)
        bar.append(self.chip)
        self.append(bar)
        self.task = wrapped("")
        self.append(self.task)

        self.grid = Gtk.Grid(column_spacing=12, row_spacing=4)
        self.fields = {}
        for index, key in enumerate(("target", "workspace", "scope", "clipboard", "activity")):
            name = label(text(f"f-{key}"), "orbit-key")
            value = wrapped("", "orbit-mono")
            self.grid.attach(name, 0, index, 1, 1)
            self.grid.attach(value, 1, index, 1, 1)
            self.fields[key] = value
        self.append(self.grid)
        self.controls = None
        # Controls and Copy report share one row, above the journal, so neither scrolls out of reach.
        actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.controls_slot = Gtk.Box()
        actions.append(self.controls_slot)
        self.copy = Gtk.Button(label=text("copy-report"))
        self.copy.add_css_class("orbit-copy")
        self.copy.set_halign(Gtk.Align.START)
        self.copy.connect("clicked", lambda *_: panel.copy_report(self.session_id))
        self.copy.update_property([Gtk.AccessibleProperty.LABEL], [text("copy-report")])
        self.status = label("", "orbit-dim")
        copying = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        copying.add_css_class("orbit-controls")
        copying.append(self.copy)
        copying.append(self.status)
        actions.append(copying)
        self.append(actions)

        self.append(label(text("recent"), "orbit-key"))
        self.list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        # The journal scrolls inside the page, a few rows tall, so the controls above it never scroll
        # out of reach however long the session has been running.
        self.journal_view = Gtk.ScrolledWindow()
        self.journal_view.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.journal_view.set_propagate_natural_height(True)
        self.journal_view.set_max_content_height(JOURNAL_HEIGHT)
        self.journal_view.set_child(self.list)
        self.append(self.journal_view)
        self.rows_signature = None
        self.empty = label(text("no-actions"), "orbit-dim")

    def open(self, session_id):
        self.session_id = session_id
        self.rows_signature = None
        if self.controls is not None:
            self.controls_slot.remove(self.controls)
        self.controls = Controls(self.panel, session_id)
        self.controls_slot.append(self.controls)
        put_text(self.status, "")

    def update(self, session):
        if session is None:
            return
        presence = session.get("presence") or {}
        handoff = session.get("handoff") or {}
        key = state_key(session)
        put_text(self.title, session.get("agentName") or "Agent")
        self.chip.show_state(key)
        put_text(self.task, session.get("taskName", ""))
        title = presence.get("title") or ""
        if not title or title == "Native target not selected":
            title = text("no-target")
        put_text(self.fields["target"], title)
        workspace = handoff.get("workspace")
        put_text(self.fields["workspace"], str(workspace) if workspace is not None else text("no-workspace"))
        scope = handoff.get("scope")
        put_text(self.fields["scope"], text(f"scope-{scope}") if scope and text(f"scope-{scope}") != f"scope-{scope}" else (scope or "-"))
        clipboard = handoff.get("clipboard")
        put_text(self.fields["clipboard"], text(f"clipboard-{clipboard}") if clipboard and text(f"clipboard-{clipboard}") != f"clipboard-{clipboard}" else (clipboard or "-"))
        put_text(self.fields["activity"], clock(session.get("lastActivityAt")) or "-")
        if self.controls is not None:
            self.controls.update(session, session["sessionId"] in self.panel.busy)

    def set_rows(self, rows):
        """Rebuilt only when the journal moved. Each row is the time, the action, and how it ended,
        with a mark as well as a word so a denial is not told apart by colour alone."""
        signature = tuple((r["sequence"], r["outcome"]) for r in rows)
        if signature == self.rows_signature:
            return
        self.rows_signature = signature
        child = self.list.get_first_child()
        while child is not None:
            following = child.get_next_sibling()
            self.list.remove(child)
            child = following
        if not rows:
            self.list.append(self.empty)
            return
        for row in rows:
            allowed = row["outcome"] == "allow"
            mark = "✓" if allowed else "✕"
            result = text("allowed" if allowed else "denied") if row["outcome"] in ("allow", "deny") else row["outcome"]
            line = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            line.add_css_class("orbit-row")
            when = label(clock(row["at"]) or "-", "orbit-dim", "orbit-mono")
            what = label(row["action"])
            what.set_hexpand(True)
            outcome = label(f"{mark} {result}", "orbit-mono")
            for part in (when, what, outcome):
                line.append(part)
            detail = f"{row['action']}, {result}" + (f", {row['reason']}" if row["reason"] else "")
            line.update_property([Gtk.AccessibleProperty.LABEL], [f"{clock(row['at'])}: {detail}"])
            if row["reason"]:
                line.set_tooltip_text(row["reason"])
            self.list.append(line)
