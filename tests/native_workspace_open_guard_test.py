"""Owned launch fixture: no actual application exec or workspace switch."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_open_test as fixtures
from src.native.owner_open import open_application, validate_open
from src.native.session import SessionError


class WorkspaceGuardTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.OpenTests("runTest")
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.control.configure(mode="full")
        self.original = self.f.exchange

    def run_open(self, clients=None, shown=1, malformed=False):
        def exchange(command):
            if command == "j/monitors":
                return json.dumps([{"name": "test-monitor", "x": 0, "y": 0, "width": 1920, "height": 1080,
                    "scale": 1, "focused": True, "activeWorkspace": {"id": shown}, "reserved": [0, 0, 0, 0]}])
            if command == "j/clients" and not self.f.launched:
                return "{}" if malformed else json.dumps(clients or [])
            return self.original(command)
        self.f.session.transport._exchange = exchange
        return open_application(self.f.session, {"workspace": 4, "argv": ["/usr/bin/true"], "requireEmpty": True})

    def test_hidden_owner_window_refuses_before_exec(self):
        with self.assertRaises(SessionError):
            self.run_open(clients=[{"address": "0xdef", "stableId": "999", "workspace": {"id": 4}}])
        self.assertFalse(self.f.launched)
        self.assertFalse(any(command.startswith(("eval hl.exec_cmd", "dispatch exec")) for command in self.f.commands))

    def test_displayed_empty_workspace_refuses_before_exec(self):
        with self.assertRaises(SessionError): self.run_open(shown=4)
        self.assertFalse(self.f.launched)

    def test_unknown_inventory_refuses_before_exec(self):
        with self.assertRaises(SessionError): self.run_open(malformed=True)
        self.assertFalse(self.f.launched)

    def test_free_workspace_retains_silent_no_focus_launch_rules(self):
        result = self.run_open()
        self.assertTrue(result["opened"])
        launch = next(command for command in self.f.commands if command.startswith("eval hl.exec_cmd"))
        self.assertIn('workspace="4 silent", no_initial_focus=true, focus_on_activate=false', launch)
        self.assertFalse(any(command.startswith(("dispatch workspace", "dispatch focus", "dispatch movecursor")) for command in self.f.commands))

    def test_post_map_owner_occupancy_refuses_forwarded_placement(self):
        self.f.activation = True
        def exchange(command):
            if command == "j/monitors":
                return json.dumps([{"name": "test-monitor", "x": 0, "y": 0, "width": 1920, "height": 1080,
                    "scale": 1, "focused": True, "activeWorkspace": {"id": 1}, "reserved": [0, 0, 0, 0]}])
            reply = self.original(command)
            if command == "j/clients" and self.f.launched:
                return json.dumps(json.loads(reply) + [{"address": "0xdef", "stableId": "999", "pid": 999999, "workspace": {"id": 4}}])
            return reply
        self.f.session.transport._exchange = exchange
        with patch("src.native.owner_open.belongs_to", return_value=False), patch("src.native.owner_open.place_new_window") as move:
            result = open_application(self.f.session, {"workspace": 4, "argv": ["/usr/bin/true"], "requireEmpty": True})
        self.assertFalse(result["opened"])
        self.assertEqual(result["candidateReason"], "workspace-busy")
        move.assert_not_called()

    def test_empty_guard_is_strict_boolean(self):
        with self.assertRaises(SessionError): validate_open({"workspace": 4, "argv": ["/usr/bin/true"], "requireEmpty": "yes"})


if __name__ == "__main__": unittest.main()
