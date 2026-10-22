"""Presentation protocol fixtures never move a real workspace or physical pointer."""
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.control import ActionControl, ControlError
from src.native.existing import ExistingApplicationSession
from src.native.host import HostError
from src.native.plugin_compatibility import NativeCompatibilityError
from src.native.session import SessionError
from src.native.session_worker import main


class PresentationTransport:
    def __init__(self):
        self.requests = []
        self.response = "ok"

    def _exchange(self, request):
        self.requests.append(request)
        if request == "ghost-build-info":
            return json.dumps({"source_sha256": "a" * 64, "abi_hash": "fixture"})
        if request == "j/monitors":
            return json.dumps([{"name": "eDP-1", "focused": True, "activeWorkspace": {"id": 1},
                "unrelatedTitle": "Owner document"},
                {"name": "HDMI-A-5", "focused": False, "activeWorkspace": {"id": 4}}])
        if request.startswith("ghost-workspace-present "):
            if isinstance(self.response, BaseException):
                raise self.response
            return self.response
        raise AssertionError("Unexpected compositor operation " + request)


class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.control = ActionControl(self.root / "control")
        self.addCleanup(self.control.close)
        self.control.configure(mode="full")
        self.transport = PresentationTransport()
        self.gate = patch("src.native.existing.require_native_plugin")
        self.match = self.gate.start()
        self.addCleanup(self.gate.stop)
        (self.root / "session").mkdir(mode=0o700)
        with patch("src.native.existing.NativeTransport", return_value=self.transport):
            self.session = ExistingApplicationSession({"abi_hash": "fixture"}, self.root / "session", self.control)

    def test_monitor_metadata_needs_no_plugin_and_excludes_owner_titles(self):
        self.match.side_effect = AssertionError("Monitor reading must not require a plugin")
        self.assertEqual(self.session.monitors({}), {"monitors": [
            {"name": "eDP-1", "focused": True, "workspace": 1},
            {"name": "HDMI-A-5", "focused": False, "workspace": 4}],
            "sampled": "compositor-monitor-metadata"})
        self.assertEqual(self.transport.requests, ["j/monitors"])
        self.match.assert_not_called()

    def test_presentation_checks_build_then_sends_one_explicit_native_command(self):
        self.assertEqual(self.session.present({"workspace": 2, "monitor": "HDMI-A-5"}), {
            "workspace": 2, "monitor": "HDMI-A-5", "visible": True,
            "ownerFocusPreserved": "during-presentation", "sampled": "compositor-acknowledgement"})
        self.assertEqual(self.transport.requests, ["ghost-build-info", "ghost-workspace-present 2 HDMI-A-5"])
        self.match.assert_called_once_with("a" * 64, "fixture", expected_abi="fixture")

    def test_invalid_target_is_rejected_before_compositor_or_admission_mutation(self):
        for value in [{"workspace": 0, "monitor": "HDMI-A-5"}, {"workspace": True, "monitor": "HDMI-A-5"},
                      {"workspace": 2, "monitor": "HDMI-A-5;focus"}, {"workspace": 2},
                      {"workspace": 2, "monitor": "HDMI-A-5", "focus": True},
                      {"workspace": 2, "monitor": "x" * 129}]:
            with self.subTest(value=value), self.assertRaises(SessionError):
                self.session.present(value)
        self.assertEqual(self.transport.requests, [])

    def test_protected_refusal_changes_no_style_focus_or_presentation(self):
        self.control.configure(mode="protected")
        with self.assertRaises(ControlError):
            self.session.present({"workspace": 2, "monitor": "HDMI-A-5"})
        self.assertEqual(self.transport.requests, [])

    def test_source_or_abi_mismatch_prevents_presentation(self):
        self.match.side_effect = NativeCompatibilityError("fixture mismatch")
        with self.assertRaises(NativeCompatibilityError):
            self.session.present({"workspace": 2, "monitor": "HDMI-A-5"})
        self.assertEqual(self.transport.requests, ["ghost-build-info"])

    def test_only_typed_pre_mutation_refusal_is_retryable_readiness(self):
        self.transport.response = "not-ready: focused monitor"
        with self.assertRaises(SessionError) as raised:
            self.session.present({"workspace": 2, "monitor": "HDMI-A-5"})
        self.assertEqual(type(raised.exception).__name__, "PresentationNotReady")
        readiness = raised.exception
        class Session:
            def __init__(self, *_): self.closed, self.plan = False, {}
            def present(self, _): raise readiness
            def close(self): self.closed = True
        request = {"requestId": "d" * 32, "method": "present",
                   "params": {"workspace": 2, "monitor": "HDMI-A-5"}}
        output = io.StringIO()
        stream = SimpleNamespace(buffer=io.BytesIO((json.dumps(request) + "\n").encode()))
        (self.root / "readiness-worker").mkdir(mode=0o700)
        (self.root / "readiness-control").mkdir(mode=0o700)
        with patch("src.native.session_worker.read_plan", return_value={}), \
                patch("src.native.session_worker.sys.stdin", stream), \
                patch("src.native.session_worker.sys.stdout", output), \
                patch("src.native.session_worker.sys.stderr", io.StringIO()):
            main(self.root / "readiness-worker", self.root / "readiness-control",
                 self.root / "unused-plan", session_type=Session)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "PRESENTATION_NOT_READY")
        self.assertEqual(self.transport.requests, ["ghost-build-info", "ghost-workspace-present 2 HDMI-A-5"])

    def test_unconfirmed_delivery_is_never_retried_or_replaced_by_focus_dispatch(self):
        for response in ["refused: owner focus changed during presentation", TimeoutError("lost acknowledgement")]:
            self.transport.requests.clear()
            self.transport.response = response
            with self.subTest(response=str(response)), self.assertRaises((HostError, TimeoutError)):
                self.session.present({"workspace": 2, "monitor": "HDMI-A-5"})
            self.assertEqual(self.transport.requests, ["ghost-build-info", "ghost-workspace-present 2 HDMI-A-5"])

    def test_framed_worker_routes_monitor_and_present_and_caches_delivery(self):
        calls = []
        class Session:
            def __init__(self, *_): self.closed, self.plan = False, {}
            def monitors(self, value):
                calls.append(("monitors", value))
                return {"monitors": []}
            def present(self, value):
                calls.append(("present", value))
                return {"workspace": value["workspace"], "monitor": value["monitor"]}
            def close(self): self.closed = True
        target = {"workspace": 2, "monitor": "HDMI-A-5"}
        request = {"requestId": "a" * 32, "method": "present", "params": target}
        requests = [{"requestId": "b" * 32, "method": "monitors", "params": {}}, request, request,
                    {**request, "params": {**target, "workspace": 3}}]
        output = io.StringIO()
        stream = SimpleNamespace(buffer=io.BytesIO(b"".join((json.dumps(value) + "\n").encode() for value in requests)))
        (self.root / "worker").mkdir(mode=0o700)
        (self.root / "worker-control").mkdir(mode=0o700)
        with patch("src.native.session_worker.read_plan", return_value={}), \
                patch("src.native.session_worker.sys.stdin", stream), patch("src.native.session_worker.sys.stdout", output):
            main(self.root / "worker", self.root / "worker-control", self.root / "unused-plan", session_type=Session)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(calls, [("monitors", {}), ("present", target)])
        self.assertEqual(responses[1], responses[2])
        self.assertEqual(responses[3]["error"]["code"], "REQUEST_CONFLICT")


if __name__ == "__main__":
    unittest.main()
