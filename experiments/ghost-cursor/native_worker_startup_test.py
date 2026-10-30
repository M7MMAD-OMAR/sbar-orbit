#!/usr/bin/python3
"""A worker that cannot start answers with the classified reason instead of dying with a traceback."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.native import session_worker
from src.native.control import ActionControl
from src.native.host import HostError, TargetClosed
from src.native.plugin_compatibility import NativeCompatibilityError


class Stdin:
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


class StartupTests(unittest.TestCase):
    def run_worker(self, error, requests):
        temp = tempfile.TemporaryDirectory(prefix="orbit-startup-")
        self.addCleanup(temp.cleanup)
        directory, control = Path(temp.name) / "worker", Path(temp.name) / "control"
        directory.mkdir(mode=0o700)
        control.mkdir(mode=0o700)
        plan = Path(temp.name) / "host.json"
        plan.write_text("{}")

        class Failing:
            def __init__(self, *_):
                raise error

        data = b"".join(json.dumps({"requestId": "%032x" % index, "method": method, "params": {}}).encode() + b"\n" for index, method in enumerate(requests, 1))
        out, err = io.StringIO(), io.StringIO()
        with patch.object(session_worker, "require_budget"), patch.object(sys, "stdin", Stdin(data)), patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            session_worker.main(directory, control, plan, session_type=Failing)
        return [json.loads(line) for line in out.getvalue().splitlines()], err.getvalue()

    def test_stale_compositor_is_a_framed_reply_with_its_repair_command(self):
        replies, journal = self.run_worker(HostError("Compositor endpoint is gone, so the compositor was restarted since this plan was prepared; run sbar-orbit native-refresh"), ["status", "candidates"])
        self.assertEqual(len(replies), 2)
        for reply in replies:
            self.assertFalse(reply["ok"])
            self.assertEqual(reply["error"]["code"], "NATIVE_STALE")
            self.assertIn("native-refresh", reply["error"]["message"])
        self.assertIn("Traceback", journal)
        fatal = [line for line in journal.splitlines() if line.startswith(session_worker.FATAL_PREFIX)]
        self.assertEqual(json.loads(fatal[-1][len(session_worker.FATAL_PREFIX):])["type"], "HostError")

    def test_incompatible_plugin_keeps_its_own_code(self):
        replies, _ = self.run_worker(NativeCompatibilityError("Loaded native plugin build does not match the prepared compositor ABI"), ["status"])
        self.assertEqual(replies[0]["error"]["code"], "NATIVE_INCOMPATIBLE")

    def test_unknown_startup_error_does_not_leak_its_text(self):
        replies, _ = self.run_worker(RuntimeError("secret token value"), ["status"])
        self.assertEqual(replies[0]["error"]["code"], "NATIVE_FAILED")
        self.assertNotIn("secret", replies[0]["error"]["message"])

    def test_target_closed_keeps_its_own_code(self):
        response = session_worker.failure_response(TargetClosed("no such window"), object)
        self.assertEqual(response["error"]["code"], "TARGET_CLOSED")
        self.assertNotIn("no such window", response["error"]["message"])


if __name__ == "__main__":
    unittest.main()
