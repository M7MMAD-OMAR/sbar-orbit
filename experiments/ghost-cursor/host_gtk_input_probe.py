#!/usr/bin/python3
"""Internal GTK input diagnosis on a guarded nested compositor, never an owner session."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

from lab import guard
from existing_gtk_regression import raw_exchange

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.keyboard import prepared_input


def admitted():
    guard(os.environ)
    require_budget()
    if os.environ.get('GDK_BACKEND') != 'wayland':
        raise RuntimeError('Probe requires the guarded lab Wayland backend')


def wait(condition, description):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.02)
    raise RuntimeError(description)


def fixture(role):
    admitted()
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk, GLib
    Gtk.Settings.get_default().set_property('gtk-cursor-blink', False)
    window = Gtk.Window(title='Orbit private input probe ' + role)
    window.set_default_size(480, 160)
    entry = Gtk.Entry()
    entry.set_text('unsaved-before-lease' if role == 'target' else 'standin-private')
    window.add(entry)

    def publish(sequence=0):
        allocation = entry.get_allocation()
        layout_x, layout_y = entry.get_layout_offsets()
        character = entry.get_layout().index_to_pos(4)
        bounds = entry.get_selection_bounds()
        selection = list(bounds[-2:]) if bounds else [entry.get_position()] * 2
        print(json.dumps({'pid': os.getpid(), 'role': role, 'sync': sequence,
                          'text': entry.get_text(), 'caret': entry.get_position(),
                          'selection': selection,
                          'click': [allocation.x + layout_x + character.x // 1024 + max(1, character.width // 2048),
                                    allocation.y + layout_y + character.y // 1024 + max(1, character.height // 2048)]}), flush=True)

    def synchronize(_fd, condition):
        if condition & GLib.IO_HUP:
            Gtk.main_quit()
            return False
        command = sys.stdin.readline().strip()
        if not re.fullmatch(r'sync [1-9][0-9]{0,8}', command):
            Gtk.main_quit()
            return False
        Gdk.Display.get_default().sync()
        publish(int(command.split()[1]))
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, synchronize)
    for event in ('changed', 'notify::cursor-position', 'notify::selection-bound'):
        entry.connect(event, lambda *_: publish())
    window.connect('destroy', Gtk.main_quit)
    window.show_all()
    entry.grab_focus()
    entry.set_position(0 if role == 'target' else -1)
    publish()
    Gtk.main()


class Client:
    def __init__(self, role):
        admitted()
        self.lock = threading.Lock()
        self.states, self.events, self.errors = [], [], []
        self.sequence = 0
        self.seen = 0
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), '--fixture', role],
            env=dict(os.environ, WAYLAND_DEBUG='client'), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True)
        self.readers = [threading.Thread(target=self.read_states, daemon=True),
                        threading.Thread(target=self.read_events, daemon=True)]
        for reader in self.readers:
            reader.start()

    def read_states(self):
        for line in self.process.stdout:
            try:
                value = json.loads(line)
                with self.lock:
                    self.seen = max(self.seen, value['sync'])
                    self.states.append(value)
                    self.states = self.states[-300:]
            except (ValueError, KeyError, TypeError):
                with self.lock:
                    self.errors.append(line[-1000:])

    def read_events(self):
        for line in self.process.stderr:
            with self.lock:
                if any(name in line for name in ('wl_keyboard#', 'wl_pointer#', 'wl_seat#', 'xdg_surface#')):
                    self.events.append(line.strip())
                    self.events = self.events[-2000:]
                else:
                    self.errors.append(line[-1000:].strip())
                    self.errors = self.errors[-30:]

    def state(self):
        with self.lock:
            return dict(self.states[-1]) if self.states else None

    def sync(self):
        self.sequence += 1
        self.process.stdin.write(f'sync {self.sequence}\n')
        self.process.stdin.flush()

        def seen():
            with self.lock:
                return self.seen >= self.sequence

        wait(seen, 'Fixture synchronization failed')
        return self.state()

    def snapshot(self):
        with self.lock:
            return {'pid': self.process.pid, 'states': list(self.states),
                    'events': list(self.events), 'stderr_tail': list(self.errors),
                    'event_limit': 2000, 'state_limit': 300}

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        for reader in self.readers:
            reader.join(timeout=1)


def run():
    report = {'schema': 1, 'measurement_complete': False,
              'scope': 'GTK3 fixtures on a guarded nested compositor, internal plugin IPC',
              'owner_handoff_release_hold': 'unchanged', 'live_owner_input': 'not measured',
              'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'requests': [], 'checks': [], 'cleanup_errors': []}
    clients = []
    lease = uuid.uuid4().hex
    attempted = False

    def exchange(request, deadline=None):
        admitted()
        record = {'request': request}
        report['requests'].append(record)
        try:
            reply = raw_exchange(request, deadline)
            record['reply'] = reply
            return reply
        except (Exception, SystemExit) as error:
            record['error'] = f'{type(error).__name__}: {error}'
            raise

    def okay(request):
        reply = exchange(request)
        if reply != 'ok':
            raise RuntimeError(f'{request}: {reply}')

    def query(command):
        return json.loads(exchange('j/' + command))

    def window(client):
        matches = [value for value in query('clients') if value.get('pid') == client.process.pid]
        if len(matches) > 1:
            raise RuntimeError('Fixture mapped multiple windows')
        return matches[0] if matches and client.state() else None

    def keyboard(request):
        reply = prepared_input(request, exchange, time.monotonic() + 3)
        if reply != 'ok' and not re.fullmatch(r'ok [0-9]+ keys', reply):
            raise RuntimeError(f'{request}: {reply}')

    try:
        admitted()
        report['plugin'] = json.loads(exchange('ghost-build-info'))
        report['compositor'] = query('version')
        target = Client('target')
        clients.append(target)
        original = wait(lambda: window(target), 'Target did not map')
        okay('dispatch movetoworkspacesilent 2,address:' + original['address'])
        report['target'] = wait(lambda: (value if (value := window(target)) and value['workspace']['id'] == 2 else None),
                                'Target did not reach private workspace 2')
        standin = Client('standin')
        clients.append(standin)
        owner = wait(lambda: window(standin), 'Stand-in did not map')
        report['standin'] = owner
        okay('dispatch focuswindow address:' + owner['address'])
        wait(lambda: query('activewindow').get('address') == owner['address'], 'Stand-in did not receive focus')
        target.sync()
        baseline = standin.sync()
        pointer = query('cursorpos')
        attempted = True
        claim = json.loads(exchange(f"ghost-application-claim {original['address']} {original['stableId']} {lease}"))
        if claim.get('status') != 'claimed' or claim.get('windows') != 1 or claim.get('lease_id') != lease:
            raise RuntimeError('Unexpected claim reply: ' + repr(claim))
        info = json.loads(exchange('ghost-application-info ' + lease))
        handle = info['windows'][0]['target']
        if handle != f"{original['address']}@{original['stableId']}@lease-{lease}":
            raise RuntimeError('Lease target identity changed')
        initial = target.sync()
        for request in (f'ghost-key {handle} End', f'ghost-type {handle} forbidden'):
            if exchange(request) != 'refused: keyboard preparation required':
                raise RuntimeError('Raw keyboard refusal was not detected')
        if target.sync()['text'] != initial['text']:
            raise RuntimeError('Refused raw keyboard input changed text')
        report['checks'].append('raw keyboard replies were explicitly rejected and left text unchanged')
        x, y = initial['click']
        okay(f'ghost-click {handle} {x} {y}')
        wait(lambda: 0 < target.sync()['caret'] < len(initial['text']), 'Click did not change target caret')
        keyboard(f'ghost-key {handle} End')
        wait(lambda: target.sync()['caret'] == len(initial['text']), 'Prepared End did not change caret')
        keyboard(f'ghost-type {handle} -probe')
        wait(lambda: target.sync()['text'] == initial['text'] + '-probe', 'Prepared typing did not reach GTK')
        report['checks'].append('click, prepared End and prepared typing changed observed GTK state')
        after = standin.sync()
        if any(after[key] != baseline[key] for key in ('text', 'caret', 'selection')):
            raise RuntimeError('Stand-in input state changed')
        if query('activewindow').get('address') != owner['address'] or query('cursorpos') != pointer:
            raise RuntimeError('Shared focus or pointer changed')
        report['checks'].append('stand-in text, caret, selection, focus and shared pointer stayed unchanged')
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        if attempted:
            for request in (f'ghost-application-control {lease} handback', f'ghost-application-reap {lease}'):
                try:
                    okay(request)
                except (Exception, SystemExit) as error:
                    report['cleanup_errors'].append(f'{request}: {error}')
        for client in clients:
            try:
                client.stop()
            except (Exception, SystemExit) as error:
                report['cleanup_errors'].append(f'fixture {client.process.pid}: {error}')
        report['fixtures'] = [client.snapshot() for client in clients]
        if report['cleanup_errors']:
            report['measurement_complete'] = False
        print(json.dumps(report), flush=True)
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', choices=('target', 'standin'))
    options = parser.parse_args()
    if options.fixture:
        fixture(options.fixture)
    else:
        raise SystemExit(run())
