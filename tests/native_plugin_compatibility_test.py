"""Current source/ABI compatibility, independent of historical acceptance records."""
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.plugin_compatibility import PLUGIN_SOURCE, require_native_plugin
from src.native.existing import ExistingApplicationSession


class CompatibilityTests(unittest.TestCase):
    def test_current_source_and_prepared_abi_are_accepted(self):
        source = hashlib.sha256(PLUGIN_SOURCE.read_bytes()).hexdigest()
        self.assertEqual(require_native_plugin(source, "current-abi", expected_abi="current-abi"),
                         {"source_sha256": source, "abi_hash": "current-abi"})

    def test_source_and_abi_mismatches_are_actionable(self):
        source = hashlib.sha256(PLUGIN_SOURCE.read_bytes()).hexdigest()
        for actual, abi, expected in [("f" * 64, "a", "a"), (source, "a", "b"),
                                      (source, "", ""), ("invalid", "a", "a")]:
            with self.subTest(actual=actual, abi=abi), self.assertRaisesRegex(RuntimeError, "source differs|ABI"):
                require_native_plugin(actual, abi, expected_abi=expected)

    def test_invalid_loaded_build_is_rejected_before_a_claim_command(self):
        session = ExistingApplicationSession.__new__(ExistingApplicationSession)
        session.plan = {"abi_hash": "expected-abi"}
        calls = []
        def exchange(command):
            calls.append(command)
            if command != "ghost-build-info":
                raise AssertionError("claim reached the compositor before compatibility verification")
            return json.dumps({"source_sha256": "f" * 64, "abi_hash": "expected-abi"})
        session.transport = SimpleNamespace(_exchange=exchange)
        with patch("src.native.existing.require_budget"), self.assertRaisesRegex(RuntimeError, "source differs"):
            session.claim({})
        self.assertEqual(calls, ["ghost-build-info"])


if __name__ == "__main__":
    unittest.main()
