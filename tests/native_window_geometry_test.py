"""Native placement contract, without opening any desktop or application."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.window_geometry import window_size, placement, measured_window


class GeometryTests(unittest.TestCase):
    def test_size_validation_rejects_unknown_fields_and_noninteger_values(self):
        self.assertEqual(window_size(), {"width": 960, "height": 640})
        for value in [{}, {"width": True, "height": 600}, {"width": 800, "height": 1},
                      {"width": 800, "height": 600, "float": False}, {"width": 800.5, "height": 600}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                window_size(value)

    def test_named_workspace_uses_its_monitor_and_scales_reserved_work_area(self):
        target = {"name": "target", "x": -960, "y": 100, "width": 1440, "height": 900,
                  "scale": 1.5, "reserved": [20, 30, 20, 10]}
        other = {**target, "name": "other", "focused": True}
        result = placement(2, window_size(), [{"id": 2, "monitor": "target"}], [other, target])
        self.assertEqual(result, {"width": 888, "height": 528, "left": -940, "top": 130,
                                  "right": -20, "bottom": 690})

    def test_unknown_workspace_uses_one_focused_monitor_without_switching(self):
        monitor = {"name": "target", "x": 0, "y": 0, "width": 1920, "height": 1080,
                   "scale": 1, "focused": True}
        self.assertEqual(placement(9, {"width": 720, "height": 600}, [], [monitor])["width"], 720)
        with self.assertRaises(ValueError):
            placement(9, window_size(), [], [monitor, {**monitor, "name": "other"}])

    def test_small_or_unknown_monitor_is_not_guessed(self):
        for monitors in [[], [{"name": "target", "focused": True}],
                         [{"name": "target", "focused": True, "x": 0, "y": 0,
                           "width": 200, "height": 200, "scale": 1}]]:
            with self.subTest(monitors=monitors), self.assertRaises(ValueError):
                placement(2, window_size(), [], monitors)

    def test_off_center_window_does_not_count_as_verified_placement(self):
        fitted = {"width": 720, "height": 600, "left": 0, "top": 0, "right": 1920, "bottom": 1080}
        self.assertIsNone(measured_window({"floating": True, "size": [720, 600], "at": [100, 100]}, fitted))

    def test_tiling_wrong_size_and_clipping_cannot_count_as_success(self):
        fitted = {"width": 720, "height": 600, "left": 0, "top": 0, "right": 1920, "bottom": 1080}
        valid = {"floating": True, "size": [720, 600], "at": [600, 240]}
        self.assertEqual(measured_window(valid, fitted)["width"], 720)
        for value in [{**valid, "floating": False}, {**valid, "size": [900, 600]},
                      {**valid, "at": [-200, 100]}, {**valid, "at": [1500, 100]},
                      {**valid, "at": [float('nan'), 100]}]:
            with self.subTest(value=value):
                self.assertIsNone(measured_window(value, fitted))


if __name__ == '__main__':
    unittest.main()
