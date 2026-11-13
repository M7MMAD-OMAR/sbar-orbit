"""Native work must not map duplicate layer surfaces and relayout owner windows."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class NativeFrameTests(unittest.TestCase):
    def panel(self, sessions, existing=False):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'desktop/panel.py').read_text())
        panel = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Panel')
        method = next(node for node in panel.body if isinstance(node, ast.FunctionDef) and node.name == 'sync_frame')
        namespace = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'panel.sync_frame', 'exec'), namespace)
        changes = []
        strips = [SimpleNamespace(set_visible=lambda visible: changes.append(visible)) for _ in range(4)]
        def build():
            changes.append('mapped')
            state.frame = strips
        state = SimpleNamespace(sessions=sessions, settings={'frame': True}, frame=strips if existing else [],
                                frame_shown=existing, build_frame=build)
        return state, changes, namespace['sync_frame']

    def test_native_start_and_finish_never_create_layer_surfaces(self):
        state, changes, sync = self.panel([{'backend': 'native', 'activity': {'state': 'working'}}])
        sync(state)
        state.sessions[0]['activity']['state'] = 'done'
        sync(state)
        state.sessions = []
        sync(state)
        self.assertEqual(changes, [])

    def test_native_settings_refresh_does_not_map_a_frame(self):
        state, changes, sync = self.panel([{'backend': 'native', 'activity': {'state': 'working'}}])
        sync(state, force=True)
        self.assertEqual(changes, [])

    def test_an_existing_legacy_frame_is_hidden_instead_of_shown_for_native_work(self):
        state, changes, sync = self.panel([{'backend': 'native', 'activity': {'state': 'working'}}], existing=True)
        sync(state)
        self.assertEqual(changes, [False] * 4)
        self.assertFalse(state.frame_shown)


if __name__ == '__main__':
    unittest.main()
