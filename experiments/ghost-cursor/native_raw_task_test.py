#!/usr/bin/python3
"""Raw task setup and storage failures retain their independent causes."""
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

with patch.dict(sys.modules, {"cursor_cost_probe": SimpleNamespace(
        loaded_plugin=Mock(side_effect=AssertionError("Failure test reached plugin inspection")))}):
    import native_raw_task as task


class RawTaskFailureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gl-raw-error-")
        self.addCleanup(self.temporary.cleanup)
        self.lab = Path(self.temporary.name)
        self.created = []
        self.stdout, self.stderr = StringIO(), StringIO()
        self.create = tempfile.mkdtemp
        self.remove = shutil.rmtree

    def allocate(self, *args, **kwargs):
        path = self.create(*args, **kwargs)
        self.created.append(Path(path))
        self.addCleanup(self.remove, path, True)
        return path

    def run_task(self):
        with patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(self.lab / "run")}), \
                patch.object(task, "guard"), patch.object(task, "require_budget"), \
                patch.object(sys, "argv", ["raw-task"]), \
                redirect_stdout(self.stdout), redirect_stderr(self.stderr):
            return task.main()

    def test_partial_setup_is_cleaned_and_reported(self):
        def allocate(*args, **kwargs):
            if kwargs["prefix"] == "native-raw-":
                raise OSError("retained directory unavailable")
            return self.allocate(*args, **kwargs)
        with patch.object(task.tempfile, "mkdtemp", side_effect=allocate), patch.object(task, "inspect_host") as host:
            self.assertEqual(self.run_task(), 1)
        host.assert_not_called()
        self.assertEqual(len(self.created), 1)
        self.assertFalse(self.created[0].exists())
        fallback = json.loads(self.stderr.getvalue())["report"]
        self.assertIn("retained directory unavailable", fallback["errors"][0])
        self.assertEqual(fallback["cleanupErrors"], [])
        self.assertIsNone(json.loads(self.stdout.getvalue())["report"])

    def test_primary_cleanup_and_retention_errors_survive_together(self):
        with patch.object(task.tempfile, "mkdtemp", side_effect=self.allocate), \
                patch.object(task, "inspect_host", side_effect=RuntimeError("original host failure")), \
                patch.object(task.shutil, "rmtree", side_effect=OSError("cleanup failed")), \
                patch.object(Path, "write_text", side_effect=OSError("report quota failure")):
            self.assertEqual(self.run_task(), 1)
        fallback = json.loads(self.stderr.getvalue())
        self.assertTrue(fallback["reportRetentionFailed"])
        self.assertFalse(fallback["report"]["complete"])
        self.assertEqual(fallback["report"]["errors"], [
            "RuntimeError('original host failure')", "OSError('report quota failure')"])
        self.assertEqual(fallback["report"]["cleanupErrors"], ["OSError('cleanup failed')"])

    def test_uncertain_launch_keeps_allocation_recovery_files(self):
        def launch(argv):
            (self.created[0] / "allocation-recovery.json").write_text("uncertain")
            raise BaseExceptionGroup("Launch cleanup uncertain", [
                RuntimeError("launch failed"), RuntimeError("owned process still alive")])
        with patch.object(task.tempfile, "mkdtemp", side_effect=self.allocate), \
                patch.object(task, "inspect_host", return_value={"compositor": [123]}), \
                patch.object(task, "loaded_plugin", return_value={}), \
                patch.object(task, "ActionControl") as control, patch.object(task, "NativeSession") as session:
            control.return_value.inspect.return_value = {"events": [], "unresolved": []}
            session.return_value.launch.side_effect = launch
            self.assertEqual(self.run_task(), 1)
            session.return_value.close.assert_called_once()
        report = json.loads(Path(json.loads(self.stdout.getvalue())["report"]).read_text())
        self.assertFalse(report["complete"])
        self.assertIn("owned process still alive", report["errors"][0])
        self.assertEqual(Path(report["workDirectory"]), self.created[0])
        self.assertEqual((self.created[0] / "allocation-recovery.json").read_text(), "uncertain")


if __name__ == "__main__":
    unittest.main()
