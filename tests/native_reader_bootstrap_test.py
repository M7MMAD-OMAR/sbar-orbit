"""Refusal fixtures only: no provider, signals, sockets or desktop work."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import signal
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_bootstrap as subject


class ReaderBootstrapRefusalTests(unittest.TestCase):
    def test_main_refuses_without_inspecting_arguments(self):
        class Forbidden:
            def __getattribute__(self, name):
                raise AssertionError("argument inspected")
        self.assertEqual(subject.main(Forbidden()), 70)

    def test_main_does_not_touch_environment_or_launch(self):
        with patch.object(os, "getppid", side_effect=AssertionError("parent")), \
             patch.object(os, "lstat", side_effect=AssertionError("filesystem")), \
             patch.object(os, "open", side_effect=AssertionError("open")), \
             patch.object(os, "kill", side_effect=AssertionError("signal")), \
             patch.object(os, "execve", side_effect=AssertionError("exec")), \
             patch.object(signal, "alarm", side_effect=AssertionError("alarm")):
            self.assertEqual(subject.main(["123", "abc"]), 70)

    def test_all_argument_shapes_refuse(self):
        for value in (None, [], ["--help"], ["123", "abc"], object()):
            with self.subTest(value=type(value).__name__):
                self.assertEqual(subject.main(value), 70)

    def test_direct_entry_exits_without_output(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                runpy.run_path(str(Path(subject.__file__)), run_name="__main__")
        self.assertEqual(caught.exception.code, 70)
        self.assertEqual((out.getvalue(), err.getvalue()), ("", ""))

    def test_module_has_no_execution_helpers(self):
        self.assertFalse(hasattr(subject, "_provider_identity"))
        self.assertFalse(hasattr(subject, "_environment"))


if __name__ == "__main__":
    unittest.main()
