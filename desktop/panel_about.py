"""The About page of the desktop panel: version, native plugin status, broker health and updates.

Contract, for the module that wires it into the panel (`desktop/panel.py`):

    page = panel_about.build_about_page(app, language=None, run=None)

* Returns a `Gtk.Box` (vertical) holding a scrolling column of cards: Orbit and its version, native
  control (installed plugin source, loaded plugin source, compositor ABI, and a plain explanation with the
  fix when they differ), the broker (health, uptime, active sessions) and updates. It asks for no window
  of its own and sets no size beyond a small minimum, so the panel decides how large it is.
* Import is safe without a display: GTK is imported inside `build_about_page`, and everything it shows
  comes from `desktop/about_data.py`, which needs no toolkit. Call `build_about_page` on the main thread
  after GTK is initialised, as for `panel_settings.build_settings_page`.
* `app` is optional. A `language` attribute on it ("ar" or "en") picks the language; otherwise the
  `language` argument, otherwise the locale. Arabic sets the page right to left. Digits stay Western
  and durations carry no clock time.
* `run` is the command seam `about_data` uses, `run(argv, timeout) -> (returncode, stdout)`. `None` is the
  real thing (the `sbar-orbit` launcher, systemd, ps). A harness passes a fake so it never touches the
  owner's broker.
* Everything slow runs off the main thread and lands back on it, so the panel never freezes. The page
  reads once when built; `refresh()` reads again.
* The returned widget has `refresh()`, `busy` (True while a command runs), `snapshot` (the last
  `about_data.collect()` dict), `update_view` (what the update card shows) and `check_updates()`,
  `update_now()`, `stop_idle()`, which are what the three buttons call, for the panel and the harness.

Updates never force anything. Check compares the installed version with the registry feed and sends no
owner data. Update now prepares the eligible version and activates it only when no session is open; when
sessions are open it names them and offers Stop idle sessions, which stops only sessions that are not
working. A session that is working is never stopped from here. Activation restarts the broker (never while
a session is open), and the result reports the version the broker answers with.
"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import about_data  # noqa: E402

UI = {
    "en": {
        "title": "Orbit", "version": "Version", "refresh": "Refresh", "reading": "Reading",
        "native": "Native control", "installed": "Installed plugin source", "loaded": "Loaded plugin source",
        "abi": "Compositor ABI", "abi_ok": "Matches", "abi_bad": "Differs", "abi_unknown": "Unknown",
        "none": "None loaded", "unknown": "Unknown",
        "s_match": "Ready", "s_source_mismatch": "Plugin out of date", "s_abi_mismatch": "Compositor changed",
        "s_not_loaded": "Plugin not loaded", "s_not_prepared": "Not set up", "s_unknown": "Unknown",
        "e_match": "The plugin loaded in the compositor is the one this installation expects, so Orbit can take over applications.",
        "e_source_mismatch": "The plugin loaded in the compositor was built from different source than this Orbit installation. "
                             "Orbit refuses to take over applications until they match (NATIVE_INCOMPATIBLE).",
        "e_abi_mismatch": "The compositor is a different build than the one the plugin was prepared for. "
                          "Orbit refuses to take over applications until the plugin is rebuilt for it.",
        "e_not_loaded": "No Orbit plugin is loaded in the compositor, so Orbit cannot take over applications.",
        "e_not_prepared": "Native control has not been set up on this machine.",
        "e_unknown": "Orbit could not read the plugin status.",
        "f_source_mismatch": "Fix: rebuild the plugin from this installation, then reload it while no session holds an application.",
        "f_abi_mismatch": "Fix: prepare the current compositor, rebuild the plugin for it, then load it.",
        "f_not_loaded": "Fix: load the prepared plugin.",
        "f_not_prepared": "Fix: prepare native control once.",
        "copy": "Copy command", "copied": "Copied",
        "broker": "Broker", "running": "Running", "stopped": "Not running", "healthy": "Healthy", "attention": "Needs attention",
        "uptime": "Uptime", "broker_version": "Broker version", "sessions": "Sessions", "open": "open", "working": "working",
        "units": "Service files differ from this installation.", "no_broker": "The broker does not answer.",
        "updates": "Updates", "check": "Check for updates", "update_now": "Update now", "checking": "Checking the registry",
        "updating": "Updating", "not_checked": "Not checked yet",
        "u_current": "You have the newest version.", "u_available": "Version {v} is available.",
        "u_waiting": "Version {v} is published and still maturing before Orbit offers it.",
        "u_unknown": "The registry did not answer.", "u_unmanaged": "This install runs from a source checkout and updates with git.",
        "u_unmanaged_available": "Version {v} is available. This install runs from a source checkout and updates with git.",
        "u_updated": "Updated to {v}. The broker answers on the new version.",
        "u_restart": "The desktop mark keeps running its own version until it is restarted.",
        "u_failed": "The update did not finish: {r}", "u_rolled": "Orbit went back to the version that was working.",
        "blocked": "These sessions keep the update from restarting the broker. Nothing was restarted.",
        "stop_idle": "Stop idle sessions", "stop_note": "Working sessions are never stopped here.",
        "stopped_n": "Stopped {n}.", "left_n": "{n} still open.", "retry": "Update again",
        "workspace": "Workspace", "idle": "Idle", "working_chip": "Working", "paused": "Paused",
        "ctrl_open": "Applications stay open when a session stops.",
        "d": "d", "h": "h", "m": "min", "s": "s", "up_none": "Not available",
    },
    "ar": {
        "title": "أوربت", "version": "الإصدار", "refresh": "تحديث القراءة", "reading": "جار القراءة",
        "native": "التحكم الأصلي", "installed": "مصدر الإضافة المثبتة", "loaded": "مصدر الإضافة المحمّلة",
        "abi": "واجهة المركّب", "abi_ok": "متطابقة", "abi_bad": "مختلفة", "abi_unknown": "غير معروفة",
        "none": "لا شيء محمّل", "unknown": "غير معروف",
        "s_match": "جاهز", "s_source_mismatch": "الإضافة قديمة", "s_abi_mismatch": "تغيّر المركّب",
        "s_not_loaded": "الإضافة غير محمّلة", "s_not_prepared": "غير مُعدّ", "s_unknown": "غير معروف",
        "e_match": "الإضافة المحمّلة في المركّب هي التي يتوقعها هذا التثبيت، فيستطيع أوربت تولّي التطبيقات.",
        "e_source_mismatch": "الإضافة المحمّلة في المركّب بُنيت من مصدر يختلف عن مصدر تثبيت أوربت هذا. "
                             "يرفض أوربت تولّي التطبيقات حتى يتطابقا (NATIVE_INCOMPATIBLE).",
        "e_abi_mismatch": "المركّب نسخة مختلفة عن التي أُعدّت لها الإضافة. "
                          "يرفض أوربت تولّي التطبيقات حتى تُبنى الإضافة لها من جديد.",
        "e_not_loaded": "لا توجد إضافة لأوربت محمّلة في المركّب، فلا يستطيع تولّي التطبيقات.",
        "e_not_prepared": "لم يُعدّ التحكم الأصلي على هذا الجهاز.",
        "e_unknown": "تعذرت قراءة حالة الإضافة.",
        "f_source_mismatch": "الحل: أعد بناء الإضافة من هذا التثبيت ثم حمّلها من جديد حين لا تحتجز أي جلسة تطبيقا.",
        "f_abi_mismatch": "الحل: جهّز المركّب الحالي وأعد بناء الإضافة له ثم حمّلها.",
        "f_not_loaded": "الحل: حمّل الإضافة المُعدّة.",
        "f_not_prepared": "الحل: جهّز التحكم الأصلي مرة واحدة.",
        "copy": "انسخ الأمر", "copied": "تم النسخ",
        "broker": "الوسيط", "running": "يعمل", "stopped": "لا يعمل", "healthy": "سليم", "attention": "يحتاج انتباها",
        "uptime": "مدة التشغيل", "broker_version": "إصدار الوسيط", "sessions": "الجلسات", "open": "مفتوحة", "working": "تعمل",
        "units": "ملفات الخدمة تختلف عن هذا التثبيت.", "no_broker": "الوسيط لا يستجيب.",
        "updates": "التحديثات", "check": "ابحث عن تحديث", "update_now": "حدّث الآن", "checking": "جار فحص السجل",
        "updating": "جار التحديث", "not_checked": "لم يُفحص بعد",
        "u_current": "لديك أحدث إصدار.", "u_available": "الإصدار {v} متاح.",
        "u_waiting": "الإصدار {v} منشور ولا يزال في مدة النضج قبل أن يعرضه أوربت.",
        "u_unknown": "السجل لم يستجب.", "u_unmanaged": "هذا التثبيت يعمل من نسخة مصدرية ويتحدّث عبر git.",
        "u_unmanaged_available": "الإصدار {v} متاح. هذا التثبيت يعمل من نسخة مصدرية ويتحدّث عبر git.",
        "u_updated": "تم التحديث إلى {v}. الوسيط يستجيب بالإصدار الجديد.",
        "u_restart": "يبقى شعار سطح المكتب على إصداره حتى يُعاد تشغيله.",
        "u_failed": "لم يكتمل التحديث: {r}", "u_rolled": "عاد أوربت إلى الإصدار الذي كان يعمل.",
        "blocked": "هذه الجلسات تمنع التحديث من إعادة تشغيل الوسيط. لم يُعد تشغيل شيء.",
        "stop_idle": "أوقف الجلسات الساكنة", "stop_note": "الجلسات التي تعمل لا تُوقف من هنا أبدا.",
        "stopped_n": "أُوقفت {n}.", "left_n": "بقيت {n} مفتوحة.", "retry": "حدّث مرة أخرى",
        "workspace": "مساحة العمل", "idle": "ساكنة", "working_chip": "تعمل", "paused": "متوقفة مؤقتا",
        "ctrl_open": "تبقى التطبيقات مفتوحة عند إيقاف الجلسة.",
        "d": "ي", "h": "س", "m": "د", "s": "ث", "up_none": "غير متاح",
    },
}

CSS = b"""
.orbit-about { color: @window_fg_color; }
.orbit-about-card { padding: 12px 14px; border-radius: 16px; background: alpha(@window_fg_color, 0.055); }
.orbit-about-title { font-weight: 700; font-size: 105%; }
.orbit-about-name { font-weight: 800; font-size: 190%; }
.orbit-about-key { opacity: 0.66; font-size: 90%; }
.orbit-about-val { font-weight: 600; font-feature-settings: "tnum"; }
.orbit-about-mono { font-family: monospace; font-size: 90%; }
.orbit-about-note { opacity: 0.72; font-size: 90%; }
.orbit-about-cmd { font-family: monospace; font-size: 88%; padding: 6px 9px; border-radius: 10px; background: alpha(#000000, 0.30); }
.orbit-about-chip { font-size: 82%; font-weight: 700; padding: 1px 9px; border-radius: 8px; }
.orbit-about-chip.ok { background: alpha(#2e9e5b, 0.22); color: #35b369; }
.orbit-about-chip.warn { background: alpha(#e08a00, 0.22); color: #f0a020; }
.orbit-about-chip.bad { background: alpha(#d33333, 0.22); color: #ee5555; }
.orbit-about-chip.dim { background: alpha(@window_fg_color, 0.12); }
.orbit-about-bad { color: #ee5555; font-weight: 600; }
.orbit-about-ok { color: #35b369; font-weight: 600; }
.orbit-about-row { padding: 6px 10px; border-radius: 12px; background: alpha(@window_fg_color, 0.06); }
.orbit-about button { padding: 3px 14px; border-radius: 999px; }
"""

CHIP_CLASS = {"match": "ok", "source_mismatch": "bad", "abi_mismatch": "bad", "not_loaded": "warn",
              "not_prepared": "warn", "unknown": "dim"}


# ---------------------------------------------------------------------------------------------- pure

def language_of(app=None, language=None):
    """"ar" or "en". The argument wins, then the app, then the locale; anything else is English."""
    for chosen in (language, getattr(app, "language", None)):
        if chosen in UI:
            return chosen
    locale = (os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG") or "").lower()
    return "ar" if locale.startswith("ar") else "en"


def text(language, key, **fields):
    value = UI[language][key]
    return value.format(**fields) if fields else value


def duration(seconds, language):
    """A short span in the page's language, two units at most. None reads as not available."""
    if seconds is None:
        return text(language, "up_none")
    days, rest = divmod(int(seconds), 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    parts = [(days, "d"), (hours, "h"), (minutes, "m")] if days or hours or minutes else [(secs, "s")]
    shown = [f"{count} {text(language, unit)}" for count, unit in parts if count][:2]
    return " ".join(shown) or f"0 {text(language, 's')}"


def fix_commands(plugin, home=None):
    """The commands that fix a plugin state, as the person would type them. Empty when there is none."""
    directory = plugin.get("directory") or "DIRECTORY"
    manifest = os.path.join(home or about_data.data_home(), "native", "plugin-build.json")
    state = plugin.get("state")
    if state == "source_mismatch":
        return [f"sbar-orbit native-plugin unload {directory}", f"sbar-orbit native-refresh --plugin-manifest {manifest}"]
    if state == "abi_mismatch":
        return ["sbar-orbit native-prepare ABSOLUTE_EMPTY_DIRECTORY", f"sbar-orbit native-refresh --plugin-manifest {manifest}"]
    if state == "not_loaded":
        return [f"sbar-orbit native-refresh --plugin-manifest {manifest}"]
    if state == "not_prepared":
        return ["sbar-orbit native-prepare ABSOLUTE_EMPTY_DIRECTORY"]
    return []


def update_text(view, language):
    """(message, kind) for the update card; kind is ok, warn, bad or dim, which picks the colour."""
    kind = view.get("kind")
    version = view.get("version")
    reason = view.get("reason") or ""
    if kind == "checking":
        return text(language, "checking"), "dim"
    if kind == "updating":
        return text(language, "updating"), "dim"
    if kind == "current":
        return text(language, "u_current"), "ok"
    if kind == "available":
        key = "u_unmanaged_available" if view.get("unmanaged") else "u_available"
        return text(language, key, v=version), "warn"
    if kind == "waiting":
        return text(language, "u_waiting", v=version), "dim"
    if kind == "unmanaged":
        return text(language, "u_unmanaged"), "dim"
    if kind == "updated":
        return text(language, "u_updated", v=version), "ok"
    if kind == "blocked":
        return text(language, "blocked"), "warn"
    if kind == "failed":
        message = text(language, "u_failed", r=reason or text(language, "unknown"))
        return (message + " " + text(language, "u_rolled") if view.get("rolledBack") else message), "bad"
    if kind == "unknown":
        return text(language, "u_unknown"), "bad"
    return text(language, "not_checked"), "dim"


def view_from_check(found, managed):
    """The update card's state for a `check_for_update` result."""
    if found["state"] == "unknown":
        return {"kind": "unknown", "reason": found.get("reason")}
    if found["state"] == "available":
        return {"kind": "available", "version": found["eligible"], "unmanaged": not managed}
    if found.get("waiting"):
        return {"kind": "waiting", "version": found["latest"]}
    return {"kind": "current"}


def view_from_update(result):
    """The update card's state for an `update_now` result."""
    state = result.get("state")
    if state == "updated":
        return {"kind": "updated", "version": result.get("version")}
    if state == "blocked":
        return {"kind": "blocked", "version": result.get("version"), "blockers": result.get("blockers") or []}
    if state == "unmanaged":
        return {"kind": "unmanaged"}
    if state == "current":
        return {"kind": "current"}
    return {"kind": "failed", "reason": result.get("reason"), "rolledBack": result.get("rolledBack")}


# --------------------------------------------------------------------------------------------- GTK

def build_about_page(app=None, language=None, run=None):
    """The page. See the module docstring for the contract."""
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, GLib, Gtk, Pango

    lang = language_of(app, language)
    runner = run or about_data.default_run
    display = Gdk.Display.get_default()
    if display is not None and not getattr(Gtk, "_orbit_about_css", False):
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        # Above user priority, so a desktop theme's own gtk.css does not repaint the cards.
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        Gtk._orbit_about_css = True

    def label(content, *classes, wrap=True, selectable=False):
        widget = Gtk.Label(label=content, xalign=0.0, wrap=wrap, selectable=selectable)
        widget.set_halign(Gtk.Align.START)
        for name in classes:
            widget.add_css_class(name)
        return widget

    def chip(content, kind):
        widget = label(content, "orbit-about-chip", kind, wrap=False)
        widget.set_valign(Gtk.Align.CENTER)
        return widget

    def pair(key, value, *value_classes):
        """A caption and its value on one line, the value hugging the end of the row."""
        row = Gtk.Box(spacing=10)
        row.append(label(key, "orbit-about-key"))
        spacer = Gtk.Box(hexpand=True)
        row.append(spacer)
        shown = label(value, "orbit-about-val", *value_classes, wrap=False)
        shown.set_halign(Gtk.Align.END)
        row.append(shown)
        return row

    def card(title, status=None):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=7)
        box.add_css_class("orbit-about-card")
        head = Gtk.Box(spacing=8)
        head.append(label(title, "orbit-about-title", wrap=False))
        head.append(Gtk.Box(hexpand=True))
        if status:
            head.append(chip(*status))
        box.append(head)
        return box

    class Page(Gtk.Box):
        def __init__(self):
            super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
            self.add_css_class("orbit-about")
            self.set_direction(Gtk.TextDirection.RTL if lang == "ar" else Gtk.TextDirection.LTR)
            self.language = lang
            self.busy = False
            self.snapshot = None
            self.update_view = {"kind": "idle"}
            self.notice = ""
            self._jobs = 0
            self.column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            self.column.set_margin_top(4)
            self.column.set_margin_bottom(8)
            self.scroller = Gtk.ScrolledWindow(vexpand=True, hexpand=True, min_content_height=120)
            self.scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            self.scroller.set_child(self.column)
            self.append(self.scroller)
            self.draw()
            self.refresh()

        # -- work off the main thread, results back on it
        def work(self, job, done):
            self._jobs += 1
            self.busy = True

            def target():
                try:
                    result = job()
                except Exception as error:  # a reader that raises must not leave the page busy forever
                    result = {"state": "failed", "reason": str(error)[:200]}
                GLib.idle_add(finish, result)

            def finish(result):
                done(result)
                self._jobs -= 1
                self.busy = self._jobs > 0
                self.draw()
                return False

            threading.Thread(target=target, daemon=True).start()

        def refresh(self):
            def done(snapshot):
                if isinstance(snapshot, dict) and "broker" in snapshot:
                    self.snapshot = snapshot
            self.work(lambda: about_data.collect(runner), done)

        def check_updates(self):
            managed = bool(self.snapshot and self.snapshot["update"]["managed"])
            self.update_view = {"kind": "checking"}
            self.notice = ""
            self.draw()

            def done(found):
                self.update_view = view_from_check(found, managed)
            self.work(lambda: about_data.check_for_update(runner), done)

        def update_now(self):
            self.update_view = {"kind": "updating"}
            self.notice = ""
            self.draw()

            def done(result):
                self.update_view = view_from_update(result)
                if self.update_view["kind"] == "updated":
                    self.refresh()
            self.work(lambda: about_data.update_now(runner), done)

        def stop_idle(self):
            blockers = self.update_view.get("blockers") or []

            def job():
                stopped, left = about_data.stop_idle(blockers, runner)
                return {"stopped": len(stopped), "left": len(left), "rows": about_data.open_sessions(runner) or []}

            def done(result):
                rows = result.get("rows", [])
                self.update_view = {**self.update_view, "blockers": rows} if rows else {"kind": "idle", "after_stop": True}
                self.notice = text(lang, "stopped_n", n=result.get("stopped", 0))
                if result.get("left"):
                    self.notice += " " + text(lang, "left_n", n=result["left"])
                self.refresh()
            self.notice = ""
            self.work(job, done)

        # -- drawing
        def draw(self):
            child = self.column.get_first_child()
            while child is not None:
                following = child.get_next_sibling()
                self.column.remove(child)
                child = following
            data = self.snapshot
            self.column.append(self.header(data))
            if data is None:
                self.column.append(label(text(lang, "reading"), "orbit-about-note"))
                return
            self.column.append(self.native_card(data["plugin"]))
            self.column.append(self.broker_card(data))
            self.column.append(self.update_card(data))

        def header(self, data):
            box = Gtk.Box(spacing=10)
            names = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
            names.append(label(text(lang, "title"), "orbit-about-name", wrap=False))
            version = (data or {}).get("version") or text(lang, "unknown")
            names.append(label(f"{text(lang, 'version')} {version}", "orbit-about-key", wrap=False))
            box.append(names)
            box.append(Gtk.Box(hexpand=True))
            refresh = Gtk.Button(label=text(lang, "refresh"), valign=Gtk.Align.CENTER, sensitive=not self.busy)
            refresh.connect("clicked", lambda _b: self.refresh())
            box.append(refresh)
            return box

        def native_card(self, plugin):
            state = plugin["state"]
            box = card(text(lang, "native"), (text(lang, "s_" + state), CHIP_CLASS.get(state, "dim")))
            box.append(pair(text(lang, "installed"), plugin.get("installedSource") or text(lang, "unknown"), "orbit-about-mono"))
            box.append(pair(text(lang, "loaded"), plugin.get("loadedSource") or text(lang, "none"), "orbit-about-mono",
                            *(["orbit-about-bad"] if state == "source_mismatch" else [])))
            if state in ("match", "source_mismatch", "abi_mismatch"):
                key = "abi_ok" if state != "abi_mismatch" else "abi_bad"
                box.append(pair(text(lang, "abi"), text(lang, key), "orbit-about-ok" if key == "abi_ok" else "orbit-about-bad"))
            else:
                box.append(pair(text(lang, "abi"), text(lang, "abi_unknown")))
            box.append(label(text(lang, "e_" + state), "orbit-about-note"))
            commands = fix_commands(plugin)
            if commands:
                box.append(label(text(lang, "f_" + state), "orbit-about-note"))
                for command in commands:
                    shown = label(command, "orbit-about-cmd", selectable=True)
                    shown.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
                    shown.set_direction(Gtk.TextDirection.LTR)  # a command is Latin text in any language
                    shown.set_selectable(False)
                    box.append(shown)
                copy = Gtk.Button(label=text(lang, "copy"), halign=Gtk.Align.START)

                def copied(_b):
                    clipboard = Gdk.Display.get_default().get_clipboard()
                    clipboard.set("\n".join(commands))
                    copy.set_label(text(lang, "copied"))
                copy.connect("clicked", copied)
                box.append(copy)
            return box

        def broker_card(self, data):
            broker = data["broker"]
            if not broker["reachable"]:
                status = (text(lang, "stopped"), "bad")
            else:
                status = (text(lang, "healthy"), "ok") if broker["healthy"] else (text(lang, "attention"), "warn")
            box = card(text(lang, "broker"), status)
            if not broker["reachable"]:
                box.append(label(text(lang, "no_broker"), "orbit-about-note"))
                return box
            box.append(pair(text(lang, "uptime"), duration(broker["uptimeSeconds"], lang)))
            box.append(pair(text(lang, "broker_version"), data.get("brokerVersion") or text(lang, "unknown")))
            sessions = data["sessions"]
            box.append(pair(text(lang, "sessions"),
                            f"{len(sessions)} {text(lang, 'open')}, {data['activeSessions']} {text(lang, 'working')}"))
            if not broker["healthy"]:
                box.append(label(text(lang, "units"), "orbit-about-note"))
            return box

        def session_row(self, row):
            line = Gtk.Box(spacing=8)
            line.add_css_class("orbit-about-row")
            names = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            names.set_hexpand(True)
            names.append(label(row["agent"] or row["task"] or str(row["id"])[:8], "orbit-about-val", wrap=False))
            detail = row["window"] or row["task"]
            if row["workspace"]:
                detail = f"{text(lang, 'workspace')} {row['workspace']}  {detail}".strip()
            if detail:
                names.append(label(detail, "orbit-about-key", wrap=False))
            line.append(names)
            if row["working"]:
                line.append(chip(text(lang, "working_chip"), "warn"))
            else:
                line.append(chip(text(lang, "paused" if row["state"] == "paused" else "idle"), "dim"))
            return line

        def update_card(self, data):
            summary = data["update"]
            view = self.update_view
            message, kind = update_text(view, lang)
            box = card(text(lang, "updates"))
            running = data.get("brokerVersion") or data.get("version") or text(lang, "unknown")
            box.append(pair(text(lang, "version"), running))
            if kind == "dim" or view.get("kind") in ("idle", None):
                box.append(label(message, "orbit-about-note"))
            else:
                box.append(label(message, {"ok": "orbit-about-ok", "bad": "orbit-about-bad"}.get(kind, "orbit-about-val")))
            if view.get("kind") == "updated":
                box.append(label(text(lang, "u_restart"), "orbit-about-note"))
            if not summary["managed"] and view.get("kind") not in ("available", "unmanaged"):
                box.append(label(text(lang, "u_unmanaged"), "orbit-about-note"))
            if self.notice:
                box.append(label(self.notice, "orbit-about-note"))
            blockers = view.get("blockers") if view.get("kind") == "blocked" else []
            for row in blockers or []:
                box.append(self.session_row(row))
            buttons = Gtk.Box(spacing=8)
            check = Gtk.Button(label=text(lang, "check"), sensitive=not self.busy)
            check.connect("clicked", lambda _b: self.check_updates())
            buttons.append(check)
            update = Gtk.Button(label=text(lang, "retry" if blockers else "update_now"),
                                sensitive=not self.busy and summary["managed"])
            update.add_css_class("suggested-action")
            update.connect("clicked", lambda _b: self.update_now())
            buttons.append(update)
            if blockers:
                idle = [row for row in blockers if not row["working"]]
                stop = Gtk.Button(label=text(lang, "stop_idle"), sensitive=not self.busy and bool(idle))
                stop.connect("clicked", lambda _b: self.stop_idle())
                buttons.append(stop)
            box.append(buttons)
            if blockers:
                box.append(label(text(lang, "stop_note") + " " + text(lang, "ctrl_open"), "orbit-about-note"))
            return box

    return Page()
