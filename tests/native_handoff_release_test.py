"""Verify release holds without constructing a transport or loading a plugin."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.existing import ExistingApplicationSession
from src.native import plugin_owner


class ReleaseHoldTests(unittest.TestCase):
    def test_claim_and_input_refuse_without_initialization(self):
        session = ExistingApplicationSession.__new__(ExistingApplicationSession)
        for method in (session.claim, session.execute):
            with self.assertRaisesRegex(RuntimeError, "disabled after a compositor crash"):
                method({})

    def test_existing_lease_resume_refuses_before_transport(self):
        session = ExistingApplicationSession.__new__(ExistingApplicationSession)
        with self.assertRaisesRegex(RuntimeError, "disabled after a compositor crash"):
            session.set_paused(False)

    def test_direct_plugin_mutation_refuses_before_bundle_or_budget(self):
        with patch.object(plugin_owner, "PreparedPlugin") as bundle, patch.object(plugin_owner, "require_budget") as budget:
            for operation in ("load", "resume"):
                with self.assertRaisesRegex(RuntimeError, "disabled after a compositor crash"):
                    plugin_owner.operate(operation, "/unused")
            bundle.assert_not_called()
            budget.assert_not_called()


if __name__ == "__main__":
    unittest.main()
