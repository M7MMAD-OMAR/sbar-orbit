"""Exercise desktop launch routing without importing GTK or starting applications."""
import ast
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def function(path, name, namespace, class_name=None):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8'))
    body = tree.body
    if class_name:
        body = next(node for node in body if isinstance(node, ast.ClassDef) and node.name == class_name).body
    node = next(node for node in body if isinstance(node, ast.FunctionDef) and node.name == name)
    scope = dict(namespace)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(ROOT / path), 'exec'), scope)
    return scope[name]


class DesktopBrowserRetirementTests(unittest.TestCase):
    def test_panel_session_action_only_expands_native_panel(self):
        calls = []
        class Launcher:
            def launch(self, *_args):
                calls.append('browser-launch')
        def rpc(*_args):
            calls.append('browser-rpc')
            return {'url': 'http://127.0.0.1:12345/#fixture', 'opened': False}
        panel = types.SimpleNamespace(path='/unused.sock', settings={'viewerBrowser': '', 'viewerAppWindow': True},
                                      set_expanded=lambda expanded: calls.append(('expanded', expanded)))
        action = function('desktop/panel.py', 'open_viewer', {
            'rpc': rpc, 'sys': sys, 'viewer_link_is_local': lambda _url: True,
            'Gtk': types.SimpleNamespace(UriLauncher=types.SimpleNamespace(new=lambda _url: Launcher())),
        }, class_name='Panel')
        action(panel)
        self.assertEqual(calls, [('expanded', True)])

    def test_settings_action_exposes_native_configuration_notice(self):
        calls = []
        panel = types.SimpleNamespace(set_expanded=lambda expanded: calls.append(('expanded', expanded)),
                                      open_viewer=lambda **kwargs: calls.append(('legacy-view', kwargs)))
        action = function('desktop/panel.py', 'open_settings', {'sys': sys}, class_name='Panel')
        action(panel)
        self.assertEqual(calls, [('expanded', True)])

    def test_footer_explains_configuration_without_unavailable_viewer_buttons(self):
        labels, buttons = [], []
        class Widget:
            def add_css_class(self, _name): pass
            def append(self, _child): pass
            def connect(self, *_args): pass
            def set_selectable(self, _value): pass
        def label(**kwargs):
            labels.append(kwargs.get('label', ''))
            return Widget()
        def button(**kwargs):
            buttons.append(kwargs.get('label', ''))
            return Widget()
        gtk = types.SimpleNamespace(Box=lambda **_kwargs: Widget(), Label=label, Button=button,
                                    Orientation=types.SimpleNamespace(HORIZONTAL=0))
        action = function('desktop/panel.py', 'footer', {'Gtk': gtk}, class_name='Panel')
        action(types.SimpleNamespace())
        self.assertEqual(buttons, [])
        self.assertIn('sbar-orbit config', ' '.join(labels))

    def test_new_panel_never_sends_browser_commands_to_an_old_panel(self):
        for flag, expected in [('--sessions', 'native-sessions'), ('--settings', 'native-settings-notice')]:
            with self.subTest(flag=flag):
                messages = []
                action = function('desktop/panel.py', 'main', {
                    'load_settings': lambda: {},
                    'sys': types.SimpleNamespace(argv=['panel.py', flag], stderr=sys.stderr),
                    'claim_the_mark': lambda message: (messages.append(message) or None, 'handed'),
                })
                self.assertEqual(action(), 0)
                self.assertEqual(messages, [expected])

    def test_native_panel_handles_native_requests_and_safe_incoming_legacy_request(self):
        for message, expected in [(b'native-sessions', 'sessions'), (b'native-settings-notice', 'settings'),
                                  (b'viewer', 'sessions')]:
            with self.subTest(message=message):
                callbacks, actions = [], []
                glib = types.SimpleNamespace(PRIORITY_DEFAULT=0, IOCondition=types.SimpleNamespace(IN=1),
                    idle_add=lambda action: action(),
                    unix_fd_add_full=lambda *_args: callbacks.append(_args[-1]))
                panel = types.SimpleNamespace(
                    listener=types.SimpleNamespace(recv=lambda _bound: message, fileno=lambda: 42),
                    open_viewer=lambda: actions.append('sessions'), open_settings=lambda: actions.append('settings'))
                action = function('desktop/panel.py', 'listen_for_commands', {'GLib': glib, 'GLibUnix': None}, class_name='Panel')
                action(panel)
                self.assertEqual(len(callbacks), 1)
                self.assertTrue(callbacks[0](42, 1))
                self.assertEqual(actions, [expected])

    def test_shell_action_launches_native_panel_without_broker_or_url(self):
        calls = []
        def popen(argv, **kwargs):
            calls.append((argv, kwargs))
        def rpc(*_args):
            calls.append(('browser-rpc', {}))
            return {'url': 'http://127.0.0.1:12345/#fixture', 'opened': False}
        action = function('desktop/orbit-stream.py', 'open_viewer', {
            '__file__': str(ROOT / 'desktop/orbit-stream.py'), 'Path': Path, 'sys': sys,
            'os': types.SimpleNamespace(environ={'FIXTURE': 'preserved'}), 'rpc': rpc,
            'viewer_link_is_local': lambda _url: True,
            'subprocess': types.SimpleNamespace(Popen=popen, DEVNULL=-3),
        })
        with patch.dict(sys.modules, {'orbit_settings': types.SimpleNamespace(load=lambda: ({}, []))}):
            self.assertEqual(action('/tmp/fixture-broker.sock'), 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], [sys.executable, str(ROOT / 'desktop/panel.py'), '--sessions'])
        self.assertEqual(calls[0][1]['env'], {'FIXTURE': 'preserved', 'ORBIT_SOCKET': '/tmp/fixture-broker.sock'})


class NativePanelRuntimeTests(unittest.TestCase):
    def bootstrap(self, runtime, environment):
        path = ROOT / 'desktop/panel.py'
        tree = ast.parse(path.read_text(encoding='utf-8'))
        selection = next(node for node in tree.body if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Name) and target.id == 'LAYER_SHELL_LIBRARY' for target in node.targets))
        preload = next(node for node in tree.body if isinstance(node, ast.If)
                       and 'ORBIT_PANEL_PRELOADED' in ast.unparse(node.test))
        gi_import = next(node for node in tree.body if isinstance(node, ast.Import)
                         and any(alias.name == 'gi' for alias in node.names))
        self.assertLess(preload.lineno, gi_import.lineno)
        calls = []
        values = dict(environment)
        os_fixture = types.SimpleNamespace(environ=values,
            path=types.SimpleNamespace(exists=lambda name: name == runtime, isfile=lambda name: name == runtime,
                                      join=lambda *parts: '/'.join(parts)),
            execv=lambda *args: calls.append(args))
        scope = {'os': os_fixture, 'sys': types.SimpleNamespace(executable='/owned/python3', argv=['panel.py'])}
        exec(compile(ast.Module(body=[selection, preload], type_ignores=[]), str(path), 'exec'), scope)
        return scope['LAYER_SHELL_LIBRARY'], values, calls

    def test_versioned_runtime_preloads_before_gtk_without_development_package(self):
        for directory in ['/usr/lib64', '/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu']:
            with self.subTest(directory=directory):
                runtime = directory + '/libgtk4-layer-shell.so.0'
                selected, values, calls = self.bootstrap(runtime, {'LD_PRELOAD': '/owned/existing.so'})
                self.assertEqual(selected, runtime)
                self.assertEqual(values['LD_PRELOAD'], runtime + ':/owned/existing.so')
                self.assertEqual(values['ORBIT_PANEL_PRELOADED'], '1')
                self.assertEqual(calls, [('/owned/python3', ['/owned/python3', 'panel.py'])])

    def test_runtime_preload_does_not_duplicate_or_loop(self):
        runtime = '/usr/lib64/libgtk4-layer-shell.so.0'
        selected, values, calls = self.bootstrap(runtime, {'LD_PRELOAD': runtime})
        self.assertEqual(selected, runtime)
        self.assertEqual(values['LD_PRELOAD'], runtime)
        self.assertEqual(len(calls), 1)
        selected, values, calls = self.bootstrap(runtime, {'LD_PRELOAD': runtime, 'ORBIT_PANEL_PRELOADED': '1'})
        self.assertEqual(selected, runtime)
        self.assertEqual(values['LD_PRELOAD'], runtime)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
