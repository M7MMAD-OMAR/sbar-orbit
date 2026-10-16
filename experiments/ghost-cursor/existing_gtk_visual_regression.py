#!/usr/bin/python3
"""Measure real cursor pixels and a GTK menu in the disposable guest only.

Run inside the guarded private QEMU compositor using lab.py run LAB -- python3
existing_gtk_visual_regression.py --run. Captures contain only the guest's two
synthetic fixtures. This does not activate owner handoff or waive its hold.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import time
import uuid

import existing_gtk_regression as native


def run():
    native.private_guest()
    import subprocess
    from PIL import Image, ImageChops

    output = Path(os.environ['XDG_RUNTIME_DIR']).parent / 'visual-proof'
    output.mkdir(mode=0o700)
    report = {'schema': 1, 'measurement_complete': False, 'checks': [], 'frames': {},
              'scope': 'two synthetic GTK3 clients on one disposable QEMU private display',
              'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'fixture_sha256': hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
              'owner_handoff_release_hold': 'unchanged',
              'continuous_frame_isolation': 'not measured',
              'other_applications_and_platforms': 'not measured'}
    target = person = None
    lease = uuid.uuid4().hex
    attempted = False
    cleanup = []
    event_cursor = 0

    def observe(label):
        nonlocal event_cursor
        if person is None:
            return
        person.sync()
        with person.lock:
            events = person.events[event_cursor:]
            event_cursor = len(person.events)
        report.setdefault('protocol_phases', []).append({'phase': label, 'events': events})

    def snapshot(label):
        previous = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            native.private_guest()
            data = subprocess.run(['grim', '-'], check=True, capture_output=True, timeout=5).stdout
            with Image.open(io.BytesIO(data)) as source:
                if source.width > 4096 or source.height > 4096:
                    raise RuntimeError('Guest capture exceeds the measured image bounds')
                actual = source.convert('RGB')
            pixels = actual.tobytes()
            if pixels == previous:
                name = label + '.png'
                with (output / name).open('xb') as saved:
                    saved.write(data)
                report['frames'][label] = {'file': name, 'sha256': hashlib.sha256(data).hexdigest(),
                                           'width': actual.width, 'height': actual.height}
                observe(label)
                return actual
            previous = pixels
            time.sleep(0.2)
        raise TimeoutError('Guest pixels did not settle: ' + label)

    def same(actual, expected, message):
        if actual.size != expected.size or ImageChops.difference(actual, expected).getbbox():
            raise AssertionError(message)

    def footprint(window, point):
        x, y = window['at'][0] + point[0], window['at'][1] + point[1]
        return (x - 8, y - 8, x + 40, y + 48)

    def cursor_delta(actual, expected, boxes):
        delta = ImageChops.difference(actual, expected)
        for box in boxes:
            if not delta.crop(box).getbbox():
                raise AssertionError('Missing visible cursor footprint')
            delta.paste((0, 0, 0), box)
        if delta.getbbox():
            raise AssertionError('Pixels changed outside the expected cursor footprints')

    try:
        report['plugin'] = json.loads(native.exchange('ghost-build-info'))
        monitors = native.query('monitors')
        if (len(monitors) != 1 or monitors[0].get('scale') != 1
                or monitors[0].get('transform') != 0):
            raise RuntimeError('Visual proof requires one untransformed guest output at scale one')
        target = native.Client('target')
        window = native.wait(target.window, 'Target did not map')
        for command in ('setfloating address:', 'resizewindowpixel exact 640 300,address:',
                        'movewindowpixel exact 80 80,address:'):
            native.okay('dispatch ' + command + window['address'])
        person = native.Client('standin')
        owner = native.wait(person.window, 'Stand-in did not map')
        for command in ('setfloating address:', 'resizewindowpixel exact 300 160,address:',
                        'movewindowpixel exact 930 560,address:'):
            native.okay('dispatch ' + command + owner['address'])
        native.okay('dispatch movecursor 1100 650')
        native.okay('dispatch focuswindow address:' + owner['address'])
        person.sync()
        with person.lock:
            initialization_start = len(person.events)
        person.sync('popup')
        native.wait(lambda: person.state()['popup_visible'], 'Stand-in baseline menu did not map')
        person.sync('dismiss')
        native.wait(lambda: not person.state()['popup_visible'], 'Stand-in baseline menu did not close')
        native.okay('dispatch focuswindow address:' + owner['address'])
        person.sync()
        with person.lock:
            initialization_events = list(person.events[initialization_start:])
        if not any(event[:2] == ['wl_pointer', 'motion'] for event in initialization_events):
            raise AssertionError('Stand-in pointer focus initialization was not observed')
        report['baseline_initialization'] = {
            'method': 'ordinary stand-in popup and dismiss before baseline',
            'events': initialization_events,
            'pointer': native.query('cursorpos'),
            'focus': native.query('activewindow').get('address')}
        time.sleep(6)
        original = target.window()
        identity = target.state()['identity']
        before_person = person.state()
        before_view = {'focus': native.query('activewindow').get('address'),
                       'workspace': native.query('activeworkspace'), 'pointer': native.query('cursorpos')}
        if before_view['focus'] != owner['address']:
            raise AssertionError('Stand-in is not the focused guest client')
        person.sync()
        with person.lock:
            first_event = len(person.events)
            event_cursor = first_event
            modifiers = [native.modifier_state(event[2]) for event in person.events
                         if event[0] == 'wl_keyboard' and event[1] == 'modifiers']
        if not modifiers:
            raise AssertionError('No observed stand-in keyboard baseline')
        before = snapshot('before-claim')
        attempted = True
        claim = json.loads(native.exchange(
            f"ghost-application-claim {original['address']} {original['stableId']} {lease}"))
        if claim.get('status') != 'claimed' or claim.get('windows') != 1:
            raise AssertionError(claim)
        info = json.loads(native.exchange('ghost-application-info ' + lease))
        handle = info['windows'][0]['target']
        baseline = snapshot('baseline')
        same(baseline, before, 'Claim changed visible guest pixels')
        first, second = (170, 90), (330, 90)
        native.okay(f'ghost-cursor {handle} {first[0]} {first[1]}')
        shown = snapshot('cursor-shown')
        cursor_delta(shown, baseline, [footprint(original, first)])
        native.okay(f'ghost-cursor {handle} {second[0]} {second[1]}')
        moved = snapshot('cursor-moved')
        cursor_delta(moved, shown, [footprint(original, first), footprint(original, second)])
        cursor_delta(moved, baseline, [footprint(original, second)])
        native.okay('ghost-hide-cursor ' + handle)
        hidden = snapshot('cursor-hidden')
        same(hidden, baseline, 'Hiding cursor left stale pixels')
        report['checks'].append('cursor appeared, moved and disappeared in real frames with no pixels changed outside its footprints')
        native.okay('ghost-key ' + handle + ' Escape')
        menu_baseline = snapshot('menu-baseline')
        native.okay('ghost-key ' + handle + ' Menu')
        native.wait(lambda: target.state()['popup_visible'], 'GTK menu did not map')
        popup = snapshot('popup-open')
        change = ImageChops.difference(popup, menu_baseline).getbbox()
        if not change or change[2] - change[0] < 80 or change[3] - change[1] < 20:
            raise AssertionError('GTK menu has no observed visible pixels')
        native.okay('ghost-key ' + handle + ' Home')
        native.okay('ghost-key ' + handle + ' Return')
        native.wait(lambda: target.state()['popup_actions'] == 1 and not target.state()['popup_visible'],
                    'GTK menu action did not activate and close')
        closed = snapshot('popup-closed')
        same(closed, menu_baseline, 'Closed GTK menu left stale pixels')
        if target.state()['text'] != 'unsaved-before-lease':
            raise AssertionError('Menu interaction modified the existing buffer')
        report['checks'].append('real GTK menu mapped visibly, activated its test action and closed without changing the buffer')
        native.okay('ghost-release ' + handle)
        observe('release')
        native.okay(f'ghost-application-control {lease} handback')
        observe('handback')
        returned = target.window()
        if (returned['address'] != original['address'] or returned['stableId'] != original['stableId']
                or target.state()['identity'] != identity):
            raise AssertionError('Handback changed existing client identity')
        after = {'focus': native.query('activewindow').get('address'),
                 'workspace': native.query('activeworkspace'), 'pointer': native.query('cursorpos')}
        if after != before_view or person.state() != before_person:
            raise AssertionError('Stand-in state or shared guest input state changed')
        person.sync()
        with person.lock:
            events = person.events[first_event:]
        report['standin_protocol_events'] = events
        if native.standin_violations(events, modifiers[-1]):
            raise AssertionError('Input or focus events leaked to the stand-in')
        report['checks'].append('stand-in state, focus, pointer, workspace and protocol input boundaries remained unchanged')
        native.okay('ghost-application-reap ' + lease)
        normal_before = snapshot('unleased-before')
        person.sync()
        with person.lock:
            ordinary_start = len(person.events)
        target.sync()
        with target.lock:
            target_start = len(target.events)
        target.sync('popup')
        native.wait(lambda: target.state()['popup_visible'], 'Unleased GTK menu did not map')
        ordinary = snapshot('unleased-popup')
        if not ImageChops.difference(ordinary, normal_before).getbbox():
            raise AssertionError('Unleased GTK menu is not visible')
        with person.lock:
            ordinary_events = person.events[ordinary_start:]
        report['unleased_popup_protocol_events'] = ordinary_events
        target.sync()
        with target.lock:
            target_events = target.events[target_start:]
        report['unleased_target_protocol_events'] = target_events
        if (not any(event[0:2] == ['wl_pointer', 'motion'] for event in target_events)
                or not any(event[0:2] == ['wl_keyboard', 'leave'] for event in ordinary_events)):
            raise AssertionError('Ordinary popup shared grab and motion path was suppressed')
        target.sync('dismiss')
        native.wait(lambda: not target.state()['popup_visible'], 'Unleased GTK menu did not close')
        native.okay('dispatch focuswindow address:' + owner['address'])
        same(snapshot('unleased-closed'), normal_before, 'Unleased GTK menu left stale pixels')
        report['checks'].append('unleased GTK popup still maps, closes and reaches the ordinary compositor motion path')
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = f'{type(error).__name__}: {error}'
        if target:
            report['target_state'] = target.state()
            with target.lock:
                report['target_stderr_tail'] = target.stderr[-18:]
    finally:
        if attempted:
            try:
                native.okay(f'ghost-application-control {lease} handback')
                native.okay('ghost-application-reap ' + lease)
            except (Exception, SystemExit) as error:
                cleanup.append(str(error))
        for client in (target, person):
            if client:
                try:
                    client.stop()
                except Exception as error:
                    cleanup.append(str(error))
        report['cleanup_errors'] = cleanup
        if cleanup:
            report['measurement_complete'] = False
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', required=True)
    parser.parse_args()
    raise SystemExit(run())
