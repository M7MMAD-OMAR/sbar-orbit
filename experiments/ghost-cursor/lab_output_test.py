#!/usr/bin/python3
"""Invalid display startup must release the lab even if evidence storage fails."""
import ast
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


source = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).with_name("lab.py")
spec = importlib.util.spec_from_file_location("lab_fixture", source)
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def fail_output(primary):
    if hasattr(lab, "failed_output"):
        lab.failed_output(Path("/tmp/gl-output-fixture"), Path("/missing/log"), [], primary)
    else:
        # Exercise the actual previous startup exception handler, without launching displays.
        tree = ast.parse(source.read_text())
        up = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "up")
        handler = next(node.handlers[0] for node in ast.walk(up) if isinstance(node, ast.Try)
                       and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                               and call.func.id == "wait" and any(isinstance(arg, ast.Constant)
                               and arg.value == "usable 1920x1200 nested output" for arg in call.args)
                               for call in ast.walk(node)))
        body = ast.Module(body=handler.body, type_ignores=[])
        environment = dict(lab.__dict__, lab=Path("/tmp/gl-output-fixture"),
                           hypr=Path("/missing"), sig="fixture", observed=[], primary=primary)
        exec(compile(ast.fix_missing_locations(body), str(source), "exec"), environment)


class OutputTest(unittest.TestCase):
    def test_evidence_failure_still_stops_lab(self):
        primary = SystemExit("invalid nested output")
        evidence = OSError("evidence storage unavailable")
        with patch.object(Path, "write_text", side_effect=evidence), patch.object(lab, "down") as stop:
            with self.assertRaises(BaseException) as failure:
                fail_output(primary)
        stop.assert_called_once_with(Path("/tmp/gl-output-fixture"))
        self.assertIsInstance(failure.exception, BaseExceptionGroup)
        self.assertEqual(failure.exception.exceptions, (primary, evidence))

    def test_cleanup_failure_preserves_all_errors(self):
        primary = SystemExit("invalid nested output")
        evidence = OSError("evidence storage unavailable")
        cleanup = RuntimeError("cleanup unavailable")
        with patch.object(Path, "write_text", side_effect=evidence), \
                patch.object(lab, "down", side_effect=cleanup) as stop:
            with self.assertRaises(BaseException) as failure:
                fail_output(primary)
        stop.assert_called_once()
        self.assertIsInstance(failure.exception, BaseExceptionGroup)
        self.assertEqual(failure.exception.exceptions, (primary, evidence, cleanup))

    def test_only_expected_live_output_is_usable(self):
        good = {"name": "WAYLAND-1", "width": 1920, "height": 1200, "disabled": False}
        self.assertTrue(lab.usable_output([good]))
        for monitors in ([], [dict(good, name="FALLBACK", width=0, height=0)],
                         [dict(good, disabled=True)], [dict(good, width=1280)], [good, good]):
            self.assertFalse(lab.usable_output(monitors))


if __name__ == "__main__":
    unittest.main()
