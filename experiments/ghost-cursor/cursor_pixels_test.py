#!/usr/bin/python3
"""Test the exact pixel verifier definition without importing GUI/runtime modules."""
import ast
from pathlib import Path
import sys
import unittest
from PIL import Image, ImageChops

source = Path(sys.argv[1]) if len(sys.argv) == 2 else Path(__file__).with_name("cursor_damage_probe.py")
module = ast.parse(source.read_text())
function = next(node for node in ast.walk(module) if isinstance(node, ast.FunctionDef)
                and node.name in ("verify_cursor_pixels", "only_cursors"))
namespace = {"ImageChops": ImageChops, "report": {"checks": []}}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
verify = namespace[function.name]
sys.argv = sys.argv[:1]


class CursorPixels(unittest.TestCase):
    boxes = [(2, 2, 6, 6), (12, 2, 16, 6)]

    def fixture(self, both=True):
        baseline = Image.new("RGB", (20, 10), (12, 18, 30))
        actual = baseline.copy()
        actual.putpixel((3, 3), (255, 255, 255))
        if both:
            actual.putpixel((13, 3), (255, 255, 255))
        return actual, baseline

    def test_two_independent_visible_footprints(self):
        actual, baseline = self.fixture()
        verify(actual, baseline, self.boxes, "two")

    def test_missing_second_cursor_is_not_a_pass(self):
        actual, baseline = self.fixture(False)
        with self.assertRaises(RuntimeError):
            verify(actual, baseline, self.boxes, "missing second")

    def test_pixels_outside_footprints_are_not_a_pass(self):
        actual, baseline = self.fixture()
        actual.putpixel((19, 9), (255, 255, 255))
        with self.assertRaises(RuntimeError):
            verify(actual, baseline, self.boxes, "outside")


if __name__ == "__main__":
    unittest.main()
