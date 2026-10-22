"""Existing panel choices drive native indicators without a GTK application."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.indicator_style import indicator_style, apply_indicator_style
from src.native.host import HostError


class IndicatorStyleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = Path(self.tmp.name)
        self.settings = self.config / "sbar-orbit" / "panel.json"
        self.settings.parent.mkdir()

    def store(self, **settings):
        self.settings.write_text(json.dumps(settings))

    def resolve(self):
        return indicator_style(config_home=self.config)

    def test_missing_settings_use_original_panel_blue_glow_and_pulse(self):
        self.assertEqual(self.resolve(), {"hex": "255fce", "pulse": 1, "frame": 1,
            "colourSource": "owner-frame-color", "note": None})
        self.assertFalse(self.settings.exists())

    def test_explicit_owner_colour_and_disabled_controls_are_preserved(self):
        self.store(frameColor="#A1B2C3", framePulse=False, frame=False)
        self.assertEqual(self.resolve(), {"hex": "a1b2c3", "pulse": 0, "frame": 0,
            "colourSource": "owner-frame-color", "note": None})

    def test_schema_validation_rejects_ipc_content_and_preserves_stored_file(self):
        self.store(frameColor="#123456 0 0\nghost-click target 0 0")
        before = self.settings.read_bytes()
        self.assertEqual(self.resolve()["hex"], "255fce")
        self.assertEqual(self.settings.read_bytes(), before)

    def test_corrupt_settings_keep_the_schema_diagnostic(self):
        self.settings.write_text("{")
        value = self.resolve()
        self.assertEqual(value["hex"], "255fce")
        self.assertIn("could not read", value["note"])
        self.assertEqual(self.settings.read_text(), "{")

    def test_accent_follows_user_gtk_css_import_and_colour_alias(self):
        self.store(frameColor="accent")
        gtk = self.config / "gtk-4.0"
        gtk.mkdir()
        (gtk / "gtk.css").write_text('@import "palette.css";\n@define-color accent_bg_color @owner_blue;')
        (gtk / "palette.css").write_text('@define-color owner_blue #A3b;')
        value = self.resolve()
        self.assertEqual(value["hex"], "aa33bb")
        self.assertEqual(value["colourSource"], "gtk-user-css")
        self.assertIsNone(value["note"])

    def test_gtk_three_rgb_fallback_is_read_without_display(self):
        self.store(frameColor="accent")
        gtk = self.config / "gtk-3.0"
        gtk.mkdir()
        (gtk / "gtk.css").write_text('@define-color theme_selected_bg_color rgb(12, 34, 56);')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.resolve()["hex"], "0c2238")

    def test_accent_without_resolvable_theme_reports_original_blue_fallback(self):
        self.store(frameColor="accent")
        value = self.resolve()
        self.assertEqual(value["hex"], "255fce")
        self.assertEqual(value["colourSource"], "orbit-blue-fallback")
        self.assertIn("could not be resolved", value["note"])

    def test_css_alias_cycle_and_commented_definition_do_not_fabricate_accent(self):
        self.store(frameColor="accent")
        gtk = self.config / "gtk-4.0"
        gtk.mkdir()
        (gtk / "gtk.css").write_text('/* @define-color accent_bg_color #abcdef; */\n'
            '@define-color accent_bg_color @owner; @define-color owner @accent_bg_color;')
        self.assertEqual(self.resolve()["colourSource"], "orbit-blue-fallback")

    def test_explicit_xdg_config_is_used_when_environment_supplies_it(self):
        self.store(frameColor="#654321")
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.config)}, clear=True):
            self.assertEqual(indicator_style()["hex"], "654321")

    def test_worker_without_xdg_uses_account_home_default(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, clear=True), \
                patch("src.native.indicator_style.Path.home", return_value=self.config):
            # With no environment override, use the ordinary account default.
            self.assertEqual(indicator_style()["hex"], "255fce")

    def test_application_sends_only_normalized_tokens_and_requires_acknowledgement(self):
        self.store(frameColor="#ABCDEF", framePulse=False)
        class Transport:
            def __init__(self): self.requests = []
            def _exchange(self, request):
                self.requests.append(request)
                return "ok"
        transport = Transport()
        with patch("src.native.indicator_style.indicator_style", return_value=self.resolve()):
            apply_indicator_style(transport)
        self.assertEqual(transport.requests, ["ghost-indicator-style abcdef 0 1"])
        with patch("src.native.indicator_style.indicator_style", return_value=self.resolve()), \
                patch.object(transport, "_exchange", return_value="refused: fixture"):
            with self.assertRaises(HostError):
                apply_indicator_style(transport)


if __name__ == "__main__":
    unittest.main()
