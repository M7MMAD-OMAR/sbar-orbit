"""Pure metadata and owned fake-launch fixtures, never an application or desktop session."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import owner_open

REQUESTED = {"width": 640, "height": 480}
ROOT = [101, 202]


def window(width=640, height=480, pid=303):
    return {"address": "0xabc", "stableId": "123", "pid": pid, "size": [width, height],
            "at": [(1920 - width) / 2, (1080 - height) / 2], "floating": True,
            "workspace": {"id": 4}, "title": "Owned fixture", "xwayland": False}


class OutcomeTests(unittest.TestCase):
    def outcome(self, value=None, **kwargs):
        return owner_open.opening_outcome(window() if value is None else value, REQUESTED,
                                          sampled_at_ms=123456, **kwargs)

    def test_same_process_requires_ancestry_proof_and_valid_receipt(self):
        result = self.outcome(window(pid=101), launcher_root=ROOT, ancestry_proven=True)
        self.assertEqual(result["process"], {"launchProcessPid": 101,
            "launchProcessKind": "registration-launch-scope-helper", "windowPid": 101,
            "relation": "same", "evidence": "live-launch-ancestry-at-attribution", "forwarded": "unknown"})

    def test_descendant_relation_is_scoped_to_the_receipt_root(self):
        process = self.outcome(launcher_root=ROOT, ancestry_proven=True)["process"]
        self.assertEqual(process["relation"], "descendant")
        self.assertEqual(process["windowPid"], 303)
        self.assertEqual(process["forwarded"], "unknown")

    def test_matching_pid_without_live_ancestry_evidence_is_unknown(self):
        self.assertEqual(self.outcome(window(pid=101), launcher_root=ROOT)["process"]["relation"], "unknown")

    def test_invalid_or_missing_process_evidence_never_invents_a_relation(self):
        for root in (None, [], [101], [101, 0], [True, 202], ["101", 202]):
            with self.subTest(root=root):
                process = self.outcome(launcher_root=root, ancestry_proven=True)["process"]
                self.assertEqual(process["relation"], "unknown")
                self.assertIsNone(process["launchProcessPid"])
        for pid in (None, True, 0, -1, "303"):
            with self.subTest(pid=pid):
                process = self.outcome(window(pid=pid), launcher_root=ROOT, ancestry_proven=True)["process"]
                self.assertEqual(process["relation"], "unknown")
                self.assertIsNone(process["windowPid"])

    def test_sampled_match_is_not_a_settling_or_future_size_claim(self):
        geometry = self.outcome()["geometry"]
        self.assertEqual(geometry["requested"], REQUESTED)
        self.assertEqual(geometry["actual"], REQUESTED)
        self.assertEqual(geometry["difference"], {"width": 0, "height": 0})
        self.assertEqual(geometry["comparison"], "matched")
        self.assertEqual(geometry["sampledAtMs"], 123456)
        self.assertEqual(geometry["clock"], "local-wall-at-compositor-reply")
        self.assertEqual(geometry["stability"], "not-established")
        for field in ("minimumSizeEnforced", "differenceCause", "futureGeometry"):
            self.assertEqual(geometry[field], "unknown")

    def test_tolerance_is_explicit_and_differences_are_not_erased(self):
        matched = self.outcome(window(642, 478))["geometry"]
        self.assertEqual(matched["comparison"], "matched")
        self.assertEqual(matched["difference"], {"width": 2, "height": -2})
        self.assertEqual(matched["tolerancePx"], 2)
        self.assertEqual(self.outcome(window(643, 480))["geometry"]["comparison"], "mismatched")

    def test_later_geometry_samples_do_not_rewrite_earlier_evidence(self):
        # Arithmetic fixtures modeled on possible redraws, not new live measurements.
        samples = [self.outcome(window(640, height))["geometry"] for height in (480, 616, 637)]
        self.assertEqual([sample["actual"]["height"] for sample in samples], [480, 616, 637])
        self.assertEqual([sample["comparison"] for sample in samples], ["matched", "mismatched", "mismatched"])
        self.assertTrue(all(sample["minimumSizeEnforced"] == "unknown" and sample["stability"] == "not-established" for sample in samples))

    def test_initial_fitted_rule_request_is_distinct_from_user_request(self):
        outcome = owner_open.opening_outcome(window(640, 480), {"width": 1200, "height": 900},
                                             placement_request={"width": 640, "height": 480, "left": 0})
        geometry = outcome["geometry"]
        self.assertEqual(geometry["placementRequest"], REQUESTED)
        self.assertEqual(geometry["comparison"], "mismatched")
        self.assertEqual(geometry["differenceCause"], "unknown")

    def test_invalid_geometry_is_unknown_not_a_coerced_match(self):
        for size in (None, [], [640], [640, 480, 1], [0, 480], [-1, 480], [True, 480],
                     ["640", 480], [float("nan"), 480], [640, float("inf")], [10 ** 1000, 480]):
            with self.subTest(size=str(size)[:30]):
                value = window(); value["size"] = size
                geometry = self.outcome(value)["geometry"]
                self.assertIsNone(geometry["actual"])
                self.assertIsNone(geometry["difference"])
                self.assertEqual(geometry["comparison"], "unknown")

    def test_missing_or_invalid_requested_size_and_timestamp_are_not_invented(self):
        result = owner_open.opening_outcome(window(), {"width": "640", "height": 480}, sampled_at_ms=True)
        self.assertIsNone(result["geometry"]["requested"])
        self.assertEqual(result["geometry"]["comparison"], "unknown")
        self.assertIsNone(result["geometry"]["sampledAtMs"])

    def test_outcome_does_not_copy_content_or_mutate_source_records(self):
        value = window(); value.update(secret="private-content", title="private-content")
        requested = dict(REQUESTED)
        before = copy.deepcopy((value, requested))
        result = owner_open.opening_outcome(value, requested)
        self.assertNotIn("private-content", json.dumps(result))
        result["geometry"]["actual"]["width"] = 1
        result["geometry"]["requested"]["height"] = 1
        self.assertEqual((value, requested), before)

    def test_candidate_metadata_does_not_promote_attribution_or_placement(self):
        result = owner_open.candidate_result(window(), {"workspace": 4, "window": REQUESTED},
                                             "activation-token", existing=True, launcher_root=ROOT, sampled_at_ms=123456)
        self.assertFalse(result["opened"])
        self.assertFalse(result["placementChanged"])
        self.assertTrue(result["reusedExisting"])
        self.assertEqual(result["attribution"], "candidate-only")
        self.assertEqual(result["openingOutcome"]["process"]["relation"], "unknown")
        self.assertEqual(result["openingOutcome"]["process"]["forwarded"], "unknown")
        self.assertEqual(result["openingOutcome"]["geometry"]["comparison"], "matched")


class FakeOpening:
    """All compositor replies and launch receipts are owned in-memory/file fixtures."""
    def __init__(self, directory, proof="launch-ancestry", pid=303, existing=False, owner_input=False):
        self.directory = Path(directory)
        self.proof, self.pid, self.existing, self.owner_input = proof, pid, existing, owner_input
        self.launched = False
        self.commands, self.placements = [], []
        self.clock = 0
        self.session = SimpleNamespace(directory=self.directory,
            control=SimpleNamespace(execute=lambda request, operation: operation()),
            transport=SimpleNamespace(_exchange=self.exchange))

    def monotonic(self):
        self.clock += 0.6
        return self.clock

    @contextmanager
    def identity(self, transport, token):
        yield SimpleNamespace(windows=lambda: {("0xabc", "123")} if self.launched and self.proof == "activation-token" else set())

    def exchange(self, command):
        self.commands.append(command)
        if len(self.commands) > 100:
            raise AssertionError("Owned fixture query budget exceeded")
        if command == "j/workspaces": return json.dumps([{"id": 4, "monitor": "fixture"}])
        if command == "j/monitors": return json.dumps([{"name": "fixture", "x": 0, "y": 0, "width": 1920,
            "height": 1080, "scale": 1, "focused": True, "activeWorkspace": {"id": 4}, "reserved": [0, 0, 0, 0]}])
        if command == "j/clients": return json.dumps([window(pid=self.pid)] if self.launched or self.existing else [])
        if command == "j/activewindow": return json.dumps(window(pid=self.pid) if self.launched and self.owner_input else {})
        if command == "j/cursorpos": return json.dumps({"x": 300 if self.launched and self.owner_input else 100, "y": 100})
        if command.startswith("eval hl.exec_cmd("):
            spec = json.loads(next(self.directory.glob("open-*.json")).read_text())
            Path(spec["receipt"]).write_text(json.dumps(ROOT))
            self.launched = True
            return "ok"
        raise AssertionError("Unexpected owned fixture operation")

    def run(self):
        registered = SimpleNamespace(process=(700, 800), verify=lambda: True) if self.proof == "registered-dbus-client" else None
        with patch.object(owner_open, "require_budget"), patch.object(owner_open.shutil, "which", return_value="/owned/registered-app"), \
                patch.object(owner_open, "opening_identity", self.identity), patch.object(owner_open, "registered_client", return_value=registered), \
                patch.object(owner_open, "belongs_to", side_effect=lambda pid, root: self.proof == "launch-ancestry" or self.proof == "registered-dbus-client" and tuple(root) == (700, 800)), \
                patch.object(owner_open.OriginalLaunchScope, "contains", return_value=self.proof == "launch-scope"), \
                patch.object(owner_open, "place_new_window", side_effect=lambda *args, **kwargs: self.placements.append((args, kwargs))), \
                patch.object(owner_open.time, "monotonic", self.monotonic), patch.object(owner_open.time, "sleep"), \
                patch.object(owner_open.time, "time_ns", return_value=123456000000):
            return owner_open.open_application(self.session, {"workspace": 4, "argv": ["/owned/registered-app"],
                "window": REQUESTED, **({"busName": "org.example.Owned"} if registered else {})})


class OpeningIntegrationTests(unittest.TestCase):
    def run_fixture(self, **kwargs):
        with tempfile.TemporaryDirectory(prefix="orbit-opening-outcome-fixture-") as directory:
            fixture = FakeOpening(directory, **kwargs)
            result = fixture.run()
            self.assertEqual(sum(command.startswith("eval hl.exec_cmd(") for command in fixture.commands), 1)
            self.assertEqual(result["openingOutcome"]["geometry"]["sampledAtMs"], 123456)
            self.assertNotIn("hl.dsp.focus", " ".join(fixture.commands))
            self.assertNotIn("cursor.move", " ".join(fixture.commands))
            return result, fixture

    def test_successful_ancestry_adds_same_or_descendant_without_changing_legacy_success(self):
        for pid, relation in ((101, "same"), (303, "descendant")):
            with self.subTest(pid=pid):
                result, fixture = self.run_fixture(pid=pid)
                self.assertTrue(result["opened"])
                self.assertEqual(result["identityEvidence"], "launch-ancestry")
                self.assertEqual(result["window"]["height"], 480)
                self.assertEqual(result["openingOutcome"]["process"]["relation"], relation)
                self.assertEqual(fixture.placements, [])

    def test_token_and_scope_attribution_do_not_prove_forwarding_or_ancestry(self):
        for proof in ("activation-token", "launch-scope"):
            with self.subTest(proof=proof):
                result, fixture = self.run_fixture(proof=proof)
                self.assertTrue(result["opened"])
                self.assertEqual(result["identityEvidence"], proof)
                self.assertEqual(result["openingOutcome"]["process"]["relation"], "unknown")
                self.assertEqual(result["openingOutcome"]["process"]["forwarded"], "unknown")
                self.assertEqual(len(fixture.placements), 1)

    def test_existing_activation_target_remains_unmodified_candidate_only(self):
        result, fixture = self.run_fixture(proof="activation-token", existing=True)
        self.assertFalse(result["opened"])
        self.assertTrue(result["reusedExisting"])
        self.assertEqual(result["openingOutcome"]["process"]["relation"], "unknown")
        self.assertEqual(fixture.placements, [])

    def test_registered_process_candidate_does_not_prove_launch_forwarding(self):
        result, fixture = self.run_fixture(proof="registered-dbus-client")
        self.assertFalse(result["opened"])
        self.assertEqual(result["identityEvidence"], "registered-dbus-client")
        self.assertEqual(result["openingOutcome"]["process"]["forwarded"], "unknown")
        self.assertEqual(fixture.placements, [])

    def test_owner_input_candidate_preserves_preexisting_focus_and_placement_contract(self):
        result, fixture = self.run_fixture(owner_input=True)
        self.assertFalse(result["opened"])
        self.assertEqual(result["candidateReason"], "owner-input")
        self.assertFalse(result["placementChanged"])
        self.assertEqual(result["openingOutcome"]["process"]["relation"], "descendant")
        self.assertEqual(fixture.placements, [])


if __name__ == "__main__":
    unittest.main()
