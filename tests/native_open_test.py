"""Real-profile launch admission, argument separation and window attribution."""
import json
import os
import re
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.owner_open import open_application, validate_open
from src.native.control import ActionControl, ControlError
from src.native.lease import process_identity
from src.native.session import SessionError
from src.native.owner_open_helper import main as helper_main


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.directory.chmod(0o700)
        self.control = ActionControl(self.directory / "control")
        self.addCleanup(self.control.close)
        self.commands = []
        self.launched = False
        self.pid = os.getpid()
        self.workspace = 4
        self.layout = [960, 640]
        self.floating = True
        self.xwayland = False
        self.session = SimpleNamespace(directory=self.directory, control=self.control,
                                       transport=SimpleNamespace(_exchange=self.exchange))

    def exchange(self, command):
        self.commands.append(command)
        if command == "j/clients":
            return json.dumps([{"address": "0xabc", "stableId": "123", "pid": self.pid,
                                "workspace": {"id": self.workspace}, "xwayland": self.xwayland,
                                "floating": self.floating, "size": self.layout, "at": [(1920 - self.layout[0]) / 2, (1080 - self.layout[1]) / 2]}] if self.launched else [])
        if command == "j/workspaces":
            return json.dumps([{"id": 4, "monitor": "test-monitor"}])
        if command == "j/monitors":
            return json.dumps([{"name": "test-monitor", "x": 0, "y": 0, "width": 1920, "height": 1080,
                                "scale": 1, "focused": True, "reserved": [0, 0, 0, 0]}])
        match = re.match(r'eval hl.exec_cmd\(("(?:[^"\\]|\\.)*"), ', command)
        if not match:
            raise AssertionError("Expected the native Lua launch command")
        launch = json.loads(match[1])
        spec = json.loads(Path(shlex.split(launch)[-1]).read_text())
        self.arguments = spec["argv"]
        Path(spec["receipt"]).write_text(json.dumps(process_identity(os.getpid())))
        self.launched = True
        return "ok"

    def test_protected_denial_precedes_dispatch(self):
        with self.assertRaises(ControlError):
            open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertEqual(self.commands, [])

    def test_literal_arguments_and_launch_bound_identity(self):
        self.control.configure(mode="full")
        arg = 'literal $(touch /tmp/unwanted) ; "quoted"'
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true", arg]})
        self.assertEqual(self.arguments, ["/usr/bin/true", arg])
        launch = next(command for command in self.commands if command.startswith("eval hl.exec_cmd"))
        self.assertNotIn(arg, launch)
        self.assertIn('workspace="4 silent", no_initial_focus=true, focus_on_activate=false', launch)
        self.assertEqual(result["address"], "0xabc")
        self.assertEqual(result["applicationLifetime"], "owner")
        self.assertIn("held", result["handoff"])

    def test_default_open_is_floating_and_verified(self):
        self.control.configure(mode="full")
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["window"]["floating"])
        self.assertEqual(result["window"]["width"], 960)
        launch = next(command for command in self.commands if command.startswith("eval hl.exec_cmd"))
        self.assertIn("float=true", launch)
        self.assertIn('size="960 640"', launch)
        self.assertIn("center=true", launch)

    def test_custom_size_is_passed_and_measured(self):
        self.control.configure(mode="full")
        self.layout = [800, 600]
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"],
                                                "window": {"width": 800, "height": 600}})
        self.assertEqual((result["window"]["width"], result["window"]["height"]), (800, 600))

    def test_tiled_acknowledgement_is_not_placement_success(self):
        self.control.configure(mode="full")
        self.floating = False
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 20]), patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(SessionError, "uncertain"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})

    def test_xwayland_original_opening_does_not_require_wayland_input_handoff(self):
        self.control.configure(mode="full")
        self.xwayland = True
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["opened"])
        self.assertEqual(result["windowProtocol"], "xwayland")
        self.assertIn("held", result["handoff"])

    def test_wrong_workspace_refuses_identity(self):
        self.control.configure(mode="full")
        self.workspace = 5
        with self.assertRaisesRegex(SessionError, "requested workspace"):
            open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})

    def test_unrelated_new_window_is_never_guessed(self):
        self.control.configure(mode="full")
        self.pid = 1
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 20]), patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(SessionError, "uncertain"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})



    def test_relative_executable_is_resolved_before_approval(self):
        with patch("src.native.owner_open.shutil.which", return_value="./owner-app"):
            value = validate_open({"workspace": 4, "argv": ["./owner-app"]})
        self.assertEqual(value["argv"][0], str(Path("./owner-app").absolute()))



    def test_launch_receipt_is_complete_when_published(self):
        import time
        receipt = self.directory / "opened.json"
        specification = self.directory / "specification.json"
        specification.write_text(json.dumps({"argv": ["/usr/bin/true"], "receipt": str(receipt), "expires": time.time() + 10}))
        specification.chmod(0o600)
        link = os.link
        def publish(source, destination):
            self.assertFalse(receipt.exists())
            self.assertEqual(json.loads(Path(source).read_text()), list(process_identity(os.getpid())))
            link(source, destination)
        with patch("src.native.owner_open_helper.os.link", side_effect=publish), patch("src.native.owner_open_helper.os.execv") as execute:
            helper_main(str(specification))
        execute.assert_called_once_with("/usr/bin/true", ["/usr/bin/true"])
        self.assertEqual(json.loads(receipt.read_text()), list(process_identity(os.getpid())))
        self.assertFalse(receipt.with_name(receipt.name + ".writing").exists())

    def test_invalid_arguments_do_not_dispatch(self):
        for value in [{"workspace": True, "argv": ["true"]}, {"workspace": 4, "argv": ["true\nfalse"]},
                      {"workspace": 4, "argv": ["true"], "mode": "full"}]:
            with self.assertRaises(SessionError):
                validate_open(value)


if __name__ == "__main__":
    unittest.main()
