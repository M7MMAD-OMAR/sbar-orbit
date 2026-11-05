"""Exact-generation forwarding and native minimum evidence, without desktop access."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.opening_evidence import ConstraintSampleChanged, existing_processes, forwarding_proven, native_constraints, minimum_outcome
from src.native.window_placement import PlacementUnavailable, place_new_window


WINDOW = {"address": "0xabc", "stableId": "123", "pid": 303, "size": [480, 360]}
ROOT = [101, 202]
ACTIVATED = {("0xabc", "123")}


class ForwardingTests(unittest.TestCase):
    def test_requires_prelaunch_generation_request_surface_and_original_launcher_exit(self):
        current = {101: None, 303: (303, 404)}
        with patch("src.native.opening_evidence.process_identity", side_effect=lambda pid: current[pid]):
            self.assertTrue(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, ACTIVATED))
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {}, ACTIVATED))
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, set()))
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {303: (303, 405)}, ACTIVATED))
            current[101] = (101, 202)
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, ACTIVATED))

    def test_root_pid_reuse_does_not_alias_original_generation(self):
        with patch("src.native.opening_evidence.process_identity", side_effect=lambda pid: (pid, 999) if pid == 101 else (303, 404)):
            self.assertTrue(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, ACTIVATED))

    def test_target_generation_churn_and_unreadable_identity_refuse(self):
        with patch("src.native.opening_evidence.process_identity", side_effect=[(303, 404), None, (303, 405)]):
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, ACTIVATED))
        with patch("src.native.opening_evidence.process_identity", side_effect=PermissionError):
            self.assertFalse(forwarding_proven(WINDOW, ROOT, {303: (303, 404)}, ACTIVATED))

    def test_snapshot_retains_only_prelaunch_live_process_generations(self):
        with patch("src.native.opening_evidence.process_identity", side_effect=lambda pid: (pid, 404) if pid == 303 else None):
            self.assertEqual(existing_processes([WINDOW, {"pid": 404}, {"pid": True}]), {303: (303, 404)})


class MinimumTests(unittest.TestCase):
    def response(self, **changes):
        return {"schema": 1, "address": "0xabc", "stableId": "123", "pid": 303, "size": [480, 360],
                "minimum": [480, 360], "source": "xdg-toplevel-current", **changes}

    def read(self, value):
        transport = SimpleNamespace(_exchange=lambda command: json.dumps(value))
        return native_constraints(transport, WINDOW)

    def test_exact_atomic_window_sample_proves_minimum_clamp(self):
        constraints = self.read(self.response())
        outcome = minimum_outcome({"width": 480, "height": 360}, {"width": 320, "height": 240}, constraints)
        self.assertIs(outcome["minimumSizeEnforced"], True)
        self.assertEqual(outcome["differenceCause"], "native-minimum-size")
        self.assertEqual(outcome["nativeMinimum"], {"width": 480, "height": 360})

    def test_size_difference_does_not_establish_cause(self):
        constraints = self.read(self.response())
        for actual in ({"width": 600, "height": 360}, {"width": 480, "height": 240}):
            result = minimum_outcome(actual, {"width": 320, "height": 240}, constraints)
            self.assertEqual(result["minimumSizeEnforced"], "unknown")
            self.assertEqual(result["differenceCause"], "unknown")

    def test_no_constraint_pressure_is_explicit_false(self):
        result = minimum_outcome({"width": 600, "height": 400}, {"width": 600, "height": 400}, self.read(self.response()))
        self.assertIs(result["minimumSizeEnforced"], False)

    def test_changed_identity_geometry_unknown_provider_or_bad_fields_do_not_attest(self):
        for changes in ({"pid": 404}, {"pid": True}, {"pid": 303.0}, {"stableId": "456"}, {"address": "0xdef"},
                        {"minimum": [-1, 1]}, {"minimum": [True, 1]},
                        {"source": "guessed"}, {"schema": True}, {"extra": "private"}):
            with self.subTest(changes=changes):
                self.assertIsNone(self.read(self.response(**changes)))

    def test_same_target_resizing_requires_a_new_sample_not_mixed_metadata(self):
        with self.assertRaises(ConstraintSampleChanged):
            self.read(self.response(size=[481, 360]))

    def test_missing_or_old_plugin_returns_unknown_without_changing_opening(self):
        transport = SimpleNamespace(_exchange=lambda command: "unknown request")
        self.assertIsNone(native_constraints(transport, WINDOW))
        self.assertEqual(minimum_outcome({"width": 480, "height": 360}, {"width": 320, "height": 240}, None),
                         {"minimumSizeEnforced": "unknown", "differenceCause": "unknown"})

    def test_only_exact_pre_mutation_lua_refusal_is_classified_unavailable(self):
        calls = []
        transport = SimpleNamespace(_exchange=lambda command: calls.append(command) or "eval is only supported with the lua config manager")
        with self.assertRaises(PlacementUnavailable):
            place_new_window(transport, WINDOW, 4, {"width": 640, "height": 480})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("eval local w="))


if __name__ == "__main__":
    unittest.main()
