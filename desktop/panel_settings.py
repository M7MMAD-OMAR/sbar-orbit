"""The settings page of the desktop panel, drawn from `orbit_settings.SCHEMA` and nothing else.

Contract, for the module that wires it into the panel (`desktop/panel.py`):

    page = panel_settings.build_settings_page(app, path=None, language=None, autostart=None)

* Returns a `Gtk.Box` (vertical) holding a search box, a scrolling list of grouped settings and a footer
  with the settings file path. Place it in any container; it asks for no window of its own and sets no
  size beyond a small minimum, so the panel decides how large it is.
* Import is safe without a display and without GTK being usable: nothing here touches GTK until
  `build_settings_page` runs. The pure helpers (`grouped`, `validate_text`, `applies_text`, `wording`)
  need neither, and the tests exercise them directly.
* `app` is optional. A `language` attribute on it ("ar" or "en") picks the language; otherwise the
  `language` argument, otherwise the locale. Arabic sets the page right to left, so everything follows
  the logical start and end. Digits stay Western and no clock is drawn.
* `path` is the settings file; `None` is the real one, `orbit_settings.SETTINGS_PATH`. Every write goes
  through `orbit_settings.coerce` and `orbit_settings.save`, after re-reading the file, so a value
  another writer set (the `sbar-orbit config` command, the panel dragging the mark) is kept. The page
  watches the file and redraws its controls when something else changed it, so the CLI and the page
  never disagree. The running panel is watching the same file and reloads on its own.
* `autostart` is `None` for the real thing (`orbit_settings.autostart`, which runs
  `sbar-orbit autostart`), or an object with `status() -> bool | None` and `set(bool) -> bool` for a
  harness that must not touch the owner's real units.
* Each row says when it applies. Settings with `applies == "handoff"` (frame, framePulse, frameColor)
  are read once when the worker takes a window, so the row says "Applies at the next handoff" instead
  of looking dead. Everything else says "Applies now".
* The returned widget has `refresh()` (re-read the file), `set_query(text)` (what the search box
  does), `visible_keys()` and `path`, for the panel and for the harness.

There is no setting here for a component that cannot read it. The ghost cursor's curve strength, idle
drift and reduced motion are constants inside the compositor plugin (`kBowMax`, `kDriftMax`) with no
command that carries a value, so they are not offered; see docs/panel-control-plan.md.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orbit_settings  # noqa: E402

LRI, PDI = "\u2066", "\u2069"
CHANGE_DELAY_MS = 220
NOTICE_MS = 2400

UI = {
    "en": {
        "title": "Settings", "search": "Search settings", "reset": "Reset", "reset_all": "Reset all",
        "reset_all_ask": "Put every setting back to its default?", "confirm": "Reset", "cancel": "Cancel",
        "now": "Applies now", "handoff": "Applies at the next handoff",
        "path": "Settings file", "copy": "Copy path", "copied": "Copied", "saved": "Saved", "none": "No setting matches that.",
        "automatic": "Automatic", "accent": "Follow the desktop accent", "preview": "Preview",
        "checking": "Checking", "no_launcher": "Could not reach the launcher, so this cannot be changed here.",
        "unreadable": "The settings file could not be read, so defaults are shown.", "default": "Default",
        "lease": "Read when the worker takes a window", "hex": "Colour as #rrggbb",
    },
    "ar": {
        "title": "الإعدادات", "search": "ابحث في الإعدادات", "reset": "استعادة", "reset_all": "استعادة الكل",
        "reset_all_ask": "هل تعيد كل إعداد إلى قيمته الافتراضية؟", "confirm": "استعادة", "cancel": "إلغاء",
        "now": "يسري فورا", "handoff": "يسري عند التسليم التالي",
        "path": "ملف الإعدادات", "copy": "انسخ المسار", "copied": "تم النسخ", "saved": "تم الحفظ", "none": "لا يوجد إعداد يطابق ذلك.",
        "automatic": "تلقائي", "accent": "اتبع لون سطح المكتب", "preview": "معاينة",
        "checking": "جار الفحص", "no_launcher": "تعذر الوصول إلى المشغل، لذلك لا يمكن تغيير هذا من هنا.",
        "unreadable": "تعذرت قراءة ملف الإعدادات، فتظهر القيم الافتراضية.", "default": "الافتراضي",
        "lease": "يقرأها العامل عند أخذ النافذة", "hex": "اللون بصيغة #rrggbb",
    },
}
# The words for the values a choice can take. Not in the schema's ARABIC table because they are values,
# not settings; they sit beside the page that shows them.
CHOICES_AR = {
    "left": "يسار", "right": "يمين", "top": "أعلى", "bottom": "أسفل",
    "mark": "الشعار", "bar": "كبسولة", "dot": "نقطة", "count": "عدد",
    "idle": "ساكن", "working": "يعمل", "paused": "متوقف مؤقتا", "offline": "غير مشغل",
}
CHOICES_EN = {"mark": "Logo", "bar": "Capsule", "dot": "Dot", "count": "Count", "idle": "Idle", "working": "Working",
              "paused": "Paused", "offline": "Offline"}

CSS = b"""
@define-color orbit_set_fg @window_fg_color;
.orbit-settings { color: @window_fg_color; }
.orbit-set-group { font-weight: 700; font-size: 105%; padding-top: 14px; padding-bottom: 2px; }
.orbit-set-row { padding: 8px 10px; border-radius: 14px; background: alpha(@window_fg_color, 0.045); margin-bottom: 4px; }
.orbit-set-label { font-weight: 600; }
.orbit-set-desc { opacity: 0.66; font-size: 88%; }
.orbit-set-chip { font-size: 78%; font-weight: 600; padding: 1px 8px; border-radius: 8px; }
.orbit-set-chip.now { background: alpha(#2e9e5b, 0.20); color: #2e9e5b; }
.orbit-set-chip.handoff { background: alpha(#e08a00, 0.20); color: #e08a00; }
.orbit-set-error { color: #d33; font-size: 88%; font-weight: 600; }
.orbit-set-note { opacity: 0.7; font-size: 88%; }
.orbit-set-value { font-feature-settings: "tnum"; min-width: 44px; opacity: 0.8; }
.orbit-set-seg button { padding: 4px 4px; min-width: 0; font-size: 92%; }
.orbit-set-reset { padding: 1px 8px; border-radius: 999px; font-size: 88%; }
.orbit-set-swatch { min-width: 38px; }
.orbit-set-preview { border-radius: 14px; background: alpha(#000000, 0.35); }
.orbit-set-foot { padding: 8px 4px; }
.orbit-set-path { font-family: monospace; font-size: 88%; opacity: 0.8; }
"""


# ---------------------------------------------------------------------------------------------- pure

def language_of(app=None, language=None):
    """"ar" or "en". The argument wins, then the app, then the locale; anything else is English."""
    for chosen in (language, getattr(app, "language", None)):
        if chosen in UI:
            return chosen
    locale = (os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG") or "").lower()
    return "ar" if locale.startswith("ar") else "en"


def text(language, key):
    return UI[language][key]


def wording(entry, language):
    """(group, label, description) of a setting in one language. The schema owns the Arabic."""
    if language == "ar":
        return tuple(orbit_settings.ARABIC.get(entry[field], entry[field]) for field in ("group", "label", "description"))
    return entry["group"], entry["label"], entry["description"]


def choice_name(value, language):
    if language == "ar":
        return CHOICES_AR.get(value, str(value))
    return CHOICES_EN.get(value, str(value).capitalize())


def applies_text(entry, language):
    """When a change reaches the thing it changes, said on the row."""
    return text(language, "handoff" if entry.get("applies") == "handoff" else "now")


def grouped(query="", language="en"):
    """[(group name in the page's language, [entries])] for the settings a query matches, in schema order.
    The match is the schema's own, so a word that finds a setting at a terminal finds it here."""
    found = orbit_settings.search(query)
    order = []
    for entry in found:
        if entry["group"] not in order:
            order.append(entry["group"])
    return [(orbit_settings.ARABIC.get(group, group) if language == "ar" else group,
             [entry for entry in found if entry["group"] == group]) for group in order]


def validate_text(key, value):
    """What a typed value would be and what to tell the person: (value, message). A value that is
    refused has no value; a clamped one has both, so the row can show the number it kept."""
    coerced, note = orbit_settings.coerce(key, value)
    return coerced, note


def hex_message(value, language):
    """The inline complaint about a colour typed by hand, or None when it is usable."""
    typed = value.strip()
    if typed.casefold() == "accent" or orbit_settings.is_hex(typed):
        return None
    # Isolated left to right, so a colour inside an Arabic sentence keeps its hash where it belongs.
    return f"{text(language, 'hex').replace('#rrggbb', LRI + '#rrggbb' + PDI)}: {LRI}{typed[:20]}{PDI}" if typed else text(language, "hex").replace("#rrggbb", LRI + "#rrggbb" + PDI)


def to_hex(rgba):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(channel * 255))) for channel in (rgba.red, rgba.green, rgba.blue))


class RealAutostart:
    """The launcher's answer, through the schema's own helper."""
    def status(self):
        return orbit_settings.autostart_value()

    def set(self, enabled):
        return orbit_settings.autostart("enable" if enabled else "disable") is not None


# --------------------------------------------------------------------------------------------- GTK

def build_settings_page(app=None, path=None, language=None, autostart=None):
    """The page. See the module docstring for the contract."""
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    gi.require_version("Pango", "1.0")
    gi.require_version("PangoCairo", "1.0")
    from gi.repository import Gdk, Gio, GLib, Gtk, Pango, PangoCairo
    import threading

    lang = language_of(app, language)
    target = path or orbit_settings.SETTINGS_PATH
    backend = autostart if autostart is not None else RealAutostart()
    display = Gdk.Display.get_default()
    if display is not None and not getattr(Gtk, "_orbit_settings_css", False):
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        Gtk._orbit_settings_css = True

    def label(content, *classes, wrap=True):
        widget = Gtk.Label(label=content, xalign=0.0, wrap=wrap, hexpand=False)
        # Text that wraps takes the full width it is given. Left to its natural width a wrapped label
        # breaks well short of the row's edge. Badges and one line labels keep their own size.
        widget.set_halign(Gtk.Align.FILL if wrap and "orbit-set-chip" not in classes else Gtk.Align.START)
        for name in classes:
            widget.add_css_class(name)
        return widget

    class Page(Gtk.Box):
        def __init__(self):
            super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            self.add_css_class("orbit-settings")
            for side in ("start", "end", "top", "bottom"):
                getattr(self, "set_margin_" + side)(8)
            self.set_direction(Gtk.TextDirection.RTL if lang == "ar" else Gtk.TextDirection.LTR)
            self.path = target
            self.language = lang
            self.settings, self.unreadable = orbit_settings.load(target)
            self._busy = False
            self._pending = {}
            self._rows = []
            self._headers = {}
            self._query = ""
            self._notice_id = 0

            self.search = Gtk.SearchEntry(placeholder_text=text(lang, "search"))
            self.search.connect("search-changed", lambda entry: self.set_query(entry.get_text()))
            top = Gtk.Box(spacing=8)
            top.append(self.search)
            self.search.set_hexpand(True)
            self.reset_all = Gtk.Button(label=text(lang, "reset_all"))
            self.reset_all.add_css_class("orbit-set-reset")
            self.reset_all.connect("clicked", lambda _b: self._ask_reset_all(True))
            top.append(self.reset_all)
            self.append(top)

            self.ask = Gtk.Box(spacing=8)
            question = label(text(lang, "reset_all_ask"), "orbit-set-note")
            question.set_hexpand(True)
            self.ask.append(question)
            yes = Gtk.Button(label=text(lang, "confirm"))
            yes.add_css_class("destructive-action")
            yes.connect("clicked", lambda _b: self._reset_all())
            no = Gtk.Button(label=text(lang, "cancel"))
            no.connect("clicked", lambda _b: self._ask_reset_all(False))
            self.ask.append(yes)
            self.ask.append(no)
            self.ask.set_visible(False)
            self.append(self.ask)

            if self.unreadable:
                self.append(label(text(lang, "unreadable"), "orbit-set-error"))

            self.preview = self._preview()
            body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            body.append(self.preview)
            current = None
            for entry in orbit_settings.SCHEMA:
                if entry["group"] != current:
                    current = entry["group"]
                    header = label(wording(entry, lang)[0], "orbit-set-group")
                    self._headers[current] = header
                    body.append(header)
                row = self._row(entry)
                self._rows.append(row)
                body.append(row["box"])
            self.empty = label(text(lang, "none"), "orbit-set-note")
            self.empty.set_visible(False)
            body.append(self.empty)
            scroller = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
            scroller.set_min_content_height(240)
            scroller.set_child(body)
            self.append(scroller)

            foot = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            foot.add_css_class("orbit-set-foot")
            head = Gtk.Box(spacing=8)
            title = label(text(lang, "path"), "orbit-set-note")
            title.set_hexpand(True)
            head.append(title)
            self.status = label("", "orbit-set-note", wrap=False)
            head.append(self.status)
            copy = Gtk.Button(label=text(lang, "copy"))
            copy.add_css_class("orbit-set-reset")
            copy.connect("clicked", self._copy)
            head.append(copy)
            foot.append(head)
            where = label(self.path, "orbit-set-path")
            where.set_selectable(True)
            where.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
            where.set_direction(Gtk.TextDirection.LTR)
            foot.append(where)
            self.append(foot)

            self._load_autostart()
            self._watch()
            self.refresh()
            self.set_query("")
            self._direct(self)

        def _direct(self, widget):
            """A widget takes the direction in force when it is made, not its parent's, so setting it on
            the page alone leaves the rows mirrored in text and not in layout. A colour typed as
            #rrggbb stays left to right in either language."""
            widget.set_direction(Gtk.TextDirection.LTR if isinstance(widget, Gtk.Entry) and not isinstance(widget, Gtk.SearchEntry)
                                 else (Gtk.TextDirection.RTL if lang == "ar" else Gtk.TextDirection.LTR))
            child = widget.get_first_child()
            while child is not None:
                self._direct(child)
                child = child.get_next_sibling()

        # --- rows -----------------------------------------------------------------------------

        def _row(self, entry):
            key, kind = entry["key"], entry["kind"]
            _group, name, description = wording(entry, lang)
            # Text on top at the row's full width, the control under it. A control beside the text takes
            # whatever width it asks for and leaves the words a column a few characters wide, which at
            # the panel's width is every row.
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            box.add_css_class("orbit-set-row")
            box.append(label(name, "orbit-set-label"))
            box.append(label(description, "orbit-set-desc"))
            chip = label(applies_text(entry, lang), "orbit-set-chip", "handoff" if entry["applies"] == "handoff" else "now")
            chip.set_tooltip_text(text(lang, "lease") if entry["applies"] == "handoff" else "")
            box.append(chip)
            error = label("", "orbit-set-error")
            error.set_visible(False)
            box.append(error)
            reset = Gtk.Button(label=text(lang, "reset"), valign=Gtk.Align.START)
            reset.add_css_class("orbit-set-reset")
            reset.connect("clicked", lambda _b: self._reset(key))
            row = {"entry": entry, "box": box, "error": error, "reset": reset, "set": lambda value: None}
            control = getattr(self, "_control_" + kind)(entry, row)
            control.set_halign(Gtk.Align.FILL)
            control.set_hexpand(True)
            # A control as wide as four buttons or four swatches leaves no room beside it for Reset at the
            # panel's width, so its Reset sits on the line below, at the end. Narrow controls share a line.
            stacked = kind in ("choice", "colors")
            under = Gtk.Box(orientation=Gtk.Orientation.VERTICAL if stacked else Gtk.Orientation.HORIZONTAL, spacing=6 if stacked else 8)
            under.append(control)
            reset.set_halign(Gtk.Align.END if stacked else Gtk.Align.FILL)
            under.append(reset)
            box.append(under)
            return row

        def _control_switch(self, entry, row):
            switch = Gtk.Switch(valign=Gtk.Align.CENTER)
            key = entry["key"]
            if not entry["stored"]:
                switch.set_sensitive(False)
                row["autostart"] = switch
                switch.connect("notify::active", lambda s, _p: None if self._busy else self._set_autostart(s.get_active()))
            else:
                switch.connect("notify::active", lambda s, _p: None if self._busy else self._commit(key, s.get_active(), row))
            row["set"] = lambda value: switch.set_active(bool(value))
            holder = Gtk.Box()
            holder.append(switch)
            return holder

        def _control_choice(self, entry, row):
            key = entry["key"]
            box = Gtk.Box(homogeneous=True)
            box.add_css_class("linked")
            box.add_css_class("orbit-set-seg")
            buttons = {}
            first = None
            for choice in entry["choices"]:
                button = Gtk.ToggleButton(label=choice_name(choice, lang), hexpand=True)
                if first is None:
                    first = button
                else:
                    button.set_group(first)
                buttons[choice] = button
                button.connect("toggled", lambda b, c=choice: self._commit(key, c, row) if b.get_active() and not self._busy else None)
                box.append(button)

            def show(value):
                if value in buttons:
                    buttons[value].set_active(True)
            row["set"] = show
            return box

        def _control_number(self, entry, row):
            key, (low, high) = entry["key"], entry["bounds"]
            fraction = entry["kind"] == "fraction"
            scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, low, high, 0.01 if fraction else 1)
            scale.set_hexpand(True)
            scale.set_draw_value(False)
            readout = label("", "orbit-set-value", wrap=False)
            readout.set_xalign(1.0)

            def show_value(number):
                readout.set_text(f"{number:.2f}" if fraction else f"{int(round(number))}" + ("%" if key == "blend" else " px"))

            def changed(widget):
                show_value(widget.get_value())
                if not self._busy:
                    self._later(key, lambda: self._commit(key, widget.get_value(), row))
            scale.connect("value-changed", changed)

            def show(value):
                scale.set_value(float(value))
                show_value(float(value))
            row["set"] = show
            box = Gtk.Box(spacing=8)
            box.append(scale)
            box.append(readout)
            return box

        _control_fraction = _control_number

        def _control_monitor(self, entry, row):
            key = entry["key"]
            names = [text(lang, "automatic")]
            monitors = Gdk.Display.get_default().get_monitors() if Gdk.Display.get_default() else None
            for index in range(monitors.get_n_items() if monitors else 0):
                connector = monitors.get_item(index).get_connector()
                if connector:
                    names.append(connector)
            model = Gtk.StringList.new(names)
            drop = Gtk.DropDown(model=model)

            def show(value):
                label_text = text(lang, "automatic") if value in (None, "") else str(value)
                if label_text not in names:
                    names.append(label_text)
                    model.append(label_text)
                drop.set_selected(names.index(label_text))

            def chosen(widget, _p):
                if self._busy:
                    return
                picked = names[widget.get_selected()] if widget.get_selected() < len(names) else None
                self._commit(key, None if picked == text(lang, "automatic") else picked, row)
            drop.connect("notify::selected", chosen)
            row["set"] = show
            return drop

        def _swatch(self, on_change):
            button = Gtk.ColorDialogButton(dialog=Gtk.ColorDialog())
            button.add_css_class("orbit-set-swatch")
            button.connect("notify::rgba", lambda b, _p: None if self._busy else on_change(to_hex(b.get_rgba())))
            return button

        @staticmethod
        def _paint(button, value):
            colour = Gdk.RGBA()
            if colour.parse(value):
                button.set_rgba(colour)

        def _control_colors(self, entry, row):
            key = entry["key"]
            box = Gtk.Box(spacing=10)
            swatches = {}
            for state in orbit_settings.STATE_KEYS:
                column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
                swatch = self._swatch(lambda value, s=state: self._commit_color(s, value, row))
                swatches[state] = swatch
                column.append(swatch)
                column.append(label(choice_name(state, lang), "orbit-set-note", wrap=False))
                box.append(column)

            def show(value):
                for state, swatch in swatches.items():
                    self._paint(swatch, value.get(state, orbit_settings.DEFAULT_SETTINGS["colors"][state]))
            row["set"] = show
            return box

        def _control_accent_color(self, entry, row):
            key = entry["key"]
            column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            follow = Gtk.Box(spacing=8)
            followed = label(text(lang, "accent"), "orbit-set-note")
            followed.set_hexpand(True)
            follow.append(followed)
            switch = Gtk.Switch(valign=Gtk.Align.CENTER)
            follow.append(switch)
            colour = Gtk.Box(spacing=8)
            swatch = self._swatch(lambda value: self._commit(key, value, row))
            hexbox = Gtk.Entry(max_length=7, width_chars=8, placeholder_text="#rrggbb")

            def typed(widget):
                if self._busy:
                    return
                value = widget.get_text().strip()
                message = hex_message(value, lang)
                if message:
                    self._error(row, message)
                else:
                    self._later(key, lambda: self._commit(key, value, row))
            hexbox.connect("changed", typed)
            colour.append(swatch)
            colour.append(hexbox)
            memory = {"last": orbit_settings.DEFAULT_SETTINGS[key]}

            def toggled(widget, _p):
                if self._busy:
                    return
                self._commit(key, "accent" if widget.get_active() else memory["last"], row)
            switch.connect("notify::active", toggled)

            def show(value):
                accent = value == "accent"
                switch.set_active(accent)
                swatch.set_sensitive(not accent)
                hexbox.set_sensitive(not accent)
                if not accent:
                    memory["last"] = value
                    self._paint(swatch, value)
                    if hexbox.get_text() != value:
                        hexbox.set_text(value)
            row["set"] = show
            column.append(follow)
            column.append(colour)
            return column

        # --- writing --------------------------------------------------------------------------

        def _error(self, row, message):
            row["error"].set_text(message or "")
            row["error"].set_visible(bool(message))

        def _later(self, key, action):
            if key in self._pending:
                GLib.source_remove(self._pending[key])

            def run():
                self._pending.pop(key, None)
                action()
                return False
            self._pending[key] = GLib.timeout_add(CHANGE_DELAY_MS, run)

        def _commit(self, key, value, row):
            coerced, note = validate_text(key, "none" if value is None else value)
            if note and coerced is None and not (key == "monitor" and value is None):
                self._error(row, note)
                return
            self._error(row, note)
            self._write(key, coerced)

        def _commit_color(self, state, value, row):
            current = dict(orbit_settings.load(target)[0]["colors"])
            current[state] = value
            self._error(row, None)
            self._write("colors", orbit_settings.coerce("colors", current)[0])

        def _write(self, key, value):
            settings, _ = orbit_settings.load(target)
            settings[key] = value
            failure = orbit_settings.save(settings, target)
            self.settings = settings
            self.preview.queue_draw()
            self._tell(failure or text(lang, "saved"), bool(failure))

        def _reset(self, key):
            entry = orbit_settings.BY_KEY[key]
            if not entry["stored"]:
                self._set_autostart(bool(entry["default"]), reflect=True)
                return
            default = orbit_settings.DEFAULT_SETTINGS[key]
            self._write(key, dict(default) if isinstance(default, dict) else default)
            self.refresh()

        def _ask_reset_all(self, asking):
            self.ask.set_visible(asking)
            self.reset_all.set_visible(not asking)

        def _reset_all(self):
            failure = orbit_settings.save(orbit_settings.defaults(), target)
            self._ask_reset_all(False)
            self.settings = orbit_settings.defaults()
            self._tell(failure or text(lang, "saved"), bool(failure))
            self.refresh()

        def _tell(self, message, bad=False):
            self.status.set_text(message)
            if bad:
                self.status.add_css_class("orbit-set-error")
            else:
                self.status.remove_css_class("orbit-set-error")
            if self._notice_id:
                GLib.source_remove(self._notice_id)

            def clear():
                self._notice_id = 0
                self.status.set_text("")
                return False
            self._notice_id = GLib.timeout_add(NOTICE_MS, clear)

        def _copy(self, _button):
            display_now = Gdk.Display.get_default()
            if display_now is not None:
                display_now.get_clipboard().set(self.path)
            self._tell(text(lang, "copied"))

        # --- autostart ------------------------------------------------------------------------

        def _autostart_row(self):
            return next((row for row in self._rows if not row["entry"]["stored"]), None)

        def _load_autostart(self):
            row = self._autostart_row()
            if row is None:
                return
            self._error(row, text(lang, "checking"))

            def work():
                state = backend.status()
                GLib.idle_add(self._autostart_known, state)
            threading.Thread(target=work, daemon=True).start()

        def _autostart_known(self, state):
            row = self._autostart_row()
            if state is None:
                self._error(row, text(lang, "no_launcher"))
                return False
            self._error(row, None)
            self._busy = True
            row["autostart"].set_active(state)
            row["autostart"].set_sensitive(True)
            self._busy = False
            return False

        def _set_autostart(self, enabled, reflect=False):
            row = self._autostart_row()
            if reflect:
                self._busy = True
                row["autostart"].set_active(enabled)
                self._busy = False

            def work():
                done = backend.set(enabled)
                GLib.idle_add(self._autostart_done, done)
            threading.Thread(target=work, daemon=True).start()

        def _autostart_done(self, done):
            row = self._autostart_row()
            if not done:
                self._error(row, text(lang, "no_launcher"))
            else:
                self._error(row, None)
                self._tell(text(lang, "saved"))
            return False

        # --- state ----------------------------------------------------------------------------

        def refresh(self):
            """Redraw every control from the file, without writing anything back."""
            self.settings, self.unreadable = orbit_settings.load(target)
            self._busy = True
            try:
                for row in self._rows:
                    entry = row["entry"]
                    if entry["stored"]:
                        self._error(row, None)
                        row["set"](self.settings[entry["key"]])
                self.preview.queue_draw()
            finally:
                self._busy = False

        def _watch(self):
            directory = os.path.dirname(target)
            try:
                os.makedirs(directory, mode=0o700, exist_ok=True)
                self._monitor = Gio.File.new_for_path(directory).monitor_directory(Gio.FileMonitorFlags.NONE, None)
            except (OSError, GLib.Error):
                self._monitor = None
                return

            def changed(_monitor, file, _other, _event):
                if file.get_path() == target:
                    fresh, _ = orbit_settings.load(target)
                    if fresh != self.settings:
                        self.refresh()
            self._monitor.connect("changed", changed)

        def set_query(self, query):
            self._query = query
            if self.search.get_text() != query:
                self.search.set_text(query)
            keys = {entry["key"] for entry in orbit_settings.search(query)}
            shown_groups = set()
            for row in self._rows:
                visible = row["entry"]["key"] in keys
                row["box"].set_visible(visible)
                if visible:
                    shown_groups.add(row["entry"]["group"])
            for group, header in self._headers.items():
                header.set_visible(group in shown_groups)
            self.preview.set_visible(not query.strip())
            self.empty.set_visible(not keys)

        def visible_keys(self):
            return [row["entry"]["key"] for row in self._rows if row["box"].get_visible()]

        # --- the preview ----------------------------------------------------------------------

        def _preview(self):
            area = Gtk.DrawingArea()
            area.set_content_height(120)
            area.set_content_width(1)
            area.set_hexpand(True)
            area.add_css_class("orbit-set-preview")
            area.set_draw_func(self._draw_preview)
            return area

        def _draw_preview(self, _area, cr, width, height):
            """A small screen with the mark docked where the settings put it, in the shape, size and
            colour they give it, and the working glow along the same edge when it is on."""
            import math
            settings = self.settings
            colours = settings["colors"]

            def rgb(value):
                parsed = Gdk.RGBA()
                parsed.parse(value if orbit_settings.is_hex(value) else "#255fce")
                return parsed
            pad = 14
            sx, sy, sw, sh = pad, pad, width - 2 * pad, height - 2 * pad
            cr.set_source_rgba(0.09, 0.10, 0.13, 1)
            cr.rectangle(sx, sy, sw, sh)
            cr.fill()
            edge = settings["edge"]
            accent = rgb("#255fce" if settings["frameColor"] == "accent" else settings["frameColor"])
            if settings["frame"]:
                import cairo
                depth = 36
                gradients = {"left": (sx, sy, sx + depth, sy), "right": (sx + sw, sy, sx + sw - depth, sy),
                             "top": (sx, sy, sx, sy + depth), "bottom": (sx, sy + sh, sx, sy + sh - depth)}
                gradient = cairo.LinearGradient(*gradients[edge])
                gradient.add_color_stop_rgba(0, accent.red, accent.green, accent.blue, 0.75)
                gradient.add_color_stop_rgba(1, accent.red, accent.green, accent.blue, 0)
                cr.set_source(gradient)
                cr.rectangle(sx, sy, sw, sh)
                cr.fill()
            # The mark, at the position along its edge, drawn at the size the setting gives it.
            size, margin, position = settings["size"], settings["margin"], settings["position"]
            scale = 1.6
            mark = size * scale
            along_h = edge in ("top", "bottom")
            long_side = max(12, round(size * 2.4)) * scale
            thick_side = max(3, round(size * 0.42)) * scale
            ax = sx + (sw - (long_side if along_h else mark)) * position if along_h else None
            ay = sy + (sh - (mark if along_h else long_side)) * position if not along_h else None
            style = settings["style"]
            state = rgb(colours["working"])
            cr.set_source_rgba(state.red, state.green, state.blue, 1)
            gap = margin * scale * 0.5
            if style == "mark":
                try:
                    from panel_draw import MARK_ASPECT, orbit_mark
                    body = max(mark * 1.6, 18)
                    mx = {"left": sx + gap + 4, "right": sx + sw - gap - 4 - body}.get(edge, ax if along_h else sx)
                    my = {"top": sy + gap + 4, "bottom": sy + sh - gap - 4 - body * MARK_ASPECT}.get(edge, ay if not along_h else sy)
                    cr.save()
                    cr.translate(mx, my)
                    orbit_mark(cr, body)
                    cr.restore()
                except Exception:  # a drawing helper that cannot load must not take the page with it
                    style = "dot"
            if style != "mark":
                if style == "bar":
                    w, h = (long_side, thick_side) if along_h else (thick_side, long_side)
                elif style == "count":
                    w, h = mark + 8 * scale, mark + 6 * scale
                else:
                    w = h = mark
                x = {"left": sx + gap + 4, "right": sx + sw - gap - 4 - w}.get(edge, ax if along_h else sx)
                y = {"top": sy + gap + 4, "bottom": sy + sh - gap - 4 - h}.get(edge, ay if not along_h else sy)
                if along_h:
                    x = sx + (sw - w) * position
                else:
                    y = sy + (sh - h) * position
                radius = min(w, h) / 2
                cr.new_sub_path()
                cr.arc(x + w - radius, y + radius, radius, -math.pi / 2, 0)
                cr.arc(x + w - radius, y + h - radius, radius, 0, math.pi / 2)
                cr.arc(x + radius, y + h - radius, radius, math.pi / 2, math.pi)
                cr.arc(x + radius, y + radius, radius, math.pi, 3 * math.pi / 2)
                cr.close_path()
                cr.fill()
                if style == "count":
                    cr.set_source_rgba(1, 1, 1, 1)
                    digit = PangoCairo.create_layout(cr)
                    digit.set_font_description(Pango.FontDescription(f"sans bold {max(8, round(h * 0.45))}px"))
                    digit.set_text("3", -1)
                    ink = digit.get_pixel_size()
                    cr.move_to(x + (w - ink[0]) / 2, y + (h - ink[1]) / 2)
                    PangoCairo.show_layout(cr, digit)
            # The four state colours, so a colour edit is judged against the others.
            step = sw / 4
            lx = sx
            for index, name in enumerate(orbit_settings.STATE_KEYS):
                colour = rgb(colours[name])
                px = lx + index * step + 8
                cr.set_source_rgba(colour.red, colour.green, colour.blue, 1)
                cr.arc(px, sy + sh - 14, 5, 0, 2 * math.pi)
                cr.fill()
                cr.set_source_rgba(1, 1, 1, 0.75)
                words = PangoCairo.create_layout(cr)
                words.set_font_description(Pango.FontDescription("sans 9"))
                words.set_text(choice_name(name, lang), -1)
                cr.move_to(px + 9, sy + sh - 22)
                PangoCairo.show_layout(cr, words)

    return Page()
