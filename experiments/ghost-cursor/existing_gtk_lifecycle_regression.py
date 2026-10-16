#!/usr/bin/python3
"""Exercise plugin load, failed initialization and unload in the QEMU lab only.

The manifest pins one real candidate and two explicit fault-injection builds.
This never calls the owner control path or changes its release hold. Fault
builds must not claim applications. Kernel mappings and existing GTK clients
are observed after each operation, without restarting the compositor.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import time
from types import SimpleNamespace

import existing_gtk_regression as native
from lab import recorded_members, process_record
from src.native.mapping import kernel_file_identity
from src.native.plugin_bundle import fingerprint
from src.native.plugin_owner import mapped_identity


def pinned_file(name, limit):
    path = Path(name)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('Artifact must be a bounded canonical owned file')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(descriptor, 'rb') as retained:
        metadata = os.fstat(retained.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022 or metadata.st_size > limit):
            raise ValueError('Artifact must be a bounded canonical owned file')
        data = retained.read(limit + 1)
        if (len(data) != metadata.st_size or fingerprint(metadata) != fingerprint(os.fstat(retained.fileno()))
                or fingerprint(metadata) != fingerprint(path.lstat())):
            raise ValueError('Artifact changed while it was inspected')
    return path, metadata, data


def run(manifest_name):
    native.private_guest()
    manifest_path, _, raw = pinned_file(manifest_name, 65536)
    manifest = json.loads(raw)
    if set(manifest) != {'schema', 'artifacts'} or manifest['schema'] != 1:
        raise ValueError('Unknown lifecycle manifest')
    artifacts = {}
    for entry in manifest['artifacts']:
        if set(entry) != {'role', 'binary', 'source', 'binary_sha256', 'source_sha256'}:
            raise ValueError('Unknown lifecycle artifact fields')
        role = entry['role']
        if role not in ('candidate', 'hook-failure', 'observer-failure') or role in artifacts:
            raise ValueError('Unknown or repeated lifecycle role')
        source, _, source_data = pinned_file(entry['source'], 1048576)
        binary, identity, binary_data = pinned_file(entry['binary'], 33554432)
        if (hashlib.sha256(source_data).hexdigest() != entry['source_sha256']
                or hashlib.sha256(binary_data).hexdigest() != entry['binary_sha256']
                or binary_data[:7] != b'\x7fELF\x02\x01\x01'):
            raise ValueError('Lifecycle artifact differs from its pin')
        descriptor = os.open(binary, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if fingerprint(os.fstat(descriptor)) != fingerprint(identity):
                raise ValueError('Artifact changed before deriving its kernel identity')
            mapping_identity = kernel_file_identity(descriptor)
            if fingerprint(os.fstat(descriptor)) != fingerprint(identity):
                raise ValueError('Artifact changed while deriving its kernel identity')
        finally:
            os.close(descriptor)
        artifacts[role] = dict(entry, path=binary, identity=identity, mapping_identity=mapping_identity)
    if set(artifacts) != {'candidate', 'hook-failure', 'observer-failure'}:
        raise ValueError('Lifecycle manifest requires all three explicit roles')
    source = Path(native.__file__).with_name('plugin') / 'ghostinput.cpp'
    if hashlib.sha256(source.read_bytes()).hexdigest() != artifacts['candidate']['source_sha256']:
        raise ValueError('Candidate must match current plugin source')
    lab = Path(os.environ['XDG_RUNTIME_DIR']).parent
    compositors = [pid for pid in recorded_members(lab)
                   if Path(f'/proc/{pid}/exe').resolve().name == 'Hyprland']
    if len(compositors) != 1:
        raise RuntimeError('Exactly one recorded private compositor is required')
    pid = compositors[0]
    compositor = process_record(pid)
    report = {'schema': 1, 'measurement_complete': False, 'checks': [], 'operations': [],
              'scope': 'load lifecycle on one disposable QEMU GTK3 private display',
              'owner_handoff_release_hold': 'unchanged', 'fault_build_application_claims': 'never performed',
              'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'fixture_sha256': hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
              'mapping_helper_sha256': hashlib.sha256(Path(native.__file__).parents[2].joinpath('src/native/mapping.py').read_bytes()).hexdigest(),
              'manifest_sha256': hashlib.sha256(raw).hexdigest(), 'manifest': str(manifest_path),
              'compositor': compositor,
              'compositor_sha256': hashlib.sha256(Path(f'/proc/{pid}/exe').read_bytes()).hexdigest(),
              'artifacts': manifest['artifacts'], 'cleanup_errors': []}
    clients = []
    loaded = None

    def mappings(artifact):
        if process_record(pid) != compositor:
            raise RuntimeError('Private compositor identity changed')
        data = Path(f'/proc/{pid}/maps').read_bytes()
        if len(data) > 8388608:
            raise RuntimeError('Compositor mappings exceeded inspection bound')
        found = []
        for line in data.decode().splitlines():
            fields = line.split(maxsplit=5)
            major, minor = (int(value, 16) for value in fields[3].split(':'))
            if (os.makedev(major, minor), int(fields[4])) == artifact['mapping_identity']:
                found.append(line)
        return found

    def loader(artifact, operation):
        native.private_guest()
        path, identity, data = pinned_file(artifact['binary'], 33554432)
        _, _, code = pinned_file(artifact['source'], 1048576)
        expected = artifact['identity']
        if ((identity.st_dev, identity.st_ino) != (expected.st_dev, expected.st_ino)
                or hashlib.sha256(data).hexdigest() != artifact['binary_sha256']
                or hashlib.sha256(code).hexdigest() != artifact['source_sha256']):
            raise RuntimeError('Lifecycle artifact changed before loader operation')
        command = 'plugin ' + operation + ' ' + str(artifact['path'])
        reply = native.exchange(command)
        report['operations'].append({'role': artifact['role'], 'operation': operation,
                                     'reply': reply, 'mappings': mappings(artifact),
                                     'file_identity': {'major': os.major(expected.st_dev),
                                                       'minor': os.minor(expected.st_dev), 'inode': expected.st_ino},
                                     'expected_mapping': {'major': os.major(artifact['mapping_identity'][0]),
                                                          'minor': os.minor(artifact['mapping_identity'][0]),
                                                          'inode': artifact['mapping_identity'][1]},
                                     'path_mappings': [line for line in Path(f'/proc/{pid}/maps').read_text().splitlines()
                                                       if str(path) in line]})
        return reply

    try:
        if native.query('plugin list'):
            raise RuntimeError('Lifecycle test requires an empty private plugin list')
        for role in ('target', 'standin'):
            client = native.Client(role)
            clients.append(client)
            native.wait(client.window, 'Existing lifecycle GTK client did not map')
        target, person = clients
        native.okay('dispatch movetoworkspacesilent 2,address:' + target.window()['address'])
        native.okay('dispatch focuswindow address:' + person.window()['address'])
        time.sleep(1)
        for client in clients:
            client.sync()
        states = [client.state() for client in clients]
        windows = [client.window() for client in clients]
        event_positions, modifier_baselines = [], []
        for client in clients:
            with client.lock:
                event_positions.append(len(client.events))
                modifiers = [native.modifier_state(event[2]) for event in client.events
                             if event[:2] == ['wl_keyboard', 'modifiers']]
            if not modifiers:
                raise AssertionError('Lifecycle client has no keyboard baseline')
            modifier_baselines.append(modifiers[-1])
        view = {'focus': native.query('activewindow').get('address'),
                'workspace': native.query('activeworkspace'), 'pointer': native.query('cursorpos')}

        def unchanged(label):
            for client in clients:
                client.sync()
            observations = []
            for index, client in enumerate(clients):
                with client.lock:
                    events = client.events[event_positions[index]:]
                    event_positions[index] = len(client.events)
                observations.append({'client': index, 'events': events,
                                     'violations': native.standin_violations(events, modifier_baselines[index])})
            report.setdefault('observations', []).append({'phase': label, 'clients': observations})
            if any(value['violations'] for value in observations):
                raise AssertionError('Existing client received input or focus events: ' + label)
            if [client.state() for client in clients] != states:
                raise AssertionError('Existing client state changed: ' + label)
            current = {'focus': native.query('activewindow').get('address'),
                       'workspace': native.query('activeworkspace'), 'pointer': native.query('cursorpos')}
            if current != view:
                raise AssertionError('Shared guest state changed: ' + label)
            for old, client in zip(windows, clients):
                current = client.window()
                if any(current[key] != old[key] for key in ('address', 'stableId', 'pid', 'workspace', 'at', 'size')):
                    raise AssertionError('Existing window identity or geometry changed: ' + label)
            if process_record(pid) != compositor:
                raise AssertionError('Compositor restarted: ' + label)

        for role in ('hook-failure', 'observer-failure'):
            artifact = artifacts[role]
            loaded = artifact
            reply = loader(artifact, 'load')
            if reply == 'ok' or native.query('plugin list') or mappings(artifact):
                raise AssertionError('Failed initialization retained a plugin or mapping: ' + role)
            loaded = None
            expected = ('missing application lifecycle ABI: Desktop::View::CPopup::missingLifecycleProbeMap'
                        if role == 'hook-failure' else '[ghostinput] cannot install selection request observer')
            if expected not in reply:
                raise AssertionError('Load did not reach the required fault point: ' + role)
            unchanged(role)
            report['checks'].append(role + ' refused and ejected without replacing existing clients or compositor')

        candidate = artifacts['candidate']
        for cycle in range(2):
            loaded = candidate
            if loader(candidate, 'load') != 'ok' or not mappings(candidate):
                raise AssertionError('Exact candidate did not load')
            build = json.loads(native.exchange('ghost-build-info'))
            if build['source_sha256'] != candidate['source_sha256']:
                raise AssertionError('Loaded candidate reported another source')
            directory = os.open(candidate['path'].parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                def verify_candidate():
                    _, metadata, data = pinned_file(candidate['binary'], 33554432)
                    if (fingerprint(metadata) != fingerprint(candidate['identity'])
                            or hashlib.sha256(data).hexdigest() != candidate['binary_sha256']):
                        raise RuntimeError('Prepared candidate changed during mapping proof')

                bundle = SimpleNamespace(plan={'compositor': [pid]}, fd=directory,
                                         artifact={'path': str(candidate['path']),
                                                   'file_identity': [str(value) for value in fingerprint(candidate['identity'])]},
                                         verify=verify_candidate)
                mapped_identity(bundle)
            finally:
                os.close(directory)
            report['operations'].append({'operation': 'production-kernel-binding', 'cycle': cycle + 1,
                                         'source_sha256': hashlib.sha256(Path(native.__file__).parents[2].joinpath('src/native/plugin_owner.py').read_bytes()).hexdigest()})
            unchanged('load ' + str(cycle))
            native.okay('ghost-admission pause')
            if not json.loads(native.exchange('ghost-unload-info'))['ready']:
                raise AssertionError('Empty paused candidate is not ready for unload')
            if loader(candidate, 'unload') != 'ok' or native.query('plugin list') or mappings(candidate):
                raise AssertionError('Candidate remained loaded or mapped after unload')
            loaded = None
            unchanged('unload ' + str(cycle))
            report['checks'].append('candidate load/unload cycle ' + str(cycle + 1) + ' retained existing clients and unmapped exact DSO')
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        if loaded is not None:
            try:
                loader(loaded, 'unload')
            except (Exception, SystemExit) as error:
                report['cleanup_errors'].append('unload: ' + str(error))
        for client in clients:
            try:
                client.stop()
            except Exception as error:
                report['cleanup_errors'].append('client: ' + str(error))
        if report['cleanup_errors']:
            report['measurement_complete'] = False
        print(json.dumps(report, indent=2), flush=True)
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    raise SystemExit(run(parser.parse_args().manifest))
