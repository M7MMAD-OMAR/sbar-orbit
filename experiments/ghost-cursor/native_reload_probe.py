#!/usr/bin/python3
"""Prove prepared plugin unload and replacement on a guarded private display.

Arguments: red|green ABSOLUTE_BINARY ABSOLUTE_NEW_REPORT. Red expects the
old build to remain mapped. Green requires two exact guarded load/unload cycles.
Preparation directories are retained until the owned compositor exits.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'experiments/ghost-cursor'))
from lab import guard
from src.native.budget import require_budget
from src.native.host import inspect_host, verify_host
from src.native.plugin_owner import operate


def mappings(pid):
    entries = {}
    with Path(f'/proc/{pid}/maps').open('rb') as stream:
        data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise RuntimeError('Compositor mappings exceeded the inspection bound')
    for line in data.decode().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) == 6 and (Path(fields[5]).name == 'plugin.so' or 'ghostinput' in Path(fields[5]).name):
            entries[fields[5]] = {'device': fields[3], 'inode': int(fields[4])}
    return entries


def main():
    guard(os.environ)
    require_budget()
    mode, binary_name, report_name = sys.argv[1:]
    assert mode in ('red', 'green')
    binary = Path(binary_name).resolve(strict=True)
    report_path = Path(report_name)
    assert report_path.is_absolute() and not report_path.exists()
    plan = inspect_host(os.environ)
    source = ROOT / 'experiments/ghost-cursor/plugin/ghostinput.cpp'
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    assert Path(str(binary) + '.source.sha256').read_text().split()[0] == source_hash
    report = {'mode': mode, 'source_sha256': source_hash,
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'compositor': plan['compositor'], 'owner_activation': 'not performed',
              'operations': [], 'preparations': [], 'errors': [], 'complete': False}
    loaded = None
    failures = []
    try:
        assert mappings(plan['compositor'][0]) == {}
        for index in range(1 if mode == 'red' else 2):
            directory = Path(tempfile.mkdtemp(prefix='orbit-reload-prepared-', dir='/tmp'))
            report['preparations'].append(str(directory))
            manifest = report_path.parent / f'{report_path.stem}-manifest-{index}.json'
            with manifest.open('x') as stream:
                json.dump({'schema': 1, 'source': str(source), 'binary': str(binary),
                           'source_sha256': source_hash, 'binary_sha256': report['binary_sha256'],
                           **{key: plan[key] for key in ('abi_hash', 'commit', 'version')}}, stream)
            manifest.chmod(0o600)
            result = subprocess.run([shutil.which('bun'), str(ROOT / 'src/cli.ts'), 'native-prepare',
                                     str(directory), '--plugin-manifest', str(manifest)],
                                    capture_output=True, text=True, timeout=25)
            report[f'prepare_{index}'] = {'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
            assert result.returncode == 0
            reply = json.loads(result.stdout)
            assert reply['ok'] and reply['result']['prepared'] and reply['result']['mode'] == 'protected'
            loaded = directory
            report['load_attempted'] = True
            report['operations'].append({'operation': 'load', 'result': operate('load', str(directory))})
            assert report['operations'][-1]['result']['loaded']
            current_maps = mappings(plan['compositor'][0])
            assert set(current_maps) == {str(directory / 'plugin.so')}
            report['operations'].append({'operation': 'status', 'result': operate('status', str(directory))})
            assert report['operations'][-1]['result']['loaded']
            report['operations'].append({'operation': 'unload', 'result': operate('unload', str(directory))})
            loaded = None
            assert not report['operations'][-1]['result']['loaded']
            remaining = mappings(plan['compositor'][0])
            report[f'mappings_after_unload_{index}'] = remaining
            if mode == 'red':
                assert set(remaining) == {str(directory / 'plugin.so')}, 'Old build did not reproduce retained mapping'
            else:
                assert remaining == {}, 'Fixed plugin remained mapped after guarded unload'
                report['operations'].append({'operation': 'status-after-unload', 'result': operate('status', str(directory))})
                assert not report['operations'][-1]['result']['loaded']
        verify_host(plan)
        report['complete'] = True
    except BaseException as error:
        failures.append(error)
        report['errors'].append(repr(error))
    finally:
        if loaded is not None:
            try:
                report['cleanup_unload_attempted'] = True
                report['cleanup_unload'] = operate('unload', str(loaded))
            except BaseException as error:
                failures.append(error)
                report['errors'].append('Cleanup unload: ' + repr(error))
            report['complete'] = False
        try:
            report_path.write_text(json.dumps(report, indent=2) + '\n')
        except BaseException as error:
            failures.append(error)
            report['errors'].append('Report retention: ' + repr(error))
            report['complete'] = False
            try:
                print(json.dumps(report), file=sys.stderr, flush=True)
            except BaseException as fallback:
                failures.append(fallback)
        else:
            print(str(report_path))
    if not report['complete']:
        interruption = next((error for error in failures if isinstance(error, KeyboardInterrupt)), None)
        if interruption is not None:
            other = [error for error in failures if error is not interruption]
            if other:
                raise interruption from BaseExceptionGroup('Private loader cleanup failures', other)
            raise interruption
        if failures:
            raise BaseExceptionGroup('Private prepared loader proof or cleanup failed', failures)
        raise RuntimeError('Private prepared loader proof failed; see retained report')


if __name__ == "__main__":
    main()
