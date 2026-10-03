#!/usr/bin/python3
"""Recording setup and cleanup failures must release every acquired resource."""
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


source = Path(__file__).with_name("native_scoped_cursor_demo.py")
text = source.read_text()
if "--unfixed" in sys.argv:
    sys.argv.remove("--unfixed")
    text = text.replace("    unit_report = None\n    try:",
                        "    unit_report = None\n    person = StandIn()\n    owner = person.wait_mapped()\n    try:")
    text = text.replace("        person = StandIn()\n        pointer = Pointer()\n        owner = person.wait_mapped()",
                        "        pointer = Pointer()")
demo = types.ModuleType("recording_fixture")
demo.__file__ = str(source)
# Import fixture definitions only. All display operations below are replaced.
fixtures = types.SimpleNamespace(StandIn=None, Pointer=lambda: types.SimpleNamespace(ident=None))
with patch.dict(sys.modules, {"harness": fixtures}):
    exec(compile(text, str(source), "exec"), demo.__dict__)


class CleanupTest(unittest.TestCase):
    def check_setup_failure(self, stop_error):
        calls = []

        class Person:
            def __init__(self):
                self.p = types.SimpleNamespace(wait=lambda timeout: calls.append("wait"))

            def wait_mapped(self):
                raise RuntimeError("injected setup failure")

            def stop(self):
                calls.append("stop")
                if stop_error:
                    raise RuntimeError("injected stop failure")

        class Control:
            def __init__(self, path):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def inspect(self):
                return {"settings": {"mode": "protected"}}
            def configure(self, **settings):
                calls.append(settings["mode"])

        with tempfile.TemporaryDirectory(prefix="gl-demo-cleanup-") as lab:
            environment = {"XDG_RUNTIME_DIR": str(Path(lab) / "run"), "XDG_STATE_HOME": lab}
            with patch.dict(os.environ, environment), patch.object(sys, "argv", ["demo", "source"]), \
                    patch.object(demo, "guard", lambda env: None), patch.object(demo, "StandIn", Person), \
                    patch.object(demo, "ActionControl", Control), \
                    patch.object(demo, "hypr", lambda command: json.dumps([{"specialWorkspace": {"name": ""}}])):
                with self.assertRaises(BaseException) as failure:
                    demo.main()
            self.assertIn("injected setup failure", str(failure.exception.exceptions[0])
                          if isinstance(failure.exception, BaseExceptionGroup) else str(failure.exception))
            self.assertEqual(calls, ["stop", "wait", "protected"])
            self.assertEqual(list(Path(lab).glob("native-demo-units-*")), [])
            if stop_error:
                self.assertEqual(len(failure.exception.exceptions), 2)

    def test_setup_failure_releases_person_and_restores_settings(self):
        self.check_setup_failure(False)

    def test_stop_failure_does_not_skip_wait_restore_or_report_cleanup(self):
        self.check_setup_failure(True)


if __name__ == "__main__":
    unittest.main()
