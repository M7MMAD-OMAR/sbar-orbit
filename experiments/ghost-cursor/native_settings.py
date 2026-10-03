#!/usr/bin/python3
"""Owner-side native settings preview. Refuses displays outside the private lab."""
import datetime
import fcntl
import json
import os
import shlex
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import lab
from action_control import ActionControl, ControlError

lab.guard(os.environ)
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk


class SettingsControl(ActionControl):
    """UI lock waits have a finite deadline and stop when its window closes."""
    def __init__(self, directory, cancelled):
        super().__init__(directory)
        self.cancelled = cancelled

    def _lock(self):
        fd = self._open("lock", os.O_RDWR | os.O_CREAT)
        deadline = time.monotonic() + 3
        try:
            while not self.cancelled.is_set():
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ControlError("Storage is busy")
                    self.cancelled.wait(0.05)
                    continue
                if not self.cancelled.is_set():
                    return fd
            raise ControlError("Settings window closed")
        except BaseException:
            os.close(fd)
            raise


def checked_snapshot(control):
    snapshot = control.inspect()
    for event in snapshot["events"]:
        if not isinstance(event.get("epoch_ns"), int) or not isinstance(event.get("id"), str):
            raise ControlError("Journal record is missing its time or identity")
        try:
            datetime.datetime.fromtimestamp(event["epoch_ns"] / 1e9)
            if "request" in event:
                if not isinstance(event["request"], str) or not 1 <= len(event["request"].encode("utf-8")) <= 65536:
                    raise ControlError("Invalid journal request")
        except (ValueError, OverflowError, UnicodeError) as error:
            raise ControlError("Journal contains invalid display data") from error
        phase = event["phase"]
        if phase in ("denied", "begin"):
            if event.get("kind") == "settings" and phase == "begin":
                settings = event.get("settings")
                if not isinstance(settings, dict) or settings.get("mode") not in ("protected", "full"):
                    raise ControlError("Invalid settings journal record")
            elif event.get("kind") != "action" or not isinstance(event.get("request"), str):
                raise ControlError("Invalid action journal record")
        elif event.get("outcome") not in ("success", "error"):
            raise ControlError("Invalid journal outcome")
    return snapshot


def describe(request):
    """Readable preview only; approvals retain the exact original request."""
    if request.startswith("ghost-cli "):
        try:
            return "Command: " + shlex.join(json.loads(request[10:]))
        except (ValueError, TypeError):
            return request
    parts = request.split(" ", 2)
    if len(parts) == 3 and parts[0] == "ghost-texthex":
        try:
            text = bytes.fromhex(parts[2]).decode("utf-8")
            return f"Type into {parts[1]}: {text}"
        except (ValueError, UnicodeError):
            pass
    return request


class SettingsWindow(Gtk.ApplicationWindow):
    def __init__(self, application, directory):
        super().__init__(application=application, title="Orbit native settings")
        self.directory = directory
        self.worker = ThreadPoolExecutor(max_workers=1)
        self.cancelled = threading.Event()
        self.closed = False
        self.pending_request = None
        self.set_default_size(800, 680)
        self.connect("close-request", self.on_close)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        for side in ("top", "bottom", "start", "end"):
            getattr(box, f"set_margin_{side}")(24)
        self.set_child(box)
        box.append(self.label("Native control settings", "title-1"))
        box.append(self.label("Private lab preview. Changes apply only to this lab."))
        box.append(self.label("Control mode", "heading"))
        self.protected = Gtk.CheckButton(label="Protected: approve each exact action once")
        self.full = Gtk.CheckButton(label="Full access: allow actions and keep the action log")
        self.full.set_group(self.protected)
        for choice in (self.protected, self.full):
            choice.update_property([Gtk.AccessibleProperty.LABEL], [choice.get_label()])
        box.append(self.protected)
        box.append(self.full)
        row = Gtk.Box(spacing=12)
        self.apply = Gtk.Button(label="Apply mode")
        self.apply.connect("clicked", lambda _: self.submit(mode="full" if self.full.get_active() else "protected"))
        self.refresh = Gtk.Button(label="Refresh")
        self.refresh.connect("clicked", lambda _: self.submit())
        row.append(self.apply)
        row.append(self.refresh)
        box.append(row)
        self.status = self.label("Reading settings...")
        box.append(self.status)
        box.append(self.label("Latest request awaiting approval", "heading"))
        self.request = self.label("No request loaded.")
        self.request.set_selectable(True)
        request_scroll = Gtk.ScrolledWindow(min_content_height=70, max_content_height=130)
        request_scroll.set_child(self.request)
        box.append(request_scroll)
        self.approve = Gtk.Button(label="Approve this action once")
        self.approve.connect("clicked", self.on_approve)
        box.append(self.approve)
        box.append(self.label("Recent activity", "heading"))
        self.activity = self.label("")
        self.activity.set_selectable(True)
        scroll = Gtk.ScrolledWindow(vexpand=True, min_content_height=120)
        scroll.set_child(self.activity)
        box.append(scroll)
        box.append(self.label("This preview controls cooperating Orbit tools. It is not a system security boundary."))
        self.submit()

    @staticmethod
    def label(text, style=None):
        widget = Gtk.Label(label=text, xalign=0, wrap=True)
        widget.set_valign(Gtk.Align.START)
        if style:
            widget.add_css_class(style)
        return widget

    def on_close(self, *_):
        self.closed = True
        self.cancelled.set()
        self.worker.shutdown(wait=False, cancel_futures=True)
        return False

    def on_approve(self, _):
        if self.pending_request is not None:
            self.submit(approve=self.pending_request)

    def submit(self, **changes):
        for widget in (self.apply, self.refresh, self.approve, self.protected, self.full):
            widget.set_sensitive(False)
        self.status.set_text("Reading settings..." if not changes else "Saving settings...")

        def work():
            with SettingsControl(self.directory, self.cancelled) as control:
                # Refuse changes when the journal cannot be inspected.
                checked_snapshot(control)
                if changes:
                    control.configure(**changes)
                return checked_snapshot(control)

        def completed(future):
            try:
                result, error = future.result(), None
            except Exception as caught:
                result, error = None, str(caught)
            GLib.idle_add(self.loaded, result, error)

        self.worker.submit(work).add_done_callback(completed)

    def loaded(self, result, error):
        try:
            return self.render_loaded(result, error)
        except Exception as caught:
            return self.render_loaded(None, f"Invalid settings or activity: {caught}")

    def render_loaded(self, result, error):
        if self.closed:
            return GLib.SOURCE_REMOVE
        self.refresh.set_sensitive(True)
        self.pending_request = None
        if error is not None:
            for widget in (self.apply, self.approve, self.protected, self.full):
                widget.set_sensitive(False)
            self.status.set_text(f"Could not read or save settings: {error}. Fix storage, then Refresh.")
            self.request.set_text("Approval unavailable until settings and the log can be read.")
            self.activity.set_text("Activity unavailable.")
            return GLib.SOURCE_REMOVE
        settings, events = result["settings"], result["events"]
        mode = settings["mode"]
        self.protected.set_active(mode == "protected")
        self.full.set_active(mode == "full")
        for widget in (self.apply, self.protected, self.full):
            widget.set_sensitive(True)
        unresolved = len(result["unresolved"])
        approval = " One-use approval is ready." if settings["approval"] else ""
        self.status.set_text(f"Applied mode: {'Protected' if mode == 'protected' else 'Full access'}.{approval} Unfinished actions: {unresolved}.")
        # Only offer the most recent denial if no subsequent approval or retry
        # has superseded it. Refresh never rearms a consumed approval.
        denied = next((event for event in reversed(events) if event["phase"] == "denied"), None)
        if mode == "protected" and denied and not settings["approval"]:
            index = events.index(denied)
            superseded = any(event["phase"] == "begin" and
                             (event.get("request") == denied["request"] or event.get("kind") == "settings")
                             for event in events[index + 1:])
            if not superseded:
                self.pending_request = denied["request"]
        ready = denied and settings["approval"] == ActionControl.fingerprint(denied["request"])
        preview = self.pending_request or (denied["request"] if ready else None)
        self.request.set_text(describe(preview) if preview else "No new request awaiting approval.")
        self.approve.set_sensitive(self.pending_request is not None)
        lines = []
        intents = {event["id"]: event for event in events if event["phase"] == "begin"}
        for event in events[-20:]:
            time = datetime.datetime.fromtimestamp(event["epoch_ns"] / 1e9).strftime("%I:%M:%S %p")
            intent = intents.get(event["id"], event)
            content = describe(intent["request"]) if "request" in intent else "Settings: " + intent["settings"]["mode"]
            lines.append(f"{time}  {event['phase']}  {event.get('outcome', '')}  {content}")
        self.activity.set_text("\n".join(lines) or "No actions recorded.")
        return GLib.SOURCE_REMOVE


def main():
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    app = Gtk.Application(application_id="org.sbar.Orbit.NativeSettingsPreview", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.connect("activate", lambda application: SettingsWindow(application, directory).present())
    return app.run(None)


if __name__ == "__main__":
    raise SystemExit(main())
