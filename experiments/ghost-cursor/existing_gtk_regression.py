#!/usr/bin/python3
"""Opt-in existing-client probe for a disposable VM's guarded private compositor lab only.

Prepare the VM with /var/tmp/orbit-provisioned and load the candidate plugin in
its lab. Run: lab.py run LAB -- /usr/bin/python3 existing_gtk_regression.py --run
This uses internal plugin IPC, never the public owner-handoff path or its hold.
Output is JSON evidence, not a release approval or an old-crash reproduction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid

from lab import guard

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.host import HostError, deadline_timeout
from src.native.keyboard import KEYBOARD_ACTIONS, prepared_input


def private_guest():
    guard(os.environ)
    require_budget()
    if sys.flags.optimize:
        raise SystemExit('Regression assertions require Python optimization to be disabled')
    if not Path('/var/tmp/orbit-provisioned').is_file():
        raise SystemExit('Existing-client probe requires the disposable guest provision marker')
    result = subprocess.run(['systemd-detect-virt', '--vm'], capture_output=True, text=True,
                            timeout=3, check=False)
    if result.returncode or result.stdout.strip() not in ('kvm', 'qemu'):
        raise SystemExit('Existing-client probe requires a disposable QEMU guest')


def raw_exchange(command, deadline=None):
    guard(os.environ)
    deadline = time.monotonic() + 5 if deadline is None else deadline
    signature = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE', '')
    if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}', signature):
        raise RuntimeError('Invalid private compositor identity')
    endpoint = Path(os.environ['XDG_RUNTIME_DIR']) / 'hypr' / signature / '.socket.sock'
    metadata = endpoint.lstat()
    if endpoint.resolve() != endpoint or not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise RuntimeError('Noncanonical or foreign private compositor socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(deadline_timeout(deadline))
        connection.connect(str(endpoint))
        connection.settimeout(deadline_timeout(deadline))
        connection.sendall(command.encode())
        connection.shutdown(socket.SHUT_WR)
        chunks, size = [], 0
        while True:
            connection.settimeout(deadline_timeout(deadline))
            chunk = connection.recv(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > 1048576:
                raise RuntimeError('Compositor reply exceeds probe bound')
            chunks.append(chunk)
    return b''.join(chunks).decode().strip()


def exchange(command):
    if command.split(" ", 1)[0] in KEYBOARD_ACTIONS:
        try:
            return prepared_input(command, raw_exchange, time.monotonic() + 3).strip()
        except HostError as error:
            response = str(error)
            return response if response.startswith("refused:") else "refused: " + response
    return raw_exchange(command)


def query(command):
    return json.loads(exchange('j/' + command))


def okay(command):
    reply = exchange(command)
    if reply != 'ok' and not re.fullmatch(r'ok \(\d+ .*\)', reply):
        # Input commands also report a bounded device count in their success text.
        if not reply.startswith('ok '):
            raise AssertionError(f'{command.split()[0]} failed: {reply}')
    return reply


def wait(condition, description):
    deadline = time.monotonic() + 10
    while True:
        value = condition()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(description)
        time.sleep(0.025)


def identity(pid):
    value = Path(f'/proc/{pid}/stat').read_text()
    return [pid, int(value[value.rfind(')') + 2:].split()[19])]


def fixture(role):
    private_guest()
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk, GLib
    Gtk.Settings.get_default().set_property('gtk-cursor-blink', False)
    window = Gtk.Window(title='Existing GTK regression ' + role)
    window.set_default_size(480, 160)
    entry = Gtk.Entry()
    entry.set_text('unsaved-before-lease' if role == 'target' else 'standin-private')
    entry.set_position(-1)
    window.add(entry)
    popup = {'visible': False, 'actions': 0}

    def publish(*_):
        # Gtk3 bindings normally return a pair for selected bounds and () otherwise.
        bounds = entry.get_selection_bounds()
        if len(bounds) == 2:
            begin, end = bounds
        elif len(bounds) == 3:
            _, begin, end = bounds
        else:
            begin = end = entry.get_position()
        allocation = entry.get_allocation()
        layout_x, layout_y = entry.get_layout_offsets()
        character = entry.get_layout().index_to_pos(4)
        print(json.dumps({'identity': identity(os.getpid()), 'text': entry.get_text(),
                          'caret': entry.get_position(), 'selection': [begin, end],
                          'popup_visible': popup['visible'], 'popup_actions': popup['actions'],
                          'entry': [allocation.x, allocation.y, allocation.width, allocation.height],
                          'click': [allocation.x + layout_x + character.x // 1024 + max(1, character.width // 2048),
                                    allocation.y + layout_y + character.y // 1024 + max(1, character.height // 2048)]}), flush=True)

    def populate(_, menu):
        popup['menu'] = menu
        action = Gtk.MenuItem(label='Regression action')

        def activated(*_):
            popup['actions'] += 1
            publish()

        def visibility(value):
            popup['visible'] = value
            publish()

        action.connect('activate', activated)
        menu.prepend(action)
        action.show()
        menu.connect('map', lambda *_: visibility(True))
        menu.connect('unmap', lambda *_: visibility(False))

    entry.connect('populate-popup', populate)

    def synchronize(_fd, condition):
        if condition & GLib.IO_HUP:
            return False
        command = sys.stdin.readline().strip()
        if not re.fullmatch(r'(sync|popup|dismiss) [1-9][0-9]{0,8}', command):
            raise RuntimeError('Invalid fixture synchronization command')
        if command.startswith('popup '):
            entry.emit('popup-menu')
        elif command.startswith('dismiss '):
            popup['menu'].popdown()
        Gdk.Display.get_default().sync()
        print('ORBIT_SYNC:' + command.split()[1], file=sys.stderr, flush=True)
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, synchronize)

    for event in ('changed', 'notify::cursor-position', 'notify::selection-bound', 'size-allocate'):
        entry.connect(event, publish)
    window.connect('destroy', Gtk.main_quit)
    window.show_all()
    entry.grab_focus()
    entry.set_position(0 if role == 'target' else -1)
    publish()
    Gtk.main()


class Client:
    protocol = re.compile(r'(wl_keyboard|wl_pointer|zwp_text_input_v3|wl_data_device|zwp_primary_selection_device_v1)#\d+\.(\w+)\((.*)\)')

    def __init__(self, role):
        guard(os.environ)
        self.states, self.events, self.stderr = [], [], []
        self.sync_sequence, self.sync_seen = 0, 0
        self.lock = threading.Lock()
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--fixture', role],
                                        env=dict(os.environ, WAYLAND_DEBUG='client'), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                        start_new_session=True)
        threading.Thread(target=self.read_states, daemon=True).start()
        threading.Thread(target=self.read_events, daemon=True).start()

    def read_states(self):
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except ValueError:
                continue
            with self.lock:
                self.states.append(value)

    def read_events(self):
        for line in self.process.stderr:
            with self.lock:
                self.stderr.append(line[-2000:])
                if len(self.stderr) > 100:
                    del self.stderr[0]
                if re.fullmatch(r'ORBIT_SYNC:[1-9][0-9]{0,8}\n', line):
                    self.sync_seen = int(line.split(':')[1])
                match = self.protocol.search(line)
                if match and ' -> ' not in line:
                    self.events.append(list(match.groups()))

    def state(self):
        with self.lock:
            return dict(self.states[-1]) if self.states else None

    def sync(self, command='sync'):
        """Round trip in the client and drain protocol lines through its marker."""
        if command not in ('sync', 'popup', 'dismiss'):
            raise ValueError('Invalid fixture command')
        self.sync_sequence += 1
        sequence = self.sync_sequence
        self.process.stdin.write(f'{command} {sequence}\n')
        self.process.stdin.flush()

        def drained():
            with self.lock:
                return self.sync_seen == sequence

        wait(drained, 'Fixture Wayland synchronization marker did not arrive')

    def window(self):
        windows = [window for window in query('clients') if window.get('pid') == self.process.pid]
        if len(windows) > 1:
            raise AssertionError('Fixture has more than one window')
        return windows[0] if windows and self.state() else None

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        self.process.wait(timeout=5)


def selection(primary, required=True, diagnostics=None):
    guard(os.environ)
    command = ['wl-paste', '--no-newline', '--type', 'text/plain'] + (['--primary'] if primary else [])
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=3, check=False)
    except subprocess.TimeoutExpired as error:
        if diagnostics is not None:
            diagnostics.update({'paste_status': 'timeout',
                                'paste_stderr': (error.stderr or b'').decode(errors='replace')[-2048:]})
        if required:
            raise AssertionError('Private lab selection read timed out') from error
        return None
    if diagnostics is not None:
        diagnostics.update({'paste_status': result.returncode,
                            'paste_stderr': result.stderr.decode(errors='replace')[-2048:],
                            'paste_stdout_bytes': len(result.stdout),
                            'paste_stdout_sha256': hashlib.sha256(result.stdout).hexdigest()})
    if result.returncode:
        if required:
            raise AssertionError('Private lab selection read failed')
        return None
    return result.stdout.decode()


def capture_copy_errors(process, diagnostics):
    """Drain helper stderr continuously while retaining only a bounded guest tail."""
    while chunk := process.stderr.read1(256):
        diagnostics['copy_stderr'] = (diagnostics.get('copy_stderr', '') + chunk.decode(errors='replace'))[-2048:]


def view():
    return {'focus': query('activewindow').get('address'), 'workspace': query('activeworkspace'),
            'pointer': query('cursorpos'), 'clipboard': selection(False), 'primary': selection(True)}


def modifier_state(arguments):
    fields = [field.strip() for field in arguments.split(',')]
    if len(fields) != 5 or any(not field.isdecimal() for field in fields):
        raise AssertionError('Malformed stand-in keyboard modifier event')
    # The serial is bookkeeping. All three modifier masks and the group matter.
    return tuple(int(field) for field in fields[1:])


def standin_violations(events, baseline_modifiers):
    forbidden = []
    for interface, event, arguments in events:
        if interface == 'wl_keyboard':
            if event == 'modifiers':
                if modifier_state(arguments) != baseline_modifiers:
                    forbidden.append([interface, event, arguments])
            else:
                # Includes key, keymap, repeat_info, enter and leave events.
                forbidden.append([interface, event, arguments])
        elif interface in ('wl_pointer', 'zwp_text_input_v3'):
            # Pointer frames and every axis variant count, as do text commits,
            # preedit, deletion and completion, even if the final text matches.
            forbidden.append([interface, event, arguments])
        elif event in ('selection', 'data_offer'):
            forbidden.append([interface, event, arguments])
    return forbidden


def run():
    private_guest()
    report = {'schema': 1, 'measurement_complete': False, 'checks': [],
              'scope': 'existing GTK3 client on a disposable QEMU guest private compositor lab',
              'owner_handoff_release_hold': 'unchanged', 'old_crash_reproduction': 'not measured',
              'other_clients_and_platforms': 'not measured', 'protocol_absence_cases': 'not measured',
              'cursor_visual': 'not measured; command acknowledgement only',
              'view_observation': 'before and after snapshots plus stand-in received protocol events; no continuous frame measurement',
              'fixture_observation': 'child stdout pipes, not writable evidence files',
              'selection_seeds': [],
              'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    target = person = None
    copies, cleanup = [], []
    lease_id = uuid.uuid4().hex
    attempted = False
    try:
        report['plugin'] = json.loads(exchange('ghost-build-info'))
        target = Client('target')
        original = wait(target.window, 'Existing GTK target did not map')
        wait(lambda: target.state()['caret'] == 0, 'Existing GTK target initial caret was not observed')
        original_identity = target.state()['identity']
        assert target.state()['text'] == 'unsaved-before-lease' and target.state()['caret'] == 0
        okay('dispatch movetoworkspacesilent 2,address:' + original['address'])
        original = wait(lambda: next((w for w in query('clients') if w.get('pid') == target.process.pid
                                     and w['workspace']['id'] == 2), None), 'Target did not move to background workspace')
        person = Client('standin')
        owner = wait(person.window, 'Stand-in did not map')
        okay('dispatch focuswindow address:' + owner['address'])
        for primary, text in ((False, 'lab-clipboard-preserved'), (True, 'lab-primary-preserved')):
            guard(os.environ)
            seed = {'selection': 'primary' if primary else 'clipboard', 'mime': 'text/plain',
                    'copy_stderr': '', 'expected_bytes': len(text.encode())}
            report['selection_seeds'].append(seed)
            process = subprocess.Popen(['wl-copy', '--foreground', '--type', 'text/plain']
                                       + (['--primary'] if primary else []), stdin=subprocess.PIPE,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                       start_new_session=True)
            copies.append(process)
            threading.Thread(target=capture_copy_errors, args=(process, seed), daemon=True).start()
            process.stdin.write(text.encode())
            process.stdin.close()

            def seeded():
                seed['copy_status'] = process.poll()
                return selection(primary, required=False, diagnostics=seed) == text

            wait(seeded, f"Private lab {seed['selection']} seed unavailable (exact MIME text/plain)")
        time.sleep(0.3)
        baseline = view()
        assert baseline['focus'] == owner['address']
        before_person = person.state()
        person.sync()
        with person.lock:
            event_start = len(person.events)
            modifier_events = [modifier_state(event[2]) for event in person.events
                               if event[0] == 'wl_keyboard' and event[1] == 'modifiers']
        assert modifier_events, 'Stand-in keyboard modifier baseline was not observed'
        baseline_modifiers = modifier_events[-1]
        attempted = True
        claim = json.loads(exchange(f"ghost-application-claim {original['address']} {original['stableId']} {lease_id}"))
        assert claim == {'schema': 1, 'status': 'claimed', 'lease_id': lease_id,
                         'scope': 'entire-wayland-client', 'windows': 1}, claim
        report['checks'].append('existing exact identity claimed after mapping and unsaved text creation')
        info = json.loads(exchange('ghost-application-info ' + lease_id))
        assert info['status'] == 'active' and len(info['windows']) == 1
        handle = info['windows'][0]['target']
        assert handle == f"{original['address']}@{original['stableId']}@lease-{lease_id}"
        assert target.state()['identity'] == original_identity and target.state()['text'] == 'unsaved-before-lease'
        x, y, width, height = target.state()['entry']
        okay(f'ghost-cursor {handle} {x + width // 2} {y + height // 2}')
        assert target.state()['caret'] == 0
        click_x, click_y = target.state()['click']
        okay(f'ghost-click {handle} {click_x} {click_y}')
        wait(lambda: 0 < target.state()['caret'] < len('unsaved-before-lease'), 'Click did not move the caret inside existing text')
        assert target.state()['selection'][0] == target.state()['selection'][1]
        okay(f'ghost-key {handle} End')
        wait(lambda: target.state()['caret'] == len('unsaved-before-lease'), 'End key did not move the caret to the end')
        okay(f'ghost-type {handle} -claimed')
        wait(lambda: target.state()['text'] == 'unsaved-before-lease-claimed', 'Claimed client input readback failed')
        report['checks'].append('cursor command acknowledged; click and End key changed observed caret before text input preserved preexisting buffer')
        okay(f'ghost-application-control {lease_id} pause')
        assert json.loads(exchange('ghost-application-info ' + lease_id))['status'] == 'paused'
        assert exchange(f'ghost-type {handle} forbidden').startswith('refused:')
        time.sleep(0.1)
        assert target.state()['text'] == 'unsaved-before-lease-claimed'
        okay(f'ghost-application-control {lease_id} resume')
        okay(f'ghost-type {handle} -resumed')
        wait(lambda: target.state()['text'] == 'unsaved-before-lease-claimed-resumed', 'Resumed client input failed')
        report['checks'].append('pause refused input without buffer change and resume restored input')
        okay(f'ghost-release {handle}')
        okay(f'ghost-application-control {lease_id} handback')
        assert json.loads(exchange('ghost-application-info ' + lease_id))['status'] == 'unavailable'
        assert exchange(f'ghost-type {handle} stale').startswith('refused:')
        returned = wait(lambda: next((w for w in query('clients') if w.get('pid') == target.process.pid
                                     and w['workspace'] == original['workspace']), None), 'Handback did not restore workspace')
        assert returned['address'] == original['address'] and returned['stableId'] == original['stableId']
        assert {key: returned.get(key) for key in ('at', 'size', 'floating', 'fullscreen', 'pinned')} == {
            key: original.get(key) for key in ('at', 'size', 'floating', 'fullscreen', 'pinned')}
        assert identity(target.process.pid) == original_identity
        assert target.state()['identity'] == original_identity
        assert target.state()['text'] == 'unsaved-before-lease-claimed-resumed'
        report['checks'].append('handback retained PID stable window identity workspace and unsaved text; stale input refused')
        time.sleep(0.3)
        assert view() == baseline, 'Stand-in focus workspace pointer or selections changed'
        assert person.state() == before_person, 'Stand-in text caret selection or geometry changed'
        person.sync()
        with person.lock:
            events = person.events[event_start:]
        forbidden = standin_violations(events, baseline_modifiers)
        assert not forbidden, forbidden
        report['standin_protocol_events'] = events
        report['checks'].append('stand-in focus pointer workspace clipboard primary text caret selection and protocol boundaries unchanged')
        okay('ghost-application-reap ' + lease_id)
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = f'{type(error).__name__}: {error}'
        if target:
            with target.lock:
                report['target_stderr_tail'] = list(target.stderr[-12:])
    finally:
        for process, seed in zip(copies, report['selection_seeds']):
            seed['copy_status_before_cleanup'] = process.poll()
        if attempted:
            try:
                okay(f'ghost-application-control {lease_id} handback')
                okay('ghost-application-reap ' + lease_id)
            except (Exception, SystemExit) as error:
                cleanup.append('lease cleanup: ' + str(error))
        for client in (target, person):
            if client:
                try:
                    client.stop()
                except Exception as error:
                    cleanup.append('fixture cleanup: ' + str(error))
        for process in copies:
            try:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except Exception as error:
                cleanup.append('selection helper cleanup: ' + str(error))
        report['cleanup_errors'] = cleanup
        if cleanup:
            report['measurement_complete'] = False
        print(json.dumps(report, indent=2))
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--run', action='store_true')
    group.add_argument('--fixture', choices=('target', 'standin'), help=argparse.SUPPRESS)
    options = parser.parse_args()
    if options.fixture:
        fixture(options.fixture)
    else:
        sys.exit(run())
