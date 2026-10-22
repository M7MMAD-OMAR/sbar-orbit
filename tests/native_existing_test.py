"""Borrowed application lifecycle controls with a compositor protocol fixture."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.control import ActionControl, ControlError
from desktop import orbit_settings
if os.environ.get("ORBIT_NATIVE_SESSION_SOURCE"):
    import importlib.util
    specification = importlib.util.spec_from_file_location("src.native.session", os.environ["ORBIT_NATIVE_SESSION_SOURCE"])
    module = importlib.util.module_from_spec(specification)
    sys.modules["src.native.session"] = module
    specification.loader.exec_module(module)

from src.native.existing import ExistingApplicationSession
from src.native.session import NativeSession, SessionError, ApplicationControlEnded, ApplicationOwnerBusy
from src.native.transport import NativeTransport


class Compositor:
    def __init__(self):
        self._input_lock = threading.RLock()
        self.lease_id = None
        self.active = False
        self.requests = []
        self.lose_claim = False
        self.claim_refusal = None
        self.foreign_target = False
        self.text = "Already open unsaved content مرحبا"
        self.address = "0x100"

    _perform = NativeTransport._perform

    def _exchange(self, request, deadline=None):
        self.requests.append(request)
        if request == "ghost-build-info":
            return json.dumps({"source_sha256": "a" * 64, "abi_hash": "fixture"})
        if request == "j/clients":
            return json.dumps([{"address": self.address, "stableId": "ab", "workspace": {"id": 8},
                                "size": [320, 180], "title": self.text, "xwayland": False}])
        if request.startswith("ghost-indicator-style "):
            return "ok"
        if request.startswith("ghost-application-claim "):
            if self.claim_refusal:
                return self.claim_refusal
            self.lease_id = request.split()[3]
            self.active = True
            if self.lose_claim:
                raise TimeoutError("Claim response lost after mutation")
            return json.dumps({"schema": 1, "status": "claimed", "lease_id": self.lease_id,
                               "scope": "entire-wayland-client", "windows": 1})
        if request.startswith("ghost-application-info "):
            lease_id = request.split()[1]
            return json.dumps({"schema": 1, "lease_id": lease_id,
                "status": "active" if self.active else "unavailable", "scope": "entire-wayland-client",
                "windows": [{"address": "0x100", "stable": "ab",
                             "target": f"0x100@ab@lease-{'0' * 32 if self.foreign_target else lease_id}"}] if self.active else []})
        if request.startswith("ghost-application-control "):
            if request.split()[2] == "handback":
                self.active = False
            return "ok"
        if request.startswith("ghost-application-reap "):
            return "ok"
        if request.startswith("ghost-cursor "):
            return "ok"
        if request.startswith("ghost-target-check "):
            return "ok"
        if request.startswith("ghost-keyboard-prepare "):
            return json.dumps({"schema": 1, "status": "ready", "token": request.split()[2], "serial": 9})
        if request.startswith("ghost-keyboard-cancel "):
            return "ok"
        if request.startswith("ghost-texthex-prepared "):
            self.text += bytes.fromhex(request.split()[3]).decode()
            return "ok 1 keys"
        if request.startswith("ghost-key-prepared "):
            final_key = request.split()[3].rsplit("+", 1)[-1]
            return "unknown key " + final_key if final_key.lower() == "enter" else "ok"
        raise AssertionError("Unexpected operation: " + request)


class ExistingApplicationTests(unittest.TestCase):
    def setUp(self):
        style = patch("src.native.indicator_style.orbit_settings.load", return_value=(orbit_settings.defaults(), None))
        style.start()
        self.addCleanup(style.stop)
        gate = patch("src.native.existing.require_native_plugin")
        gate.start()
        self.addCleanup(gate.stop)
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.control = ActionControl(root / "control")
        self.control.configure(mode="full")
        self.transport = Compositor()
        (root / "session").mkdir(mode=0o700)
        with patch("src.native.existing.NativeTransport", return_value=self.transport):
            self.session = ExistingApplicationSession({}, root / "session", self.control)

    def tearDown(self):
        self.control.close()
        self.tmp.cleanup()

    def test_existing_content_survives_action_and_handback_without_launch_or_kill(self):
        before = self.transport.text
        claimed = self.session.claim({"workspace": 8})
        target = claimed["windows"][0]
        self.session.execute({"type": "text", "appId": claimed["appId"],
                              "windowId": target["windowId"], "text": " continued"})
        self.session.close()
        self.assertEqual(self.transport.text, before + " continued")
        self.assertFalse(self.transport.active)
        self.assertTrue(self.session.closed)
        self.assertFalse(any("launch" in request or "kill" in request for request in self.transport.requests))
        self.assertEqual(self.control.inspect()["unresolved"], [])

    def test_claim_applies_owner_indicator_settings_before_enrollment(self):
        settings = orbit_settings.defaults()
        settings.update(frameColor="#A13F72", framePulse=False, frame=False)
        with patch("src.native.indicator_style.orbit_settings.load", return_value=(settings, None)):
            self.session.claim({"workspace": 8})
        requests = self.transport.requests
        style = requests.index("ghost-indicator-style a13f72 0 0")
        claimed = next(index for index, request in enumerate(requests) if request.startswith("ghost-application-claim "))
        self.assertLess(style, claimed)
        self.session.close()

    def test_denied_handoff_does_not_change_indicator_style(self):
        self.control.configure(mode="protected")
        with self.assertRaises(ControlError):
            self.session.claim({"workspace": 8})
        self.assertFalse(any(request.startswith("ghost-indicator-style ") for request in self.transport.requests))
        self.assertFalse(self.transport.active)
        self.session.close()

    def test_owner_input_busy_refusal_retains_typed_readiness_error(self):
        self.transport.claim_refusal = "refused: application client is receiving owner input"
        with self.assertRaisesRegex(ApplicationOwnerBusy, "owner keyboard or pointer input"):
            self.session.claim({"workspace": 8})
        self.assertFalse(self.transport.active)
        self.assertEqual(self.session.apps, {})
        self.assertEqual(self.session.windows, {})
        self.session.close()

    def test_claim_starts_a_render_only_pointer_without_application_input(self):
        claimed = self.session.claim({"workspace":8})
        self.assertEqual(claimed["pointer"],{"x":160,"y":90})
        self.assertIn(f"ghost-cursor 0x100@ab@lease-{claimed['appId']} 160 90",self.transport.requests)
        self.assertFalse(any(request.startswith(("ghost-key ","ghost-texthex ","ghost-click "))for request in self.transport.requests))
        self.session.close()

    def test_public_enter_alias_reaches_prepared_transport_as_return(self):
        claimed = self.session.claim({"workspace": 8})
        for supplied, expected in [("enter", "Return"), ("EnTeR", "Return"),
                                   ("ctrl+enter", "ctrl+Return"), ("ctrl+shift+ENTER", "ctrl+shift+Return"),
                                   ("Return", "Return"), ("KP_Enter", "KP_Enter"), ("ctrl+a", "ctrl+a")]:
            with self.subTest(key=supplied):
                self.transport.requests.clear()
                action = {"type": "key", "appId": claimed["appId"],
                          "windowId": claimed["selectedWindowId"], "key": supplied}
                self.assertEqual(self.session.execute(action), {"response": "ok"})
                commits = [request for request in self.transport.requests if request.startswith("ghost-key-prepared ")]
                self.assertEqual(len(commits), 1)
                self.assertEqual(commits[0].split()[3], expected)
                self.assertEqual(action["key"], supplied)
        self.session.close()

    def test_cached_pointer_is_refreshed_after_another_window_had_the_visible_marker(self):
        claimed = self.session.claim({"workspace": 8})
        target = self.session._target(claimed["appId"], claimed["selectedWindowId"])
        address = f"0x100@ab@lease-{claimed['appId']}"
        self.transport.requests.clear()
        self.session._ensure_pointer(target, address)
        self.assertEqual(self.transport.requests, [f"ghost-cursor {address} 160 90"])
        target["pointer"] = {"x": 1000, "y": 1000}
        self.session._ensure_pointer(target, address)
        self.assertEqual(target["pointer"], {"x": 160, "y": 90})
        self.assertFalse(any(request.startswith(("ghost-move ", "ghost-click ", "ghost-key ", "ghost-texthex "))
                             for request in self.transport.requests))
        self.session.close()

    def test_close_window_requests_only_the_exact_leased_target(self):
        claimed = self.session.claim({"workspace": 8})
        target = claimed["windows"][0]
        with patch.object(self.transport, "_perform", return_value="ok") as perform:
            result = self.session.execute({"type": "close-window", "appId": claimed["appId"], "windowId": target["windowId"]})
        perform.assert_called_once_with(f"ghost-window-close 0x100@ab@lease-{claimed['appId']}")
        self.assertEqual(result, {"closeRequested": True})
        self.assertFalse(self.session.closed)
        self.session.close()

    def test_lost_claim_reply_still_hands_back_the_prejournaled_identity(self):
        self.transport.lose_claim = True
        with self.assertRaises(TimeoutError):
            self.session.claim({"workspace": 8})
        self.assertTrue(self.transport.active)
        pending = json.loads((self.session.directory / "handoff.json").read_text())
        self.assertEqual(pending["lease_id"], self.transport.lease_id)
        self.session.close()
        self.assertFalse(self.transport.active)
        self.assertFalse((self.session.directory / "handoff.json").exists())

    def test_capture_retries_a_geometry_race_without_replaying_input(self):
        self.session.plan.update(runtime=str(self.session.directory), display="wayland-fixture")
        claimed = self.session.claim({"workspace": 8})
        target = claimed["windows"][0]
        original = self.transport._exchange
        dimensions = [320, 180]
        def exchange(command):
            raw = original(command)
            if command == "j/clients":
                windows = json.loads(raw)
                for window in windows: window["size"] = list(dimensions)
                return json.dumps(windows)
            return raw
        self.transport._exchange = exchange
        captures = 0
        def capture(*args):
            nonlocal captures
            captures += 1
            before = tuple(dimensions)
            dimensions[:] = [321, 181]
            return b"fixture PNG", *before
        with patch("src.native.session.verify_host"), patch("src.native.session.bounded_capture", side_effect=capture):
            frame = self.session.execute({"type": "observe", "appId": claimed["appId"], "windowId": target["windowId"]})
        self.assertEqual((frame["surfaceWidth"], frame["surfaceHeight"]), (321, 181))
        self.assertEqual(captures, 2)
        self.assertFalse(any(request.startswith(("ghost-key ", "ghost-texthex ", "ghost-click ")) for request in self.transport.requests))
        self.session.close()

    def test_lease_loss_is_not_reported_as_window_disappearance(self):
        claimed = self.session.claim({"workspace": 8})
        self.transport.active = False
        with self.assertRaisesRegex(SessionError, "control ended"):
            self.session.execute({"type": "windows", "appId": claimed["appId"]})
        self.session.close()

    def test_pause_and_resume_report_ended_control_before_sending_mutation(self):
        self.session.claim({"workspace": 8})
        self.transport.active = False
        self.transport.requests.clear()
        for paused in (True, False):
            with self.subTest(paused=paused), self.assertRaises(ApplicationControlEnded):
                self.session.set_paused(paused)
        self.assertFalse(any(request.startswith("ghost-application-control ")
                             for request in self.transport.requests))
        self.session.close()

    def test_pause_and_resume_report_lease_loss_racing_the_control_command(self):
        self.session.claim({"workspace": 8})
        exchange = self.transport._exchange
        def lose_on_control(request, deadline=None):
            if request.startswith("ghost-application-control ") and request.split()[2] in ("pause", "resume"):
                self.transport.active = False
                return "refused: application lease unavailable"
            return exchange(request, deadline)
        self.transport._exchange = lose_on_control
        for paused in (True, False):
            self.transport.active = True
            with self.subTest(paused=paused), self.assertRaises(ApplicationControlEnded):
                self.session.set_paused(paused)
        self.assertEqual(self.control.inspect()["unresolved"], [])
        self.session.close()

    def test_foreign_target_is_rejected_before_input(self):
        claimed = self.session.claim({"workspace": 8})
        self.transport.foreign_target = True
        target = claimed["windows"][0]
        with self.assertRaises(SessionError):
            self.session.execute({"type": "text", "appId": claimed["appId"],
                                  "windowId": target["windowId"], "text": "wrong"})
        self.assertFalse(any(request.startswith("ghost-texthex") for request in self.transport.requests))
        self.session.close()

    def test_closed_application_session_cannot_launch_a_replacement(self):
        self.session.close()
        with self.assertRaises(SessionError):
            self.session.launch(["example"])
        self.assertEqual(self.transport.requests, [])

    def approved_retry(self, replace_target=False):
        self.control.configure(mode="protected")
        with self.assertRaises(ControlError):
            self.session.claim({"workspace": 8})
        denied = [json.loads(line) for line in (Path(self.tmp.name) / "control" / "actions.jsonl").read_text().splitlines()
                  if json.loads(line).get("phase") == "denied"][-1]
        first_id = self.session.lease_id
        self.session.close()
        self.control.configure(approve=denied["request"])
        if replace_target:
            self.transport.address = "0x200"
        retry = Path(self.tmp.name) / "retry"
        retry.mkdir(mode=0o700)
        with patch("src.native.existing.NativeTransport", return_value=self.transport):
            self.session = ExistingApplicationSession({}, retry, self.control)
        if replace_target:
            with self.assertRaises(ControlError):
                self.session.claim({"workspace": 8})
            self.assertFalse(self.transport.active)
        else:
            claimed = self.session.claim({"workspace": 8})
            self.assertNotEqual(claimed["appId"], first_id)
            self.assertTrue(self.transport.active)
        self.session.close()

    def test_approved_handoff_retries_with_new_recovery_identity(self):
        self.approved_retry()

    def test_workspace_approval_does_not_authorize_a_replacement_window(self):
        self.approved_retry(replace_target=True)


if __name__ == "__main__":
    if "--unfixed-close" in sys.argv:
        sys.argv.remove("--unfixed-close")
        def unfixed_close(self):
            errors = []
            for app in self.apps.values():
                try:
                    app.close()
                except BaseException as error:
                    errors.append(error)
            if errors:
                raise BaseExceptionGroup("Native session cleanup failed", errors)
        ExistingApplicationSession.close = unfixed_close
    unittest.main()
