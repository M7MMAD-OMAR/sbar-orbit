#!/usr/bin/env python3
"""Run collector identity contracts with simulated IO and stdin source only."""
import ast
import copy
import json
import re
import sys
from types import SimpleNamespace

ROOT, WORKER, BROWSER = 99, 170, 171
EXE = '/fixture/chrome'
WITNESS = {
    'pid': BROWSER, 'parent': WORKER, 'start': '2000',
    'workerPid': WORKER, 'cdpPid': BROWSER, 'executable': EXE,
    'source': 'owned-browser-cdp', 'browserVersion': 'fixture-only',
    'ancestry': [
        {'pid': BROWSER, 'parent': WORKER, 'start': '2000'},
        {'pid': WORKER, 'parent': ROOT, 'start': '1000'},
    ],
    'ownerPath': '/fixture/owner.json', 'ownerPid': BROWSER,
}


def collector_helpers(collector):
    parsed = ast.parse(collector)
    helpers = [node for node in parsed.body if isinstance(node, ast.FunctionDef)
               and node.name in ('census', 'validate_browser')]
    if sorted(node.name for node in helpers) != ['census', 'validate_browser']:
        raise RuntimeError('Expected exactly census and validate_browser')
    expected_args = {'census': [], 'validate_browser': ['processes']}
    for node in helpers:
        if node.decorator_list or node.returns or node.args.defaults or node.args.kw_defaults or node.args.posonlyargs or node.args.kwonlyargs or node.args.vararg or node.args.kwarg:
            raise RuntimeError('Collector function signature changed')
        if [arg.arg for arg in node.args.args] != expected_args[node.name]:
            raise RuntimeError('Collector function argument anchor changed')
        for held in ast.walk(node):
            if isinstance(held, (ast.Import, ast.ImportFrom)):
                raise RuntimeError('Import forbidden in extracted helpers')
            if isinstance(held, ast.Name) and (held.id.startswith('__') or held.id in {'open', 'exec', 'eval', 'compile', 'globals', 'locals', 'getattr', 'setattr', 'vars', 'input', 'breakpoint'}):
                raise RuntimeError('Unsafe helper name: ' + held.id)
            if isinstance(held, ast.Attribute) and held.attr.startswith('__'):
                raise RuntimeError('Dunder helper attribute forbidden')
    module = ast.Module(body=helpers, type_ignores=[])
    return compile(ast.fix_missing_locations(module), '<AST-only collector helpers>', 'exec')


class Simulation:
    def __init__(self, code):
        self.witness = copy.deepcopy(WITNESS)
        self.owner = {'pid': BROWSER}
        self.writes = {}
        self.records = {
            ROOT: {'state': 'S', 'parent': 1, 'start': '900', 'rss': 8},
            WORKER: {'state': 'S', 'parent': ROOT, 'start': '1000', 'rss': 16},
            BROWSER: {'state': 'S', 'parent': WORKER, 'start': '2000', 'rss': 32},
        }
        self.argv = [EXE, '--headless=new']
        self.executable = EXE
        self.unreadable = set()
        self.validation_stat = None
        self.validation_cmdline_missing = False
        self.cmdline_reads = 0
        self.read_counts = {}
        sim = self

        class FakePath:
            def __init__(self, path):
                self.path = str(path)

            def __truediv__(self, name):
                return FakePath(self.path + '/' + name)

            def with_name(self, name):
                return FakePath('/fixture/' + name)

            def exists(self):
                return self.path == '/fixture/browser.json' and sim.witness is not None

            def read_text(self):
                if self.path in sim.unreadable:
                    raise PermissionError('simulated unreadable: ' + self.path)
                if self.path == '/fixture/browser.json':
                    return json.dumps(sim.witness)
                if self.path == '/fixture/owner.json':
                    return json.dumps(sim.owner)
                match = re.fullmatch(r'/proc/(\d+)/(stat|cgroup|task/\d+/children)', self.path)
                if not match:
                    raise FileNotFoundError('simulated absent: ' + self.path)
                pid, kind = int(match[1]), match[2]
                if pid not in sim.records:
                    raise FileNotFoundError('simulated absent process')
                record = sim.records[pid]
                if kind == 'cgroup':
                    return 'fixture-budget\n'
                if kind.endswith('children'):
                    return ' '.join(str(held) for held, row in sim.records.items() if row['parent'] == pid)
                count = sim.read_counts.get(pid, 0) + 1
                sim.read_counts[pid] = count
                if pid == BROWSER and count > 1 and sim.validation_stat == 'missing':
                    raise FileNotFoundError('simulated stat disappears after census')
                fields = ['0'] * 22
                fields[0], fields[1], fields[19], fields[21] = record['state'], str(record['parent']), record['start'], str(record['rss'])
                if pid == BROWSER and count > 1 and sim.validation_stat:
                    fields[0] = sim.validation_stat
                return str(pid) + ' (fixture only) ' + ' '.join(fields)

            def read_bytes(self):
                if self.path in sim.unreadable:
                    raise PermissionError('simulated unreadable: ' + self.path)
                if self.path == f'/proc/{BROWSER}/cmdline' and BROWSER in sim.records:
                    sim.cmdline_reads += 1
                    if sim.cmdline_reads > 1 and sim.validation_cmdline_missing:
                        raise FileNotFoundError('simulated validation cmdline absent')
                    if sim.records[BROWSER]['state'] in ('Z', 'X'):
                        raise FileNotFoundError('simulated terminal cmdline absent')
                    return ('\0'.join(sim.argv) + '\0').encode()
                raise FileNotFoundError('simulated absent: ' + self.path)

            def iterdir(self):
                match = re.fullmatch(r'/proc/(\d+)/task', self.path)
                if not match or int(match[1]) not in sim.records:
                    raise FileNotFoundError('simulated absent task')
                return iter([FakePath(self.path + '/' + match[1])])

            def write_text(self, value):
                sim.writes[self.path] = value

        def realpath(path):
            if path in self.unreadable:
                raise PermissionError('simulated unreadable executable')
            if path == f'/proc/{BROWSER}/exe' and BROWSER in self.records and self.records[BROWSER]['state'] not in ('Z', 'X'):
                return self.executable
            return path

        allowed_builtins = {name: value for name, value in {
            'set': set, 'int': int, 'map': map, 'enumerate': enumerate,
            'isinstance': isinstance, 'len': len, 'any': any,
            'FileNotFoundError': FileNotFoundError, 'OSError': OSError,
            'ValueError': ValueError, 'TypeError': TypeError, 'KeyError': KeyError,
            'list': list,
        }.items()}
        self.env = {
            '__builtins__': allowed_builtins,
            'Path': FakePath, 'os': SimpleNamespace(path=SimpleNamespace(realpath=realpath)),
            'sys': SimpleNamespace(argv=['fixture', EXE]),
            'json': SimpleNamespace(loads=json.loads, dumps=json.dumps),
            're': SimpleNamespace(search=re.search),
            'root': ROOT, 'child': SimpleNamespace(pid=WORKER), 'page_size': 4096,
            'group': 'fixture-budget\n', 'boundary_lost': False,
            'browser_observations': {}, 'browser_commands': {},
            'browser_identity': {'status': 'invalid', 'reason': 'Missing live owned browser witness'},
            'pinned_witness': None, 'pin_observed': False,
            'witness_path': FakePath('/fixture/browser.json'), 'report': FakePath('/fixture/tree.json'),
        }
        exec(code, self.env)

    def sample(self):
        self.read_counts = {}
        self.cmdline_reads = 0
        rows = self.env['census']()
        self.env['validate_browser'](rows)
        return rows


def mutate(sim, name):
    if name in ('kernel_z_lost_second_stat', 'kernel_x_lost_second_stat', 'initial_z', 'initial_x'):
        sim.records[BROWSER]['state'] = 'X' if name in ('kernel_x_lost_second_stat', 'initial_x') else 'Z'
        sim.records[BROWSER]['rss'] = 0
        sim.validation_stat = 'missing'
    elif name in ('reuse_z', 'parent_z', 'ancestry_z', 'owner_z', 'witness_z',
                  'reuse_x', 'parent_x', 'ancestry_x', 'owner_x', 'witness_x', 'kernel_x', 'kernel_z'):
        sim.records[BROWSER]['state'] = 'X' if name.endswith('_x') else 'Z'
        category = name.rsplit('_', 1)[0]
        if category == 'reuse': sim.records[BROWSER]['start'] = '2001'
        if category == 'parent': sim.records[BROWSER]['parent'] = ROOT
        if category == 'ancestry': sim.records[WORKER]['start'] = '1001'
        if category == 'owner': sim.owner['pid'] = BROWSER + 1
        if category == 'witness': sim.witness['browserVersion'] = 'mutated'
    elif name in ('initial_missing', 'absent_after_pin', 'absent_after_pin_owner_missing', 'closed_marker_only'):
        del sim.records[BROWSER]
        if name == 'absent_after_pin_owner_missing': sim.unreadable.add('/fixture/owner.json')
        if name == 'closed_marker_only': sim.witness['closed'] = True
    elif name in ('initial_unreadable_exe', 'live_unreadable_exe'):
        sim.unreadable.add(f'/proc/{BROWSER}/exe')
    elif name in ('initial_unreadable_cmdline', 'live_unreadable_cmdline'):
        sim.unreadable.add(f'/proc/{BROWSER}/cmdline')
    elif name == 'wrong_exe': sim.executable = '/fixture/other'
    elif name == 'no_headless': sim.argv = [EXE]
    elif name == 'subprocess': sim.argv = [EXE, '--headless=new', '--type=renderer']
    elif name == 'owner_mismatch': sim.owner['pid'] = BROWSER + 1
    elif name == 'wrong_parent': sim.records[BROWSER]['parent'] = ROOT
    elif name == 'wrong_ancestry': sim.records[WORKER]['start'] = '1001'
    elif name == 'rss_zero_only':
        sim.records[BROWSER]['rss'] = 0
        sim.unreadable.add(f'/proc/{BROWSER}/cmdline')
    elif name == 'stat_reread_z_only':
        sim.validation_stat = 'Z'
        sim.validation_cmdline_missing = True
    else: raise RuntimeError('Unknown mutation: ' + name)


def main():
    code = collector_helpers(sys.stdin.read())
    initial = ['initial_z', 'initial_x', 'initial_missing', 'initial_unreadable_exe', 'initial_unreadable_cmdline',
               'wrong_exe', 'no_headless', 'subprocess', 'owner_mismatch', 'wrong_parent', 'wrong_ancestry']
    after_pin = ['kernel_z_lost_second_stat', 'kernel_x_lost_second_stat', 'kernel_z', 'kernel_x',
                 'reuse_z', 'parent_z', 'ancestry_z', 'owner_z', 'witness_z',
                 'reuse_x', 'parent_x', 'ancestry_x', 'owner_x', 'witness_x',
                 'absent_after_pin', 'absent_after_pin_owner_missing', 'closed_marker_only',
                 'live_unreadable_exe', 'live_unreadable_cmdline', 'rss_zero_only', 'stat_reread_z_only']
    results = []
    for name in initial + after_pin:
        sim = Simulation(code)
        if name in after_pin:
            sim.sample()
            if sim.env['browser_identity']['status'] != 'verified' or not sim.env['pin_observed']:
                raise RuntimeError('Fixture initial live pin failed: ' + name)
        mutate(sim, name)
        sample_error = None
        try:
            rows = sim.sample()
        except (OSError, ValueError, IndexError) as error:
            # Mirrors only the collector outer sampling catch. Preserve the exception.
            rows, sample_error = [], {'type': type(error).__name__, 'message': str(error)}
        verified = sim.env['browser_identity']['status'] == 'verified'
        # The outer sample-error case is invalid even if a prior status remains verified.
        accepted = verified and sample_error is None and bool(sim.env['browser_commands'])
        expected = name in ('kernel_z_lost_second_stat', 'kernel_x_lost_second_stat', 'kernel_z', 'kernel_x', 'absent_after_pin', 'absent_after_pin_owner_missing')
        result = {'case': name, 'expectedAccepted': expected, 'accepted': accepted,
                  'contractMatches': accepted == expected, 'sampleError': sample_error,
                  'identity': sim.env['browser_identity'], 'commands': sim.env['browser_commands'],
                  'processes': rows, 'pinObserved': sim.env['pin_observed'],
                  'kernelState': sim.records.get(BROWSER, {}).get('state')}
        if name in ('kernel_z_lost_second_stat', 'kernel_x_lost_second_stat') and accepted:
            del sim.records[BROWSER]
            sim.validation_stat = None
            sim.sample()
            result['subsequentAbsencePreserved'] = sim.env['browser_identity']['status'] == 'verified' and bool(sim.env['browser_commands'])
            result['contractMatches'] = result['contractMatches'] and result['subsequentAbsencePreserved']
        results.append(result)
    print(json.dumps({'results': results, 'contractMatches': all(row['contractMatches'] for row in results)}))
    return 0 if all(row['contractMatches'] for row in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
