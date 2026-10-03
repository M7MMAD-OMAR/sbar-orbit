#!/usr/bin/python3
"""Color-scheme preparation must reject profile escape before any settings write."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import native_color_scheme as helper

if "--unfixed" in sys.argv:
    sys.argv.remove("--unfixed")
    text = Path(helper.__file__).read_text()
    start = text.index('    for name in ("home", "config", "data", "cache", "state"):')
    end = text.index("\n\ndef read_scheme", start)
    text = text[:start] + text[end:]
    exec(compile(text, helper.__file__, "exec"), helper.__dict__)


class ColorSchemeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gl-scheme-test-")
        self.lab = Path(self.temporary.name)
        self.work = self.lab / "work"
        self.work.mkdir(mode=0o700)
        for name in ("home", "config", "data", "cache", "state"):
            (self.work / name).mkdir(mode=0o700)
        self.environment = {"XDG_RUNTIME_DIR": str(self.lab / "run"), "HOME": str(self.work / "home"),
                            "XDG_CONFIG_HOME": str(self.work / "config"), "XDG_DATA_HOME": str(self.work / "data"),
                            "XDG_CACHE_HOME": str(self.work / "cache"), "XDG_STATE_HOME": str(self.work / "state"),
                            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={self.work / 'session'}",
                            "AT_SPI_BUS_ADDRESS": f"unix:path={self.work / 'a11y'}", "GSETTINGS_BACKEND": "dconf"}

    def tearDown(self):
        self.temporary.cleanup()

    def test_three_named_enums_and_invalid_or_oversized_plans(self):
        plan = self.work / "color-scheme.json"
        for scheme in helper.SCHEMES:
            plan.write_text(json.dumps({"color_scheme": scheme}))
            self.assertEqual(helper.read_scheme(self.work), scheme)
        for value in ({}, {"color_scheme": []}, {"color_scheme": 1}, {"color_scheme": "unknown"},
                      {"color_scheme": "prefer-dark", "other": True}, []):
            plan.write_text(json.dumps(value))
            with self.assertRaises(RuntimeError):
                helper.read_scheme(self.work)
        plan.write_text(" " * 1025)
        with self.assertRaises(RuntimeError):
            helper.read_scheme(self.work)

    def test_plan_link_is_refused(self):
        outside = self.lab / "outside.json"
        outside.write_text('{"color_scheme":"prefer-dark"}')
        (self.work / "color-scheme.json").symlink_to(outside)
        with self.assertRaises(OSError):
            helper.read_scheme(self.work)

    def test_each_environment_destination_must_belong_to_the_worker(self):
        helper.validate_profile(self.work, self.environment)
        for key in self.environment.keys() - {"XDG_RUNTIME_DIR"}:
            environment = dict(self.environment, **{key: str(self.lab / "outside")})
            with self.assertRaises(RuntimeError):
                helper.validate_profile(self.work, environment)

    def test_config_link_refused_before_lease_or_settings_write(self):
        outside = self.lab / "owner-like"
        outside.mkdir(mode=0o700)
        marker = outside / "marker"
        marker.write_text("unchanged")
        (self.work / "config").rmdir()
        (self.work / "config").symlink_to(outside, target_is_directory=True)
        (self.work / "color-scheme.json").write_text('{"color_scheme":"prefer-dark"}')
        calls = []
        def lease(unit):
            calls.append("lease")
            raise AssertionError("Reached lease after unsafe profile")
        with patch.dict(os.environ, self.environment), patch.object(sys, "argv", ["scheme", str(self.work), "unit"]), \
                patch.object(helper, "guard", lambda env: None), patch.object(helper, "require_budget", lambda: None), \
                patch.object(helper, "NativeLease", lease):
            with self.assertRaises(RuntimeError):
                helper.main()
        self.assertEqual(calls, [])
        self.assertEqual(list(outside.iterdir()), [marker])
        self.assertEqual(marker.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
