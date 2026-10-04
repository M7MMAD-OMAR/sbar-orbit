"""Host experiment checks; run with system Python inside a guarded private lab."""
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import importlib.util
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

import prepared_plugin_probe as probe

if len(sys.argv) > 1 and sys.argv[1].endswith(".py"):
    spec = importlib.util.spec_from_file_location("unchecked_probe", sys.argv.pop(1))
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    probe = candidate


class ReportTests(unittest.TestCase):
    def test_retention_refusal_preserves_primary_and_cleanup_errors(self):
        report = {"complete": False, "errors": ["broker refused input"],
                  "cleanup_errors": ["unload refused"]}
        output, error = StringIO(), StringIO()
        with patch.object(Path, "write_text", side_effect=OSError("simulated disk quota")), \
                redirect_stdout(output), redirect_stderr(error):
            probe.retain_report(Path("owned-report.json"), report)
        retained = json.loads(error.getvalue())
        self.assertEqual(output.getvalue(), "")
        self.assertFalse(retained["complete"])
        self.assertEqual(retained["errors"], ["broker refused input"])
        self.assertEqual(retained["cleanup_errors"][0], "unload refused")
        self.assertIn("simulated disk quota", retained["cleanup_errors"][1])

    def test_success_retains_exact_report(self):
        root = Path(__file__).resolve().parents[2] / ".private"
        with tempfile.TemporaryDirectory(prefix="prepared-report-test-", dir=root) as directory:
            path = Path(directory) / "report.json"
            report = {"complete": True, "errors": [], "cleanup_errors": []}
            output, error = StringIO(), StringIO()
            with redirect_stdout(output), redirect_stderr(error):
                probe.retain_report(path, report)
            self.assertEqual(json.loads(path.read_text()), report)
            self.assertEqual(output.getvalue(), str(path) + "\n")
            self.assertEqual(error.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
