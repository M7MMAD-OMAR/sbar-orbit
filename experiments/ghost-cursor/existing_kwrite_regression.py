#!/usr/bin/python3
"""Exercise an existing real Qt editor only in the guarded disposable guest.

AT-SPI supplies independent application readback. Its only write prepares the
unsaved document before claim. Measured edits use the native plugin input path.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid

import existing_gtk_regression as native


def run():
    native.private_guest()
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    report = {'schema': 1, 'measurement_complete': False, 'checks': [],
              'scope': 'one real KWrite Qt application and GTK3 stand-in in an owned Fedora QEMU guest',
              'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'fixture_sha256': hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
              'readback': 'AT-SPI text, caret, selections and showing popup states from the real editor',
              'owner_handoff_release_hold': 'unchanged', 'other_applications_and_platforms': 'not measured',
              'real_human_hardware': 'not measured', 'continuous_frame_isolation': 'not measured',
              'cleanup_errors': []}
    process = person = None
    copies = []
    lease = uuid.uuid4().hex
    attempted = False
    log = Path(os.environ['HOME']) / 'kwrite-regression.stderr'
    original_file = 'file-before-lease'
    unsaved = 'unsaved-before-lease'
    editor = app = None
    start = None

    def app_nodes():
        stack, seen = [(app, 0)], 0
        while stack:
            node, depth = stack.pop()
            seen += 1
            if seen > 2048:
                raise RuntimeError('KWrite accessibility tree exceeds probe bound')
            if not node:
                continue
            yield node
            # Closed menus have large unrelated subtrees. They cannot hold the
            # document and need not be expanded for text or popup observation.
            role = node.get_role_name()
            if depth < 20 and role not in ('menu bar', 'popup menu'):
                count = node.get_child_count()
                if count > 256:
                    raise RuntimeError('KWrite accessibility child count exceeds probe bound')
                for index in reversed(range(count)):
                    child = node.get_child_at_index(index)
                    if child:
                        stack.append((child, depth + 1))

    def text():
        return Atspi.Text.get_text(editor, 0, Atspi.Text.get_character_count(editor))

    def state():
        selections = []
        for index in range(Atspi.Text.get_n_selections(editor)):
            selected = Atspi.Text.get_selection(editor, index)
            selections.append([selected.start_offset, selected.end_offset])
        return {'text': text(), 'caret': Atspi.Text.get_caret_offset(editor), 'selections': selections}

    def focused_nodes():
        result = []
        for node in app_nodes():
            node.clear_cache()
            if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                result.append({'role': node.get_role_name(), 'name': node.get_name()})
        return result

    def showing_menus():
        result = []
        for node in app_nodes():
            if node.get_role_name() == 'popup menu':
                node.clear_cache()
                if node.get_state_set().contains(Atspi.StateType.SHOWING):
                    result.append({'name': node.get_name(), 'children': node.get_child_count()})
        return result

    def target_window():
        windows = [window for window in native.query('clients') if window.get('pid') == process.pid]
        if len(windows) > 1:
            raise AssertionError('Single-window KWrite probe found additional top-level windows')
        return windows[0] if windows else None

    def events_since(index):
        person.sync()
        with person.lock:
            return list(person.events[index:])

    try:
        report['plugin'] = json.loads(native.exchange('ghost-build-info'))
        path = Path(os.environ['HOME']) / 'existing-document.txt'
        path.write_text(original_file)
        with log.open('w') as output:
            process = subprocess.Popen(['/usr/bin/kwrite', str(path)], stdout=output, stderr=output,
                                       env=dict(os.environ, QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1', QT_ACCESSIBILITY='1',
                                                WAYLAND_DEBUG='client'),
                                       start_new_session=True)
        native.wait(target_window, 'Real KWrite application did not map')
        identity = native.identity(process.pid)
        report['application'] = {'process_identity': identity,
                                 'executable': str(Path(f'/proc/{process.pid}/exe').resolve()),
                                 'executable_sha256': hashlib.sha256(Path(f'/proc/{process.pid}/exe').read_bytes()).hexdigest(),
                                 'packages': subprocess.run(['rpm', '-q', 'kwrite', 'qt6-qtbase-gui'],
                                                            capture_output=True, text=True, timeout=5).stdout}

        def accessible_app():
            desktop = Atspi.get_desktop(0)
            for index in range(desktop.get_child_count()):
                candidate = desktop.get_child_at_index(index)
                if candidate and candidate.get_process_id() == process.pid:
                    return candidate

        app = native.wait(accessible_app, 'KWrite AT-SPI process identity unavailable')

        def existing_document():
            for node in app_nodes():
                if 'Text' in node.get_interfaces():
                    value = Atspi.Text.get_text(node, 0, Atspi.Text.get_character_count(node))
                    if value == original_file:
                        return node

        editor = native.wait(existing_document, 'Existing KWrite document was not read through AT-SPI')
        report['editor'] = {'role': editor.get_role_name(), 'interfaces': editor.get_interfaces()}
        if not Atspi.EditableText.set_text_contents(editor, unsaved):
            raise AssertionError('KWrite refused pre-claim unsaved document preparation')
        native.wait(lambda: text() == unsaved, 'Unsaved pre-claim document readback failed')
        if not Atspi.Text.set_caret_offset(editor, 0):
            raise AssertionError('KWrite refused pre-claim caret setup')
        native.wait(lambda: state()['caret'] == 0, 'Pre-claim KWrite caret was not observed')
        report['focused_before_background'] = focused_nodes()
        if path.read_text() != original_file:
            raise AssertionError('Preparing unsaved text saved the file unexpectedly')
        native.okay('dispatch movetoworkspacesilent 2,address:' + target_window()['address'])
        native.wait(lambda: target_window()['workspace']['id'] == 2, 'KWrite did not reach background desktop')
        original = target_window()
        report['window_before_claim'] = original
        report['document_before_claim'] = state()
        report['checks'].append('real KWrite mapped and independently read before claim, with unsaved text and unchanged file bytes')
        person = native.Client('standin')
        owner = native.wait(person.window, 'GTK stand-in did not map')
        native.okay('dispatch focuswindow address:' + owner['address'])
        report['selection_seeds'] = []
        for primary, seed_text in ((False, 'kwrite-clipboard-preserved'), (True, 'kwrite-primary-preserved')):
            seed = {'selection': 'primary' if primary else 'clipboard', 'copy_stderr': ''}
            report['selection_seeds'].append(seed)
            copy = subprocess.Popen(['wl-copy', '--foreground', '--type', 'text/plain']
                                    + (['--primary'] if primary else []), stdin=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            copies.append(copy)
            threading.Thread(target=native.capture_copy_errors, args=(copy, seed), daemon=True).start()
            copy.stdin.write(seed_text.encode())
            copy.stdin.close()
            native.wait(lambda: native.selection(primary, required=False, diagnostics=seed) == seed_text,
                        'Private lab selection seed unavailable')
        person.sync()
        with person.lock:
            modifiers = [native.modifier_state(event[2]) for event in person.events
                         if event[:2] == ['wl_keyboard', 'modifiers']]
        if not modifiers:
            raise AssertionError('Stand-in modifier baseline unavailable')
        before_view, before_person = native.view(), person.state()
        report['standin_baseline'] = {'view': before_view, 'state': before_person}
        person.sync()
        with person.lock:
            start = len(person.events)
        attempted = True
        report['target_log_offsets'] = {'before_claim': log.stat().st_size}
        claim = json.loads(native.exchange(f"ghost-application-claim {original['address']} {original['stableId']} {lease}"))
        if claim.get('status') != 'claimed' or claim.get('windows') != 1:
            raise AssertionError(claim)
        info = json.loads(native.exchange('ghost-application-info ' + lease))
        handle = info['windows'][0]['target']
        report['focused_after_claim'] = focused_nodes()
        report['target_log_offsets']['before_first_end'] = log.stat().st_size
        native.okay('ghost-key ' + handle + ' End')
        report['target_log_offsets']['after_first_end_ack'] = log.stat().st_size
        native.wait(lambda: state()['caret'] == len(unsaved), 'Qt End key did not move the observed caret')
        native.okay('ghost-type ' + handle + ' -claimed')
        native.wait(lambda: text() == unsaved + '-claimed', 'Qt private typing readback failed')
        report['document_after_typing'] = state()
        report['checks'].append('leased native End key and typing changed real Qt caret and text through independent AT-SPI readback')
        if showing_menus():
            raise AssertionError('KWrite unexpectedly had a showing menu before private Menu key')
        native.okay('ghost-key ' + handle + ' Menu')
        report['private_menu'] = native.wait(showing_menus, 'KWrite private context menu did not become showing')
        native.okay('ghost-key ' + handle + ' Escape')
        native.wait(lambda: not showing_menus(), 'Qt private context menu did not close')
        if text() != unsaved + '-claimed':
            raise AssertionError('Private menu open and dismiss changed document text')
        report['checks'].append('real Qt private context menu was observed showing, dismissed and left the buffer unchanged')
        native.okay('ghost-application-control ' + lease + ' pause')
        paused_state = state()
        if not native.exchange('ghost-type ' + handle + ' forbidden').startswith('refused:'):
            raise AssertionError('Paused Qt input was admitted')
        if state() != paused_state:
            raise AssertionError('Refused Qt input changed the document')
        native.okay('ghost-application-control ' + lease + ' resume')
        native.okay('ghost-type ' + handle + ' -resumed')
        native.wait(lambda: text() == unsaved + '-claimed-resumed', 'Resumed Qt text did not arrive')
        native.okay('ghost-release ' + handle)
        native.okay('ghost-application-control ' + lease + ' handback')
        if not native.exchange('ghost-type ' + handle + ' stale').startswith('refused:'):
            raise AssertionError('Stale Qt handle was admitted')
        returned = native.wait(lambda: target_window() if target_window()['workspace'] == original['workspace'] else None,
                               'Qt handback did not restore desktop')
        for key in ('address', 'stableId', 'pid', 'workspace', 'at', 'size', 'floating', 'fullscreen', 'pinned'):
            if returned.get(key) != original.get(key):
                raise AssertionError('Qt handback changed window field: ' + key)
        if native.identity(process.pid) != identity or text() != unsaved + '-claimed-resumed':
            raise AssertionError('Qt identity or unsaved buffer changed on handback')
        if path.read_text() != original_file:
            raise AssertionError('Qt handoff saved the unsaved document unexpectedly')
        report['window_after_handback'] = returned
        report['document_after_handback'] = state()
        report['checks'].append('pause refused Qt input, resume worked, and handback preserved process window desktop geometry and unsaved document; stale input refused')
        events = events_since(start)
        report['standin_protocol_events'] = events
        if native.standin_violations(events, modifiers[-1]) or native.view() != before_view or person.state() != before_person:
            raise AssertionError('Qt handoff disturbed stand-in focus pointer desktop selections state or protocol')
        report['checks'].append('stand-in focus pointer desktop clipboard primary text caret selections and protocol boundaries preserved')
        native.okay('ghost-application-reap ' + lease)
        report['measurement_complete'] = True
    except (Exception, SystemExit) as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
        if editor:
            try:
                report['document_on_error'] = state()
                report['focused_on_error'] = focused_nodes()
            except Exception as read_error:
                report['document_read_error'] = str(read_error)
        if person and start is not None:
            try:
                report['standin_protocol_events_on_failure'] = events_since(start)
                report['standin_on_failure'] = {'view': native.view(), 'state': person.state()}
            except Exception as read_error:
                report['standin_read_error'] = str(read_error)
    finally:
        if log.exists():
            with log.open('rb') as events:
                events.seek(max(0, log.stat().st_size - 1048576))
                tail_start = events.tell()
                lines = events.read(1048576).decode(errors='replace').splitlines()
            report['target_protocol_events'] = [list(match.groups()) for line in lines
                                                if ' -> ' not in line
                                                and (match := native.Client.protocol.search(line))][-256:]
            report['target_focus_trace'] = {
                'captured_tail_start': tail_start,
                'log_size_before_cleanup': log.stat().st_size,
                'lines': [line for line in lines if ('wl_keyboard#' in line or '.sync(' in line
                                                    or ('wl_callback#' in line and '.done(' in line))][-512:]}
        if attempted:
            try:
                cleanup_document_before = state() if editor else None
                native.okay('ghost-application-control ' + lease + ' handback')
                native.okay('ghost-application-reap ' + lease)
                returned = target_window()
                before = report.get('window_before_claim', {})
                restored = {'window': returned, 'document': state() if editor else None,
                            'process_identity': native.identity(process.pid),
                            'file_bytes_unchanged': path.read_text() == original_file,
                            'window_matches': returned is not None and all(returned.get(key) == before.get(key)
                                for key in ('address', 'stableId', 'pid', 'workspace', 'at', 'size', 'floating', 'fullscreen', 'pinned'))}
                if person and start is not None:
                    restored['standin_protocol_events'] = events_since(start)
                    restored['standin'] = {'view': native.view(), 'state': person.state()}
                report['cleanup_restoration'] = restored
                if (not restored['window_matches'] or restored['document'] != cleanup_document_before
                        or restored['process_identity'] != report['application']['process_identity']
                        or not restored['file_bytes_unchanged']):
                    raise AssertionError('Qt failure cleanup did not preserve the existing document and window')
            except (Exception, SystemExit) as error:
                report['cleanup_errors'].append('lease: ' + str(error))
        if person:
            try:
                person.stop()
            except Exception as error:
                report['cleanup_errors'].append('stand-in: ' + str(error))
        for child in [process, *copies]:
            if child:
                try:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
                        report.setdefault('forced_owned_process_cleanup', []).append(child.pid)
                except Exception as error:
                    report['cleanup_errors'].append('owned process: ' + str(error))
        report['application_stderr'] = log.read_text()[-4000:] if log.exists() else ''
        if report['cleanup_errors']:
            report['measurement_complete'] = False
        print(json.dumps(report))
    return 0 if report['measurement_complete'] else 1


if __name__ == '__main__':
    raise SystemExit(run())
