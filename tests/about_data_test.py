import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('about_data', Path(__file__).resolve().parents[1] / 'desktop' / 'about_data.py')
about = importlib.util.module_from_spec(spec)
spec.loader.exec_module(about)

ABI = 'abi-one'
SOURCE = b'plugin source'
SOURCE_SHA = hashlib.sha256(SOURCE).hexdigest()


def envelope(result):
    return json.dumps({'ok': True, 'result': result})


class Fake:
    """A command table keyed by the words after the launcher, recording every call."""

    def __init__(self, table):
        self.table, self.calls = table, []

    def __call__(self, argv, timeout=30):
        words = tuple(argv[1:]) if argv[0].endswith('sbar-orbit') else tuple(argv)
        self.calls.append(words)
        for prefix, reply in self.table.items():
            if words[:len(prefix)] == prefix:
                return reply(words) if callable(reply) else reply
        return 1, ''


class Layout:
    """A throwaway install root and data home with a prepared host plan."""

    def __init__(self, test, abi=ABI):
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.root = os.path.join(directory.name, 'install')
        self.home = os.path.join(directory.name, 'data')
        plugin = os.path.join(self.root, about.PLUGIN_SOURCE)
        os.makedirs(os.path.dirname(plugin))
        Path(plugin).write_bytes(SOURCE)
        Path(self.root, 'package.json').write_text(json.dumps({'version': '1.2.3'}))
        self.prep = os.path.join(self.home, 'native', 'prep-1')
        os.makedirs(self.prep)
        Path(self.prep, 'host.json').write_text(json.dumps({'abi_hash': abi}))
        os.symlink(self.prep, os.path.join(self.home, 'native', 'current'))
        Path(self.home, 'native', 'broker-native.env').write_text(
            f'ORBIT_NATIVE_PLAN="{self.home}/native/current/host.json"\n')


def plugin_reply(source=SOURCE_SHA, abi=ABI, loaded=True):
    build = {'schema': 1, 'source_sha256': source, 'abi_hash': abi, 'live_roots': 0}
    return 0, envelope({'loaded': loaded, 'build': build} if loaded else {'loaded': False})


class PluginStatus(unittest.TestCase):
    def state(self, reply, abi=ABI):
        layout = Layout(self, abi)
        return about.plugin_status(Fake({('native-plugin', 'status'): reply}), layout.root, layout.home)

    def test_match(self):
        result = self.state(plugin_reply())
        self.assertEqual(result['state'], 'match')
        self.assertEqual(result['installedSource'], SOURCE_SHA[:12])
        self.assertEqual(result['directory'], os.path.realpath(result['directory']))

    def test_source_mismatch_is_the_incompatible_case(self):
        result = self.state(plugin_reply(source='c' * 64))
        self.assertEqual(result['state'], 'source_mismatch')
        self.assertEqual(result['loadedSource'], 'c' * 12)
        self.assertNotEqual(result['loadedSource'], result['installedSource'])

    def test_abi_is_checked_before_source(self):
        self.assertEqual(self.state(plugin_reply(source='c' * 64, abi='other'))['state'], 'abi_mismatch')

    def test_not_loaded(self):
        self.assertEqual(self.state(plugin_reply(loaded=False))['state'], 'not_loaded')

    def test_unanswered_is_unknown_not_a_guess(self):
        self.assertEqual(self.state((1, ''))['state'], 'unknown')

    def test_not_prepared_without_an_env_file(self):
        layout = Layout(self)
        os.remove(os.path.join(layout.home, 'native', 'broker-native.env'))
        self.assertEqual(about.plugin_status(Fake({}), layout.root, layout.home)['state'], 'not_prepared')


DOCTOR = (0, envelope({'version': '1.2.3', 'units': {'managed': True, 'drifted': [], 'missing': [], 'current': True}}))
SYSTEMD = (0, 'MainPID=77\nActiveState=active\n')


def base_table(extra=None):
    return {('doctor',): DOCTOR, ('systemctl',): SYSTEMD, ('ps',): (0, ' 3725\n'),
            ('status',): (0, json.dumps({'sessions': []})),
            ('update', 'status'): (0, json.dumps({'managed': True, 'pending': [], 'prepared': [], 'current': '1.2.3'})),
            **(extra or {})}


class Collect(unittest.TestCase):
    def test_everything_in_one_dict(self):
        layout = Layout(self)
        table = base_table({('native-plugin', 'status'): plugin_reply()})
        data = about.collect(Fake(table), layout.root, layout.home)
        self.assertEqual(data['version'], '1.2.3')
        self.assertEqual(data['brokerVersion'], '1.2.3')
        self.assertTrue(data['broker']['healthy'])
        self.assertEqual(data['broker']['uptimeSeconds'], 3725)
        self.assertEqual(data['plugin']['state'], 'match')
        self.assertTrue(data['update']['managed'])

    def test_unreachable_broker_reports_no_uptime_and_not_healthy(self):
        layout = Layout(self)
        table = {key: value for key, value in base_table().items() if key != ('doctor',)}
        data = about.collect(Fake(table), layout.root, layout.home)
        self.assertFalse(data['broker']['reachable'])
        self.assertFalse(data['broker']['healthy'])
        self.assertIsNone(data['broker']['uptimeSeconds'])

    def test_drifted_units_are_unhealthy(self):
        layout = Layout(self)
        drifted = (0, envelope({'version': '1.2.3', 'units': {'managed': True, 'drifted': ['x'], 'missing': [], 'current': False}}))
        data = about.collect(Fake(base_table({('doctor',): drifted})), layout.root, layout.home)
        self.assertFalse(data['broker']['healthy'])

    def test_active_count_counts_working_sessions_only(self):
        layout = Layout(self)
        listing = [{'sessionId': 'a', 'state': 'running', 'activity': {'state': 'working'}},
                   {'sessionId': 'b', 'state': 'running'},
                   {'sessionId': 'c', 'state': 'closed'}]
        data = about.collect(Fake(base_table({('status',): (0, json.dumps({'sessions': listing}))})), layout.root, layout.home)
        self.assertEqual([row['id'] for row in data['sessions']], ['a', 'b'])
        self.assertEqual(data['activeSessions'], 1)


class UpdateCheck(unittest.TestCase):
    def check(self, found):
        return about.check_for_update(Fake({('update', 'check'): (0, json.dumps(found))}))

    def test_available(self):
        result = self.check({'current': '1.0.0', 'latest': '1.1.0', 'eligible': {'version': '1.1.0'}, 'reason': 'x'})
        self.assertEqual((result['state'], result['eligible']), ('available', '1.1.0'))

    def test_newer_but_still_maturing_is_current_and_says_waiting(self):
        result = self.check({'current': '1.0.0', 'latest': '1.1.0', 'eligible': None, 'reason': 'published 2 hours ago'})
        self.assertEqual((result['state'], result['waiting']), ('current', True))

    def test_offline_is_unknown(self):
        self.assertEqual(about.check_for_update(Fake({}))['state'], 'unknown')


def session(identifier, working=False, state='running'):
    return {'sessionId': identifier, 'state': state, 'agentName': 'agent', 'taskName': 'task',
            'activity': {'state': 'working' if working else 'done'},
            'handoff': {'workspace': 3, 'windows': [{'title': 'Calculator'}]}}


class UpdateNow(unittest.TestCase):
    def table(self, sessions, managed=True, activate=None, stage=None, eligible='1.1.0'):
        found = {'current': '1.0.0', 'latest': eligible, 'eligible': {'version': eligible} if eligible else None, 'reason': 'ok'}
        return {
            ('update', 'status'): (0, json.dumps({'managed': managed, 'reason': 'git checkout', 'pending': []})),
            ('update', 'check'): (0, json.dumps(found)),
            ('update', 'stage'): stage or (0, json.dumps({'prepared': True, 'version': eligible})),
            ('update', 'activate'): activate or (0, json.dumps({'activated': True, 'version': eligible, 'previous': '1.0.0'})),
            ('session', 'list'): (0, envelope(sessions)),
        }

    def run_update(self, table):
        fake = Fake(table)
        return about.update_now(fake), fake.calls

    def test_unmanaged_touches_nothing(self):
        result, calls = self.run_update(self.table([], managed=False))
        self.assertEqual(result['state'], 'unmanaged')
        self.assertNotIn(('update', 'stage'), calls)

    def test_updates_when_idle(self):
        result, calls = self.run_update(self.table([session('a', state='closed')]))
        self.assertEqual((result['state'], result['version']), ('updated', '1.1.0'))
        self.assertIn(('update', 'activate', '1.1.0'), calls)

    def test_blocked_by_open_sessions_never_activates(self):
        result, calls = self.run_update(self.table([session('a', working=True), session('b'), session('c', state='closed')]))
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual([row['id'] for row in result['blockers']], ['a', 'b'])
        self.assertIn(('update', 'stage'), calls)
        self.assertFalse([call for call in calls if call[:2] == ('update', 'activate')])

    def test_a_refusal_after_the_check_is_blocked_too(self):
        listings = iter([[], [session('late')]])
        table = self.table([], activate=(1, json.dumps({'activated': False, 'reason': 'a session is open', 'openSessions': 1})))
        table[('session', 'list')] = lambda words: (0, envelope(next(listings)))
        result, _ = self.run_update(table)
        self.assertEqual((result['state'], [row['id'] for row in result['blockers']]), ('blocked', ['late']))

    def test_current_when_nothing_newer(self):
        result, calls = self.run_update(self.table([], eligible=None))
        self.assertEqual(result['state'], 'current')
        self.assertNotIn(('update', 'stage'), calls)

    def test_stage_failure_is_reported(self):
        result, _ = self.run_update(self.table([], stage=(1, json.dumps({'prepared': False, 'reason': 'integrity mismatch'}))))
        self.assertEqual((result['state'], result['reason']), ('failed', 'integrity mismatch'))

    def test_rollback_is_a_failure_not_a_success(self):
        outcome = {'activated': False, 'rolledBack': True, 'reason': 'new broker did not answer'}
        result, _ = self.run_update(self.table([], activate=(1, json.dumps(outcome))))
        self.assertEqual((result['state'], result['rolledBack']), ('failed', True))


class StopIdle(unittest.TestCase):
    def test_working_sessions_are_never_stopped(self):
        fake = Fake({('session', 'stop'): (0, '{}')})
        rows = about.session_rows([session('idle'), session('busy', working=True)])
        stopped, left = about.stop_idle(rows, fake)
        self.assertEqual((stopped, left), (['idle'], ['busy']))
        self.assertEqual(fake.calls, [('session', 'stop', 'idle')])

    def test_a_failed_stop_is_left_not_claimed(self):
        stopped, left = about.stop_idle(about.session_rows([session('x')]), Fake({('session', 'stop'): (1, '')}))
        self.assertEqual((stopped, left), ([], ['x']))


if __name__ == '__main__':
    unittest.main()
