"""Render the About page in its own window and save frames, without touching the owner's screen.

Run it inside a nested or headless compositor, never on the owner's display:

    mutter --headless --wayland --no-x11 --virtual-monitor 1000x1100 --wayland-display wayland-about &
    XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-about GDK_BACKEND=wayland \\
        python3 desktop/panel_about_harness.py --lang ar --scenario blocked --out /tmp/frame.png

The frame is the widget's own render node saved as PNG, so it is what GTK draws, not a screen capture.
Scenarios use a fake command seam (see `about_data`) so the owner's broker is never touched; `--real`
uses the real commands read-only (no Update now).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import about_data  # noqa: E402
import panel_about  # noqa: E402

ABI = "efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.15_hu_0.14_hg_0.5_hc_0.1_hlg_0.6"
LOADED = "c8337d16d03832fa9ab3700bba474088711f87973d2ecdeddd3322b1ea92e90a"


def envelope(result):
    return json.dumps({"ok": True, "result": result})


def session(identifier, agent, window, workspace, working):
    return {"sessionId": identifier, "state": "running", "agentName": agent, "taskName": "Native application",
            "activity": {"state": "working" if working else "done"},
            "handoff": {"workspace": workspace, "windows": [{"title": window}]}}


class Scenario:
    """A fake machine. `plugin` is match or source_mismatch; `sessions` the open ones; `managed` whether
    updates can activate; `latest` the version the registry offers."""

    def __init__(self, plugin="match", sessions=(), managed=True, latest=None, root=None):
        self.plugin, self.sessions, self.managed, self.latest = plugin, list(sessions), managed, latest
        self.stopped, self.activated = [], []
        self.root = root

    def __call__(self, argv, timeout=30):
        words = tuple(argv[1:]) if argv[0].endswith("sbar-orbit") else tuple(argv)
        if words[:1] == ("doctor",):
            return 0, envelope({"version": "0.3.3", "units": {"managed": True, "drifted": [], "missing": [], "current": True}})
        if words[:1] == ("status",):
            return 0, json.dumps({"sessions": self.sessions})
        if words[:2] == ("session", "list"):
            return 0, envelope(self.sessions)
        if words[:2] == ("session", "stop"):
            self.stopped.append(words[2])
            self.sessions = [s for s in self.sessions if s["sessionId"] != words[2]]
            return 0, "{}"
        if words[:2] == ("update", "status"):
            return 0, json.dumps({"managed": self.managed, "pending": [], "prepared": [], "current": "0.3.3",
                                  "reason": "this install runs from a source checkout; a source checkout updates with git"})
        if words[:2] == ("update", "check"):
            eligible = {"version": self.latest} if self.latest else None
            return 0, json.dumps({"current": "0.3.3", "latest": self.latest, "eligible": eligible, "reason": "ok"})
        if words[:2] == ("update", "stage"):
            return 0, json.dumps({"prepared": True, "version": self.latest})
        if words[:2] == ("update", "activate"):
            self.activated.append(words[2])
            return 0, json.dumps({"activated": True, "version": words[2], "previous": "0.3.3"})
        if words[:1] == ("systemctl",):
            return 0, "MainPID=4242\nActiveState=active\n"
        if words[:1] == ("ps",):
            return 0, " 7465\n"
        if words[:2] == ("native-plugin", "status"):
            source = LOADED if self.plugin == "source_mismatch" else about_data.sha256_of(os.path.join(about_data.ROOT, about_data.PLUGIN_SOURCE))
            return 0, envelope({"loaded": True, "build": {"schema": 1, "source_sha256": source, "abi_hash": ABI, "live_roots": 0}})
        return 1, ""


class Hybrid:
    """Real commands against whatever broker ORBIT_SOCKET names, except the update feed, which says this
    install is managed and 0.3.4 is eligible. `update activate` is refused here on purpose: the blocked
    path must stop before it, and a harness must never restart a broker."""

    def __call__(self, argv, timeout=30):
        words = tuple(argv[1:]) if argv[0].endswith("sbar-orbit") else tuple(argv)
        if words[:2] == ("update", "status"):
            return 0, json.dumps({"managed": True, "pending": [], "prepared": [], "current": "0.3.3"})
        if words[:2] == ("update", "check"):
            return 0, json.dumps({"current": "0.3.3", "latest": "0.3.4", "eligible": {"version": "0.3.4"}, "reason": "ok"})
        if words[:2] == ("update", "stage"):
            return 0, json.dumps({"prepared": True, "version": "0.3.4"})
        if words[:2] == ("update", "activate"):
            raise RuntimeError("the harness never activates an update")
        return about_data.default_run(argv, timeout)


SCENARIOS = {
    "mismatch": lambda: Scenario("source_mismatch", managed=False),
    "healthy": lambda: Scenario("match", latest="0.3.4"),
    "blocked": lambda: Scenario("match", [session("aaaa1111", "Claude", "Calculator", 3, True),
                                          session("bbbb2222", "Codex", "Files", 4, False),
                                          session("cccc3333", "Hermes", "Text Editor", 7, False)], latest="0.3.4"),
}


def main():
    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import GLib, Gtk
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="en")
    parser.add_argument("--scenario", default="mismatch", choices=sorted(SCENARIOS))
    parser.add_argument("--steps", default="", help="comma list of check, update, stop, update")
    parser.add_argument("--out", required=True)
    parser.add_argument("--light", action="store_true")
    parser.add_argument("--hybrid", action="store_true", help="real commands, fake update feed")
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--size", default="520x900")
    args = parser.parse_args()
    scenario = Hybrid() if args.hybrid else None if args.real else SCENARIOS[args.scenario]()
    width, height = (int(v) for v in args.size.split("x"))
    Gtk.init()
    window = Gtk.Window(title="Orbit About harness", default_width=width, default_height=height)
    css = Gtk.CssProvider()
    css.load_from_string("window.harness { background: %s; color: %s; }" % (
        ("#f4f4f5", "#1c1c1e") if args.light else ("#1c1c1e", "#f2f2f2")))
    Gtk.StyleContext.add_provider_for_display(window.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
    window.add_css_class("harness")
    page = panel_about.build_about_page(None, language=args.lang, run=scenario)
    page.set_margin_start(16)
    page.set_margin_end(16)
    page.set_margin_top(12)
    window.set_child(page)
    window.present()
    loop = GLib.MainLoop()
    steps = [step for step in args.steps.split(",") if step]

    def settle(then):
        def poll():
            if page.busy:
                return True
            GLib.timeout_add(150, then)
            return False
        GLib.timeout_add(100, poll)

    def save():
        paintable = Gtk.WidgetPaintable.new(window)
        snapshot = Gtk.Snapshot()
        paintable.snapshot(snapshot, window.get_width(), window.get_height())
        node = snapshot.to_node()
        texture = window.get_native().get_renderer().render_texture(node, None)
        texture.save_to_png(args.out)
        print(json.dumps({"saved": args.out, "state": page.snapshot and page.snapshot["plugin"]["state"],
                          "update": page.update_view.get("kind"), "stopped": getattr(scenario, "stopped", None),
                          "activated": getattr(scenario, "activated", None)}))
        loop.quit()
        return False

    def next_step():
        if not steps:
            return save()
        step = steps.pop(0)
        {"check": page.check_updates, "update": page.update_now, "stop": page.stop_idle}[step]()
        settle(next_step)
        return False

    settle(next_step)
    GLib.timeout_add(60000, loop.quit)
    loop.run()


if __name__ == "__main__":
    main()
