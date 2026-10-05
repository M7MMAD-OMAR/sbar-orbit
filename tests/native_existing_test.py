"""Borrowed application lifecycle controls with a compositor protocol fixture."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.control import ActionControl, ControlError
from src.native.existing import ExistingApplicationSession
from src.native.session import NativeSession, SessionError


class Compositor:
    def __init__(self):
        self.lease_id = None
        self.active = False
        self.requests = []
        self.lose_claim = False
        self.foreign_target = False
        self.text = "Already open unsaved content مرحبا"
        self.address = "0x100"

    def _exchange(self, request):
        self.requests.append(request)
        if request == "j/clients":
            return json.dumps([{"address": self.address, "stableId": "ab", "workspace": {"id": 8},
                                "size": [320, 180], "title": self.text, "xwayland": False}])
        if request.startswith("ghost-application-claim "):
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
        if request.startswith("ghost-target-check "):
            return "ok"
        if request.startswith("ghost-texthex "):
            self.text += bytes.fromhex(request.split()[2]).decode()
            return "ok 1 keys"
        raise AssertionError("Unexpected operation: " + request)


class ExistingApplicationTests(unittest.TestCase):
    def setUp(self):
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
        ExistingApplicationSession.close = NativeSession.close
    unittest.main()
