"""Verify the owner handoff release binds the evidenced build, without a transport or plugin."""
import json
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import handoff_release, plugin_owner
from src.native.existing import ExistingApplicationSession

RECORD = handoff_release.released()
SOURCE, ABI = RECORD["plugin"]["source_sha256"], RECORD["hyprland"]["abi_hash"]


class Transport:
    def __init__(self, build):
        self.build = build

    def _exchange(self, command):
        if command != "ghost-build-info":
            raise AssertionError("claim reached the compositor before the build was bound: " + command)
        return json.dumps(self.build)


class ReleaseTests(unittest.TestCase):
    def test_missing_evidence_holds_every_owner_path(self):
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / "missing.json"
            with self.assertRaisesRegex(RuntimeError, "disabled after a compositor crash"):
                handoff_release.require_owner_handoff(evidence=missing)
            with patch.object(handoff_release, "EVIDENCE", missing), \
                 patch("src.native.existing.require_owner_handoff",
                       lambda *a: handoff_release.require_owner_handoff(*a, evidence=missing)):
                session = ExistingApplicationSession.__new__(ExistingApplicationSession)
                for method in (session.claim, session.execute):
                    with self.assertRaisesRegex(RuntimeError, "disabled after a compositor crash"):
                        method({})

    def test_claim_refuses_another_plugin_source_or_compositor_build(self):
        for build in ({"source_sha256": "f" * 64, "abi_hash": ABI}, {"source_sha256": SOURCE, "abi_hash": "other"},
                      {"source_sha256": SOURCE}, {}):
            with self.subTest(build=build):
                session = ExistingApplicationSession.__new__(ExistingApplicationSession)
                session.transport = Transport(build)
                with patch("src.native.existing.require_budget"):
                    with self.assertRaises((RuntimeError, Exception)) as raised:
                        session.claim({})
                self.assertRegex(str(raised.exception), "no release evidence|Invalid compositor plugin build")

    def test_plugin_load_refuses_an_unevidenced_source(self):
        bundle = type("Bundle", (), {"artifact": {"source_sha256": "f" * 64}, "plan": {"abi_hash": ABI}})()
        with patch.object(plugin_owner, "PreparedPlugin", return_value=bundle), \
             patch.object(plugin_owner, "require_budget"):
            for operation in ("load", "resume"):
                with self.assertRaisesRegex(RuntimeError, "this plugin source has no release evidence"):
                    plugin_owner.operate(operation, "/unused")

    def test_evidence_matches_the_committed_plugin_source(self):
        import hashlib
        source = Path(__file__).resolve().parents[1] / RECORD["plugin"]["source"]
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), SOURCE)


if __name__ == "__main__":
    unittest.main()
