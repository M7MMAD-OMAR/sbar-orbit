"""Press, hold, release and drag are ordinary native actions with the same strict shape checks."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.native.session import NativeSession, SessionError
from src.native.transport import ACTIONS, action_request, action_response


APP, WINDOW = "a" * 32, "b" * 32


class PointerHoldTests(unittest.TestCase):
    def test_new_actions_parse_with_a_default_left_button(self):
        for kind in ("mouse-down", "mouse-up"):
            action = NativeSession.parse({"type": kind, "appId": APP, "windowId": WINDOW, "x": 5, "y": 6})
            self.assertEqual(action["button"], "left")
        drag = NativeSession.parse({"type": "drag", "appId": APP, "windowId": WINDOW, "x": 1, "y": 2, "toX": 30, "toY": 40,
                                    "button": "right"})
        self.assertEqual((drag["toX"], drag["toY"], drag["button"]), (30, 40, "right"))

    def test_shapes_are_strict(self):
        base = {"appId": APP, "windowId": WINDOW}
        for bad in ({"type": "drag", **base, "x": 1, "y": 2},
                    {"type": "drag", **base, "x": 1, "y": 2, "toX": float("nan"), "toY": 3},
                    {"type": "drag", **base, "x": 1, "y": 2, "toX": 3, "toY": 3, "button": "side"},
                    {"type": "mouse-down", **base, "x": 1, "y": 2, "toX": 3},
                    {"type": "mouse-up", **base, "x": 1, "y": 2, "dy": 1},
                    {"type": "click", **base, "x": 1, "y": 2, "toX": 3}):
            with self.subTest(bad=bad), self.assertRaises(SessionError):
                NativeSession.parse(bad)

    def test_transport_carries_only_the_three_new_plugin_commands(self):
        for command in ("ghost-mouse-down", "ghost-mouse-up", "ghost-drag"):
            self.assertIn(command, ACTIONS)
            self.assertEqual(action_request(command + " 0x1@2@lease-x 1 2"), command)
            self.assertEqual(action_response(command, "ok"), "ok")
        with self.assertRaises(Exception):
            action_response("ghost-drag", "refused: a button is already held")

    def test_state_reply_may_report_motion_without_breaking_the_boolean_contract(self):
        reply = json.dumps({"suspended": False, "render_unfocused": False, "motion_active": True, "motion_ms": 420})
        self.assertEqual(action_response("ghost-state", reply), reply)


if __name__ == "__main__":
    unittest.main()
