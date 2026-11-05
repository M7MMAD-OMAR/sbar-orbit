"""Pure source-extracted panel click tests. No GTK import, threads or navigation."""
import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PANEL = ast.parse((ROOT / "desktop/panel.py").read_text())
CARDS = ast.parse((ROOT / "desktop/panel_sessions.py").read_text())
spec = importlib.util.spec_from_file_location("owned_panel_broker", ROOT / "desktop/panel_broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def source_method(name):
    found = [node for node in ast.walk(PANEL) if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(found) != 1: raise AssertionError("Expected exact production panel method: " + name)
    return found[0]


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.jobs, self.idle, self.rpc_calls, self.events = [], [], [], []
        self.failure, self.start_failure = None, False
        owner = self
        class Thread:
            def __init__(inner, *, target, daemon): inner.target = target; owner.assertTrue(daemon)
            def start(inner):
                if owner.start_failure: raise RuntimeError("Owned start failure")
                owner.jobs.append(inner.target)
        def idle_add(callback, *args): self.idle.append((callback, args)); return len(self.idle)
        def reveal(path, session_id):
            self.rpc_calls.append((path, session_id))
            if self.failure is not None: raise self.failure
            return {"revealed": True}
        translations = {"unknown-error": "Unavailable", "err-TARGET_CLOSED": "Target closed"}
        env = {"threading": SimpleNamespace(Thread=Thread), "GLib": SimpleNamespace(idle_add=idle_add),
               "reveal_session": reveal, "BrokerError": broker.BrokerError, "text": lambda key: translations.get(key, key)}
        methods = [source_method(name) for name in ("select_session", "reveal_done", "watch_sessions", "show_detail")]
        exec(compile(ast.fix_missing_locations(ast.Module(body=methods, type_ignores=[])), "owned-panel-methods", "exec"), env)
        class FakePanel: pass
        for name in ("select_session", "reveal_done", "watch_sessions", "show_detail"): setattr(FakePanel, name, env[name])
        self.panel = FakePanel(); p = self.panel
        p.stopping = False; p.path = "owned-private.sock"; p.revealing = set(); p.notes = {}; p.detail_id = None
        p.confirming = None; p.page_name = None; p.journal = []
        p.sessions = [{"sessionId": "a", "state": "running"}, {"sessionId": "b", "state": "running"}, {"sessionId": "closed", "state": "closed"}]
        p.everyone = lambda: p.sessions
        p.set_expanded = lambda value: self.events.append(("expanded", value))
        p.detail = SimpleNamespace(open=lambda value: self.events.append(("detail", value)), update=lambda value: None,
                                   set_rows=lambda value: None, back=SimpleNamespace(grab_focus=lambda: self.events.append(("widget-focus",))))
        p.stack = SimpleNamespace(set_visible_child_name=lambda value: self.events.append(("page", value)))
        p.fit = lambda: None; p.wake = SimpleNamespace(set=lambda: self.events.append(("wake",)))
        p.refresh_views = lambda: self.events.append(("refresh", p.detail_id))

    def drain_idle(self):
        while self.idle:
            callback, args = self.idle.pop(0); callback(*args)

    def click(self, session_id):
        card = next(node for node in CARDS.body if isinstance(node, ast.ClassDef) and node.name == "SessionCard")
        calls = [node for node in ast.walk(card) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and node.func.attr == "connect" and ast.unparse(node.func.value) == "self.select"
                 and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "clicked"]
        self.assertEqual(len(calls), 1)
        callback = eval(compile(ast.fix_missing_locations(ast.Expression(calls[0].args[1])), "owned-card-click", "eval"), {"panel": self.panel, "session_id": session_id})
        callback(None)

    def test_actual_card_clicked_callback_only_queues_exact_owner_selection(self):
        self.click("a")
        self.assertEqual(self.panel.detail_id, "a"); self.assertEqual(self.rpc_calls, [])
        self.assertEqual(len(self.jobs), 1); self.jobs.pop(0)(); self.drain_idle()
        self.assertEqual(self.rpc_calls, [("owned-private.sock", "a")]); self.assertEqual(self.panel.revealing, set())

    def test_existing_detail_and_watch_paths_never_queue_navigation(self):
        self.panel.show_detail("a"); self.panel.watch_sessions("b"); self.drain_idle()
        self.assertEqual(self.panel.detail_id, "b"); self.assertEqual(self.jobs, []); self.assertEqual(self.rpc_calls, [])

    def test_poll_refresh_action_and_detail_methods_have_no_reveal_or_select_call(self):
        for name in ("poll_loop", "refresh_views", "show_detail", "watch_sessions", "show_list", "act", "action_done"):
            for node in ast.walk(source_method(name)):
                if not isinstance(node, ast.Call): continue
                called = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
                self.assertNotIn(called, {"select_session", "reveal_session"}, name)

    def test_unknown_closed_and_stopping_selection_never_reveals(self):
        self.click("missing"); self.click("closed")
        self.panel.stopping = True; self.click("a")
        self.assertEqual(self.jobs, []); self.assertEqual(self.rpc_calls, [])

    def test_duplicate_owner_click_while_pending_is_not_retried(self):
        self.click("a"); self.click("a"); self.assertEqual(len(self.jobs), 1)
        self.jobs.pop(0)(); self.drain_idle(); self.assertEqual(len(self.rpc_calls), 1)

    def test_late_worker_keeps_captured_id_and_error_does_not_overwrite_other_detail(self):
        self.click("a"); self.panel.show_detail("b"); self.panel.notes["b"] = "Keep"
        self.failure = broker.BrokerError("PRIVATE-worker-output", "TARGET_CLOSED")
        self.jobs.pop(0)(); self.drain_idle()
        self.assertEqual(self.rpc_calls, [("owned-private.sock", "a")]); self.assertEqual(self.panel.detail_id, "b")
        self.assertEqual(self.panel.notes, {"b": "Keep"})

    def test_matching_error_is_safe_localized_and_start_failure_unblocks(self):
        self.failure = broker.BrokerError("PRIVATE-worker-output", "TARGET_CLOSED")
        self.click("a"); self.jobs.pop(0)(); self.drain_idle()
        self.assertEqual(self.panel.notes["a"], "Target closed"); self.assertNotIn("PRIVATE", str(self.panel.notes))
        self.start_failure = True; self.click("a")
        self.assertNotIn("a", self.panel.revealing); self.assertEqual(self.panel.notes["a"], "Unavailable")

    def test_stopping_after_click_prevents_new_rpc_without_touching_another_session(self):
        self.click("a"); self.panel.stopping = True; self.jobs.pop(0)(); self.drain_idle()
        self.assertEqual(self.rpc_calls, []); self.assertEqual(self.panel.revealing, set())

    def test_actual_broker_helper_oneoff_uses_owner_header_exact_session_id_and_no_retry(self):
        requests, closed = [], []
        payload = {"ok": True, "result": {"revealed": True}}
        class Connection:
            def __init__(inner, path, timeout): self.assertEqual((path, timeout), ("owned.sock", broker.ACTION_TIMEOUT))
            def request(inner, method, path, *, body, headers): requests.append((method, path, json.loads(body), headers))
            def getresponse(inner): return SimpleNamespace(read=lambda limit: json.dumps(payload).encode())
            def close(inner): closed.append(True)
        with patch.object(broker, "UnixConnection", Connection), patch.object(broker, "owner_credential", return_value="OWNED_OWNER_TOKEN"):
            self.assertEqual(broker.reveal_session("owned.sock", "a"), {"revealed": True})
            payload = {"ok": False, "error": {"code": "TARGET_CLOSED", "message": "Owned refusal"}}
            with self.assertRaises(broker.BrokerError): broker.reveal_session("owned.sock", "a")
        self.assertEqual(len(requests), 2); self.assertEqual(len(closed), 2)
        for method, path, body, headers in requests:
            self.assertEqual((method, path, body), ("POST", "/rpc", {"method": "session.reveal", "params": {"sessionId": "a"}}))
            self.assertEqual(headers["X-Orbit-Owner"], "OWNED_OWNER_TOKEN")


if __name__ == "__main__": unittest.main()
