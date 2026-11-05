"""Pixel calibration is exact-label evidence, never a guessed toolkit offset."""
import copy
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import a11y_pixels


HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"


def tsv(words):
    return (HEADER + "".join(f"5\t1\t1\t1\t{line}\t{i}\t{x}\t{y}\t{w}\t{h}\t{conf}\t{text}\n"
            for i, (text, x, y, w, h, line, conf) in enumerate(words, 1))).encode()


class PixelCalibrationTests(unittest.TestCase):
    def tree(self):
        return {"status": "ok", "toolkit": "GTK", "complete": True, "truncated": None,
                "nodes": [{"role": "frame", "name": "App", "box": [0, 0, 960, 640]},
                          {"role": "table cell", "name": "coordinate-target. Folder", "box": [194, 43, 112, 119]}]}

    def calibrate(self, tree, words):
        return a11y_pixels.calibrate_from_tsv(tree, tsv(words), (1440, 960), (960, 640))

    def test_multiline_exact_folder_label_becomes_a_pixel_verified_click_region(self):
        tree = self.tree()
        original = copy.deepcopy(tree)
        result = self.calibrate(tree, [("coordinate-", 337, 210, 130, 20, 1, 98), ("target", 360, 238, 80, 20, 2, 99)])
        self.assertEqual(result["nodes"][1]["box"], [224, 140, 88, 32])
        self.assertEqual(result["nodes"][1]["providerBox"], [194, 43, 112, 119])
        self.assertEqual(result["nodes"][1]["boxSource"], "capture-text")
        self.assertEqual(tree, original)

    def test_duplicate_label_anywhere_is_ambiguous_and_never_snapped(self):
        tree = self.tree()
        words = [("coordinate-target", 337, 210, 130, 20, 1, 98), ("coordinate-target", 600, 400, 130, 20, 2, 98)]
        self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])

    def test_prefix_or_suffix_of_longer_visible_label_is_not_exact_evidence(self):
        tree = self.tree()
        tree["nodes"][1].update(role="button", name="Target", box=[100, 100, 150, 20])
        for words in [[("Target", 150, 150, 70, 20, 1, 99), ("Backup", 225, 150, 70, 20, 1, 99)],
                      [("Backup", 150, 150, 70, 20, 1, 99), ("Target", 225, 150, 70, 20, 1, 99)]]:
            self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])

    def test_same_name_on_distinct_action_targets_is_not_guessed(self):
        tree = self.tree()
        tree["nodes"].append(copy.deepcopy(tree["nodes"][1]))
        words = [("coordinate-target", 337, 210, 130, 20, 1, 98)]
        self.assertFalse(any("providerBox" in node for node in self.calibrate(tree, words)["nodes"]))

    def test_low_confidence_words_never_disappear_to_join_an_invented_label(self):
        tree = self.tree()
        words = [("coordinate-", 337, 210, 130, 20, 1, 98), ("other", 360, 230, 80, 20, 2, 20),
                 ("target", 360, 250, 80, 20, 3, 99)]
        self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])
        words = [("coordinate-target", 337, 210, 130, 20, 1, 99), ("coordinate-target", 600, 400, 130, 20, 2, 20)]
        self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])

    def test_whitespace_is_not_erased_to_match_a_different_visible_name(self):
        tree = self.tree()
        tree["nodes"][1]["name"] = "Pixel Target. Folder"
        words = [("PixelTarget", 337, 210, 130, 20, 1, 99)]
        self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])

    def test_low_confidence_distant_partial_and_unrelated_labels_are_not_evidence(self):
        for word in [("coordinate-target", 337, 210, 130, 20, 1, 20),
                     ("coordinate-target", 1000, 800, 130, 20, 1, 99),
                     ("coordinate", 337, 210, 130, 20, 1, 99),
                     ("other-target", 337, 210, 130, 20, 1, 99)]:
            self.assertNotIn("providerBox", self.calibrate(self.tree(), [word])["nodes"][1])

    def test_non_gtk_and_password_and_icon_only_controls_are_unchanged(self):
        words = [("coordinate-target", 337, 210, 130, 20, 1, 99)]
        for toolkit, role, name in [("Qt", "table cell", "coordinate-target"), ("GTK", "password text", "coordinate-target"),
                                    ("GTK", "button", ""), ("GTK", "button", "7")]:
            tree = self.tree()
            tree["toolkit"] = toolkit
            tree["nodes"][1].update(role=role, name=name)
            self.assertNotIn("providerBox", self.calibrate(tree, words)["nodes"][1])

    def test_bad_tsv_or_geometry_keeps_original_tree(self):
        tree = self.tree()
        for raw in [b"secret", b"\xff", HEADER.encode() + b"broken\trow", b"x" * 262145]:
            self.assertEqual(a11y_pixels.calibrate_from_tsv(tree, raw, (1440, 960), (960, 640)), tree)
        self.assertEqual(a11y_pixels.calibrate_from_tsv(tree, b"", (0, 960), (960, 640)), tree)

    def test_geometry_provenance_still_obeys_the_existing_tree_byte_cap(self):
        tree = self.tree()
        tree["nodes"] = [{"role": "table cell", "name": f"Target{i:03d}. Folder", "box": [194, 43, 112, 119]} for i in range(150)]
        words = [(f"Target{i:03d}", 337, 210, 130, 20, i + 1, 99) for i in range(150)]
        result = self.calibrate(tree, words)
        self.assertLessEqual(len(json.dumps(result["nodes"], ensure_ascii=False, separators=(",", ":")).encode()), 16000)
        self.assertEqual(result["truncated"], "bytes")
        self.assertFalse(result["complete"])
        self.assertEqual(result["geometryCalibration"]["corrected"], len(result["nodes"]))

    def test_expired_budget_never_starts_ocr_and_provider_errors_are_private(self):
        tree = self.tree()
        with patch.object(a11y_pixels, "_ocr", side_effect=AssertionError("must not start")):
            self.assertEqual(a11y_pixels.calibrate(tree, b"png", (1440, 960), (960, 640), time.monotonic() - 1), tree)
        with patch.object(a11y_pixels, "_ocr", side_effect=OSError("PRIVATE ERROR")):
            self.assertEqual(a11y_pixels.calibrate(tree, b"png", (1440, 960), (960, 640), time.monotonic() + 1), tree)

    def owned_ocr(self, code, deadline):
        real_spawn = subprocess.Popen
        owned = []
        def spawn(argv, **options):
            child = real_spawn(["/usr/bin/python3", "-I", "-c", code], **options)
            owned.append(child)
            return child
        with patch.object(a11y_pixels.subprocess, "Popen", side_effect=spawn):
            result = a11y_pixels._ocr(b"owned-test-image", deadline)
        self.assertEqual(len(owned), 1)
        self.assertIsNotNone(owned[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(owned[0].pid, 0)
        return result

    def test_hung_owned_ocr_is_killed_and_reaped_without_resetting_the_deadline(self):
        started = time.monotonic()
        self.assertIsNone(self.owned_ocr("import sys,time;sys.stdin.buffer.read();time.sleep(10)", started + 0.12))
        self.assertLess(time.monotonic() - started, 0.6)

    def test_owned_ocr_output_is_bounded_before_reading_into_worker_memory(self):
        code = "import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b'x'*400000);sys.stdout.buffer.flush()"
        self.assertIsNone(self.owned_ocr(code, time.monotonic() + 1))


if __name__ == "__main__":
    unittest.main()
