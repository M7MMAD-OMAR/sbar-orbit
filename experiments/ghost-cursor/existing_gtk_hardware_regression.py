#!/usr/bin/python3
"""Observe QEMU device input during a private existing-application lease.

Run only in the provisioned disposable guest's guarded lab. The host controller
responds to initialization and three nonce-bound phases with fixed keyboard and mouse
events to that guest's QMP socket. This program never injects shared-seat input.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
import uuid

import existing_gtk_regression as native


def run(nonce):
    native.private_guest()
    if not re.fullmatch(r'[0-9a-f]{32}', nonce):
        raise ValueError('A host-generated nonce is required')
    report = {'schema': 1, 'measurement_complete': False, 'checks': [], 'phases': [],
              'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'fixture_sha256': hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
              'scope': 'QEMU keyboard and pointer through guest input devices, two GTK3 clients',
              'real_human_hardware': 'not measured', 'other_toolkits_and_platforms': 'not measured',
              'clipboard_during_hardware_input': 'not measured', 'owner_handoff_release_hold': 'unchanged'}
    target = person = None
    lease = uuid.uuid4().hex
    attempted = False
    cleanup = []

    def events_since(index):
        person.sync()
        with person.lock:
            return list(person.events[index:])

    def event_index():
        person.sync()
        with person.lock:
            return len(person.events)

    def hardware(phase, text, codes):
        before = native.query('cursorpos')
        start = event_index()
        print(json.dumps({'hardware_request': phase, 'nonce': nonce}), flush=True)
        native.wait(lambda: person.state()['text'] == text, 'Guest device keyboard did not reach stand-in: ' + phase)
        native.wait(lambda: native.query('cursorpos') != before, 'Guest device pointer did not move: ' + phase)
        events = events_since(start)
        keys, forbidden = [], []
        for interface, event, arguments in events:
            if interface == 'wl_keyboard' and event == 'key':
                fields = [field.strip() for field in arguments.split(',')]
                if len(fields) != 4 or any(not field.isdecimal() for field in fields):
                    raise AssertionError('Malformed hardware key event')
                keys.append([int(fields[2]), int(fields[3])])
            elif interface == 'wl_keyboard' and event == 'modifiers':
                if native.modifier_state(arguments) != modifiers:
                    forbidden.append([interface, event, arguments])
            elif interface == 'wl_pointer' and event in ('motion', 'frame'):
                continue
            elif interface in ('wl_keyboard', 'wl_pointer', 'zwp_text_input_v3'):
                forbidden.append([interface, event, arguments])
        expected = [[code, state] for code in codes for state in (1, 0)]
        after = native.query('cursorpos')
        report['phases'].append({'phase': phase, 'keys': keys, 'expected_keys': expected,
                                 'cursor_before': before, 'cursor_after': after,
                                 'events': events, 'forbidden': forbidden,
                                 'standin': person.state()})
        if keys != expected or forbidden:
            raise AssertionError('Device key sequence or focus boundaries differed: ' + phase)
        if not any(event[:2] == ['wl_pointer', 'motion'] for event in events):
            raise AssertionError('Device motion was not observed by the stand-in: ' + phase)
        if native.query('activewindow').get('address') != owner['address']:
            raise AssertionError('Device input changed shared focus: ' + phase)
        if person.state()['caret'] != len(text) or person.state()['selection'] != [len(text), len(text)]:
            raise AssertionError('Stand-in caret or selection differs: ' + phase)

    try:
        report['plugin'] = json.loads(native.exchange('ghost-build-info'))
        monitors = native.query('monitors')
        if (len(monitors) != 1 or monitors[0]['width'] != 1280 or monitors[0]['height'] != 800
                or monitors[0]['scale'] != 1 or monitors[0]['transform'] != 0):
            raise RuntimeError('Hardware fixture requires one 1280x800 guest output at scale one')
        report['guest_input_devices'] = native.query('devices')
        target = native.Client('target')
        original = native.wait(target.window, 'Target did not map')
        native.okay('dispatch movetoworkspacesilent 2,address:' + original['address'])
        native.wait(lambda: target.window()['workspace']['id'] == 2, 'Target did not reach background desktop')
        original = target.window()
        person = native.Client('standin')
        owner = native.wait(person.window, 'Stand-in did not map')
        for command in ('setfloating address:', 'resizewindowpixel exact 480 240,address:',
                        'movewindowpixel exact 700 430,address:'):
            native.okay('dispatch ' + command + owner['address'])
        native.okay('dispatch focuswindow address:' + owner['address'])
        native.okay('dispatch movecursor 900 550')
        time.sleep(1)
        person.sync()
        with person.lock:
            values = [native.modifier_state(event[2]) for event in person.events
                      if event[:2] == ['wl_keyboard', 'modifiers']]
        if not values:
            raise AssertionError('No stand-in keyboard baseline')
        modifiers = values[-1]
        # movecursor sets compositor coordinates without establishing device
        # pointer focus. Deliver a real guest-device motion before the baseline.
        prime_before = native.query('cursorpos')
        prime_state = person.state()
        prime_start = event_index()
        print(json.dumps({'hardware_request': 'pointer-prime', 'nonce': nonce}), flush=True)

        def primed():
            with person.lock:
                return any(event[:2] == ['wl_pointer', 'motion'] for event in person.events[prime_start:])

        native.wait(primed, 'Initial guest device motion did not reach stand-in')
        prime_events = events_since(prime_start)
        report['pointer_initialization'] = {'cursor_before': prime_before,
                                             'cursor_after': native.query('cursorpos'),
                                             'events': prime_events, 'standin': person.state()}
        if (native.query('cursorpos') == prime_before or person.state() != prime_state
                or native.query('activewindow').get('address') != owner['address']
                or any(event[0] in ('wl_keyboard', 'zwp_text_input_v3') for event in prime_events)):
            raise AssertionError('Pointer initialization changed keyboard focus or stand-in state')
        hardware('baseline', 'standin-privatehw', [35, 17])
        report['checks'].append('QEMU keyboard and pointer reached the existing stand-in before claim')
        person_before = person.state()
        pointer_before = native.query('cursorpos')
        start = event_index()
        attempted = True
        claim = json.loads(native.exchange(
            f"ghost-application-claim {original['address']} {original['stableId']} {lease}"))
        if claim.get('status') != 'claimed' or claim.get('windows') != 1:
            raise AssertionError(claim)
        info = json.loads(native.exchange('ghost-application-info ' + lease))
        handle = info['windows'][0]['target']
        native.okay('ghost-key ' + handle + ' End')
        native.okay('ghost-key ' + handle + ' Menu')
        native.wait(lambda: target.state()['popup_visible'], 'Leased popup did not map')
        early = events_since(start)
        report['before_hardware_actor_events'] = early
        if (native.standin_violations(early, modifiers) or person.state() != person_before
                or native.query('cursorpos') != pointer_before):
            raise AssertionError('Actor disturbed shared input before hardware phase')
        hardware('leased-popup', 'standin-privatehwxy', [45, 21])
        if not target.state()['popup_visible'] or target.state()['popup_actions'] != 0:
            raise AssertionError('Shared hardware interacted with private target menu')
        if target.state()['text'] != 'unsaved-before-lease':
            raise AssertionError('Shared hardware changed target buffer')
        report['checks'].append('guest hardware continued reaching stand-in while leased target menu remained open')
        person_before = person.state()
        pointer_before = native.query('cursorpos')
        start = event_index()
        native.okay('ghost-key ' + handle + ' Home')
        native.okay('ghost-key ' + handle + ' Return')
        native.wait(lambda: target.state()['popup_actions'] == 1 and not target.state()['popup_visible'],
                    'Agent menu action did not complete')
        native.okay('ghost-type ' + handle + ' -agent')
        native.wait(lambda: target.state()['text'] == 'unsaved-before-lease-agent', 'Agent text did not reach target')
        native.okay('ghost-release ' + handle)
        native.okay(f'ghost-application-control {lease} handback')
        after_actor = events_since(start)
        report['after_hardware_actor_events'] = after_actor
        if (native.standin_violations(after_actor, modifiers) or person.state() != person_before
                or native.query('cursorpos') != pointer_before):
            raise AssertionError('Actor action or handback disturbed hardware stand-in state')
        hardware('handback', 'standin-privatehwxyz', [44])
        returned = target.window()
        if any(returned[key] != original[key] for key in ('address', 'stableId', 'pid', 'workspace', 'at', 'size')):
            raise AssertionError('Target identity or geometry changed')
        if target.state()['text'] != 'unsaved-before-lease-agent':
            raise AssertionError('Post-handback hardware changed target buffer')
        native.okay('ghost-application-reap ' + lease)
        report['checks'].append('agent menu and typing remained private, handback preserved identity and subsequent guest hardware input')
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = f'{type(error).__name__}: {error}'
        if person:
            report['standin_state_on_error'] = person.state()
            with person.lock:
                report['standin_stderr_tail'] = person.stderr[-15:]
                report['standin_events_on_error'] = person.events[-100:]
    finally:
        if attempted:
            try:
                native.okay(f'ghost-application-control {lease} handback')
                native.okay('ghost-application-reap ' + lease)
            except (Exception, SystemExit) as error:
                cleanup.append('lease: ' + str(error))
        for client in (target, person):
            if client:
                try:
                    client.stop()
                except Exception as error:
                    cleanup.append('client: ' + str(error))
        report['cleanup_errors'] = cleanup
        if cleanup:
            report['measurement_complete'] = False
        print(json.dumps({'hardware_result': report}), flush=True)
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nonce', required=True)
    raise SystemExit(run(parser.parse_args().nonce))
