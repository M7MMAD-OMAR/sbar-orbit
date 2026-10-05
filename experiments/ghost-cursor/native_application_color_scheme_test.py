#!/usr/bin/python3
"""Reject color preference writes outside the admitted private application."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.application import application_environment, launch_arguments
from src.native import color_scheme


class ColorSchemeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-color-guard-")
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        for name in ("home", "config", "data", "cache", "state", "run"):
            (self.profile / name).mkdir(mode=0o700)
        self.env = application_environment(self.profile, {"runtime": "/private", "display": "wayland-1"}, "test.scope")
        self.env["GSETTINGS_BACKEND"] = "dconf"

    def test_preference_changes_admitted_fingerprint(self):
        digests = {launch_arguments(["/usr/bin/true"], {"color-scheme": scheme})[2]
                   for scheme in color_scheme.SCHEMES}
        self.assertEqual(len(digests), 3)
        self.assertNotIn(launch_arguments(["/usr/bin/true"], {})[2], digests)
        for invalid in ("system", "prefer-dark\n", True):
            with self.assertRaises(RuntimeError):
                launch_arguments(["/usr/bin/true"], {"color-scheme": invalid})

    def test_owner_bus_or_profile_paths_refused_before_writes(self):
        for key in ("HOME", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "GSETTINGS_BACKEND"):
            environment = {**self.env, key: "owner-value"}
            with self.subTest(key=key), patch.dict(os.environ, environment, clear=True), \
                    patch.object(color_scheme, "require_budget"), patch.object(color_scheme, "NativeLease") as lease:
                with self.assertRaisesRegex(RuntimeError, "exact private"):
                    color_scheme.main(self.profile, "test.scope", "prefer-dark")
                lease.assert_not_called()
                self.assertFalse((self.profile / "config/xdg-desktop-portal").exists())

    def test_public_profile_directory_refused(self):
        (self.profile / "config").chmod(0o755)
        with self.assertRaises(RuntimeError):
            color_scheme.validate_environment(self.profile, self.env, "prefer-dark")

    def test_escaped_writer_refused_before_settings_access(self):
        with patch.dict(os.environ, self.env, clear=True), patch.object(color_scheme, "require_budget"), \
                patch.object(color_scheme, "NativeLease") as lease, patch.object(color_scheme.Gio.Settings, "new") as settings:
            lease.return_value.contains.return_value = False
            with self.assertRaisesRegex(RuntimeError, "writer escaped"):
                color_scheme.main(self.profile, "test.scope", "prefer-dark")
            settings.assert_not_called()
            self.assertFalse((self.profile / "config/xdg-desktop-portal").exists())

    def test_escaped_service_refuses_completion_evidence(self):
        connection = MagicMock()
        connection.call_sync.side_effect = [
            color_scheme.GLib.Variant("(a{sa{sv}})", ({"org.freedesktop.appearance": {
                "color-scheme": color_scheme.GLib.Variant("u", 1)}},)),
            color_scheme.GLib.Variant("(u)", (os.getpid(),)),
            color_scheme.GLib.Variant("(u)", (os.getpid(),)),
            color_scheme.GLib.Variant("(u)", (os.getpid(),)),
        ]
        with patch.dict(os.environ, self.env, clear=True), patch.object(color_scheme, "require_budget"), \
                patch.object(color_scheme, "NativeLease") as lease, patch.object(color_scheme.Gio.Settings, "new") as settings, \
                patch.object(color_scheme.Gio.Settings, "sync"), patch.object(color_scheme.Gio, "bus_get_sync", return_value=connection), \
                patch.object(color_scheme.subprocess, "run", return_value=MagicMock(stdout="'prefer-dark'\n")):
            settings.return_value.set_string.return_value = True
            lease.return_value.contains.side_effect = [True, False]
            with self.assertRaisesRegex(RuntimeError, "service escaped"):
                color_scheme.main(self.profile, "test.scope", "prefer-dark")
            self.assertFalse((self.profile / "color-scheme.json").exists())
            lease.return_value.verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
