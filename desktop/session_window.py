#!/usr/bin/python3
"""Native window for one Orbit session: watch the private desktop live, take over and hand back.

    session_window.py SESSION_ID

A plain GTK window that talks to the broker over its owner-only socket. No browser, no loopback
page and no token: frames come from session.observe and manual input goes through session.control,
which the broker accepts only while the session is paused. Clicking a session card in the panel
opens it.
"""
import base64
import http.client
import json
import os
from pathlib import Path
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))
from orbit_client import UnixConnection, broker_socket  # noqa: E402

import gi  # noqa: E402

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

MAX_REPLY = 32 * 1024 * 1024
POLL_SECONDS = 1.0
KEYS = ("Enter", "Tab", "Escape", "Ctrl+A")


class Broker:
    """One connection per thread; a frame reply can be several megabytes."""

    def __init__(self, path):
        self.path = path
        self.connection = None

    def call(self, method, params=None):
        for attempt in (0, 1):
            try:
                if self.connection is None:
                    self.connection = UnixConnection(self.path)
                    self.connection.connect()
                self.connection.request("POST", "/rpc", body=json.dumps({"method": method, "params": params or {}}),
                                        headers={"Content-Type": "application/json"})
                payload = json.loads(self.connection.getresponse().read(MAX_REPLY))
                if not payload.get("ok"):
                    raise RuntimeError(payload.get("error", {}).get("message", "Broker request failed"))
                return payload["result"]
            except (OSError, http.client.HTTPException):
                self.close()
                if attempt:
                    raise
        return None

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None


def image_point(widget_x, widget_y, widget_width, widget_height, image_width, image_height):
    """Map a point on the picture widget to image pixels, for a picture scaled to fit and centred."""
    if min(widget_width, widget_height, image_width, image_height) <= 0:
        return None
    scale = min(widget_width / image_width, widget_height / image_height)
    left = (widget_width - image_width * scale) / 2
    top = (widget_height - image_height * scale) / 2
    x, y = (widget_x - left) / scale, (widget_y - top) / scale
    if x < 0 or y < 0 or x >= image_width or y >= image_height:
        return None
    return int(x), int(y)


class SessionWindow(Gtk.Application):
    def __init__(self, session_id, path):
        super().__init__(application_id=None)
        self.session_id, self.path = session_id, path
        self.state, self.size = "", (0, 0)
        self.closed = threading.Event()
        self.busy = False
        self.hover = None

    def do_activate(self):
        window = Gtk.ApplicationWindow(application=self, title="Orbit")
        window.set_default_size(1100, 760)
        window.connect("close-request", lambda *_: self.closed.set() or False)
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        for side in ("top", "bottom", "start", "end"):
            getattr(root, f"set_margin_{side}")(10)
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.title = Gtk.Label(label="Connecting to the session", xalign=0)
        self.title.set_hexpand(True)
        self.title.set_ellipsize(3)
        self.status = Gtk.Label(label="")
        self.toggle = Gtk.Button(label="Take over")
        self.toggle.connect("clicked", lambda *_: self.take_or_hand_back())
        bar.append(self.title)
        bar.append(self.status)
        bar.append(self.toggle)
        root.append(bar)
        self.picture = Gtk.Picture()
        self.picture.set_content_fit(Gtk.ContentFit.CONTAIN)
        self.picture.set_vexpand(True)
        self.picture.set_hexpand(True)
        click = Gtk.GestureClick()
        click.connect("released", self.on_click)
        self.picture.add_controller(click)
        scroll = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.VERTICAL)
        scroll.connect("scroll", self.on_scroll)
        self.picture.add_controller(scroll)
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", lambda _controller, x, y: setattr(self, "hover", (x, y)))
        self.picture.add_controller(motion)
        root.append(self.picture)
        typing = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.text = Gtk.Entry(placeholder_text="Text to send while you have control")
        self.text.set_hexpand(True)
        self.text.connect("activate", lambda *_: self.send_text())
        send = Gtk.Button(label="Send text")
        send.connect("clicked", lambda *_: self.send_text())
        typing.append(self.text)
        typing.append(send)
        for key in KEYS:
            button = Gtk.Button(label=key)
            button.connect("clicked", lambda _button, value=key: self.control({"type": "key", "key": value}))
            typing.append(button)
        self.typing = typing
        root.append(typing)
        window.set_child(root)
        window.present()
        self.window = window
        self.refresh_controls()
        threading.Thread(target=self.poll, daemon=True).start()

    # --- Broker work, off the main thread ----------------------------------------------------

    def poll(self):
        broker = Broker(self.path)
        while not self.closed.is_set():
            try:
                session = next((s for s in broker.call("session.list") or [] if s.get("sessionId") == self.session_id), None)
                if session is None:
                    GLib.idle_add(self.show_state, None, "This session has ended")
                    return
                frame = None
                if session.get("state") not in ("closed", "closing"):
                    frame = broker.call("session.observe", {"sessionId": self.session_id})
                GLib.idle_add(self.show_state, session, frame)
            except Exception as error:
                GLib.idle_add(self.show_state, None, f"Orbit is not reachable: {error}")
            self.closed.wait(POLL_SECONDS)
        broker.close()

    def run_in_background(self, method, params, done=None):
        if self.busy:
            return
        self.busy = True
        self.refresh_controls()

        def work():
            broker = Broker(self.path)
            try:
                result, error = broker.call(method, {"sessionId": self.session_id, **params}), None
            except Exception as failure:
                result, error = None, str(failure)
            finally:
                broker.close()
            GLib.idle_add(self.finish, error, done, result)
        threading.Thread(target=work, daemon=True).start()

    # --- Main thread --------------------------------------------------------------------------

    def finish(self, error, done, result):
        self.busy = False
        if error:
            self.status.set_label(error[:120])
        elif done:
            done(result)
        self.refresh_controls()
        return False

    def show_state(self, session, frame):
        if session is None:
            self.title.set_label(frame if isinstance(frame, str) else "Session unavailable")
            self.state = "closed"
            self.refresh_controls()
            return False
        self.state = session.get("state", "")
        presence = session.get("presence") or {}
        what = presence.get("title") or session.get("taskName") or "Private desktop"
        self.title.set_label(f"{session.get('agentName', 'Agent')}  ·  {session.get('taskName', '')}  ·  {what}")
        if isinstance(frame, dict) and frame.get("image"):
            data = GLib.Bytes.new(base64.b64decode(frame["image"]))
            try:
                self.picture.set_paintable(Gdk.Texture.new_from_bytes(data))
                self.size = (int(frame.get("width", 0)), int(frame.get("height", 0)))
            except GLib.Error:
                pass
        self.refresh_controls()
        return False

    def refresh_controls(self):
        paused = self.state == "paused"
        labels = {"paused": "You are in control", "running": "The agent is working", "pausing": "Taking over",
                  "closed": "Ended"}
        if not self.busy:
            self.status.set_label(labels.get(self.state, self.state))
        self.toggle.set_label("Hand back" if paused else "Take over")
        self.toggle.set_sensitive(not self.busy and self.state in ("paused", "running"))
        self.typing.set_sensitive(paused and not self.busy)

    def take_or_hand_back(self):
        method = "session.resume" if self.state == "paused" else "session.pause"
        self.run_in_background(method, {}, lambda result: self.show_state(result, None) if isinstance(result, dict) else None)

    def control(self, value):
        if self.state != "paused":
            return
        self.run_in_background("session.control", {"input": value})

    def send_text(self):
        text = self.text.get_text()
        if text:
            self.control({"type": "paste", "text": text})
            self.text.set_text("")

    def point(self, x, y):
        return image_point(x, y, self.picture.get_width(), self.picture.get_height(), *self.size)

    def on_click(self, _gesture, _count, x, y):
        target = self.point(x, y)
        if target:
            self.control({"type": "click", "x": target[0], "y": target[1]})

    def on_scroll(self, _controller, _dx, dy):
        if not dy:
            return False
        target = self.point(*self.hover) if self.hover else None
        width, height = self.size
        target = target or (width // 2, height // 2)
        steps = max(-20, min(20, round(dy) or (1 if dy > 0 else -1)))
        self.control({"type": "scroll", "x": target[0], "y": target[1], "deltaY": steps})
        return True


def main(argv):
    if len(argv) != 2 or not argv[1]:
        print("Usage: session_window.py SESSION_ID", file=sys.stderr)
        return 2
    path = os.environ.get("ORBIT_SOCKET") or broker_socket()
    return SessionWindow(argv[1], path).run([argv[0]])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
