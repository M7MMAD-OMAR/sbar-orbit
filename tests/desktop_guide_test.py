import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('orbit_guide', Path(__file__).resolve().parents[1] / 'desktop' / 'guide.py')
guide = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide)


@unittest.skipUnless(os.name == 'posix', 'Private state file checks require POSIX')
class GuideStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'position.json'
        self.path.write_text(json.dumps({'x': 10, 'y': 20}))
        self.path.chmod(0o600)

    def tearDown(self):
        self.directory.cleanup()

    def test_private_position(self):
        self.assertEqual(guide.read_position(self.path, 1280, 800), (10, 20))

    def test_shared_mode_is_refused(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            guide.read_position(self.path, 1280, 800)

    def test_symlink_is_refused(self):
        link = self.path.with_name('link.json')
        link.symlink_to(self.path)
        with self.assertRaises(OSError):
            guide.read_position(link, 1280, 800)

    def test_hardlink_is_refused(self):
        os.link(self.path, self.path.with_name('other.json'))
        with self.assertRaises(ValueError):
            guide.read_position(self.path, 1280, 800)

    def test_bad_coordinates_are_refused(self):
        for state in [{'x': -1, 'y': 20}, {'x': 1280, 'y': 20}, {'x': 10, 'y': 800},
                      {'x': True, 'y': 20}, {'x': 1.5, 'y': 20}]:
            self.path.write_text(json.dumps(state))
            with self.subTest(state=state), self.assertRaises(ValueError):
                guide.read_position(self.path, 1280, 800)

    def test_unknown_shape_is_refused(self):
        for state in [{'x': 10}, {'x': 10, 'y': 20, 'action': 'click'}, [10, 20]]:
            self.path.write_text(json.dumps(state))
            with self.subTest(state=state), self.assertRaises(ValueError):
                guide.read_position(self.path, 1280, 800)

    def test_oversize_is_refused(self):
        self.path.write_text(' ' * 1025)
        with self.assertRaises(ValueError):
            guide.read_position(self.path, 1280, 800)

    @unittest.skipUnless(sys.platform == 'linux', 'Runtime preview requires Linux')
    def test_unsupported_display_refuses_before_window_creation(self):
        fake_gi = types.ModuleType('gi')
        fake_gi.require_version = lambda *args: None
        repository = types.ModuleType('gi.repository')
        def unexpected_window():
            raise AssertionError('An unsupported display must not create a window')
        monitor = types.SimpleNamespace(get_model=lambda: 'Fixture',
                                       get_geometry=lambda: types.SimpleNamespace(width=1280, height=800))
        display = types.SimpleNamespace(get_n_monitors=lambda: 1, get_monitor=lambda i: monitor)
        repository.Gtk = types.SimpleNamespace(Window=unexpected_window)
        repository.Gdk = types.SimpleNamespace(Display=types.SimpleNamespace(get_default=lambda: display))
        repository.GLib = types.SimpleNamespace()
        repository.GtkLayerShell = types.SimpleNamespace(is_supported=lambda: False,
            Edge=types.SimpleNamespace(TOP=0, BOTTOM=1, LEFT=2, RIGHT=3))
        budget = types.ModuleType('budget')
        budget.require_budget = lambda: None
        with patch.dict('sys.modules', {'gi': fake_gi, 'gi.repository': repository,
                                       'cairo': types.ModuleType('cairo'), 'budget': budget}), \
             patch('sys.argv', ['guide.py', '--state', str(self.path), '--monitor', 'Fixture']), \
             self.assertRaisesRegex(RuntimeError, 'layer shell'):
            guide.main()


if __name__ == '__main__':
    unittest.main()
