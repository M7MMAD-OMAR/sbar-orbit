"""Negative controls for retained parity receipts. No runtime or account access."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest

compare = runpy.run_path(str(Path(__file__).with_name('host-action-acceptance-compare.py')))['compare']


def reports(root):
    image = bytes.fromhex("ffd8ffc00011080320050003011100021100031100ffd9")
    image_path = root / "synthetic.jpg"
    image_path.write_bytes(image)
    encoded = base64.b64encode(image).decode()
    image_witness = {"bytes": len(encoded), "sha256": hashlib.sha256(encoded.encode()).hexdigest()}
    files = {'src/fixture.ts': hashlib.sha256(b'fixture').hexdigest(),
             'src/cli.ts': hashlib.sha256(b'cli fixture').hexdigest()}
    source = {'files': files, 'sha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
    sid = 'disposable'
    created = {'sessionId': sid, 'state': 'running', 'backend': 'browser', 'capabilities': [],
               'surface': {}, 'policy': {}, 'egressTier': 'loopback'}
    observed = {'width': 1280, 'height': 800, 'mimeType': 'image/jpeg', 'imageBytes': len(image),
                'imageSha256': hashlib.sha256(image).hexdigest(), 'presence': {'title': 'Orbit host acceptance'}}
    actions = [{'type': 'navigate', 'url': 'http://127.0.0.1:12345'},
               {'type': 'fill', 'selector': '#value', 'text': 'orbit-disposable-host-input'},
               {'type': 'click', 'selector': '#submit'}, {'type': 'read', 'selector': '#result'}]
    calls = [{'method': 'session.create', 'params': {'backend': 'browser'},
              'response': {'ok': True, 'result': created}}]
    for index, action in enumerate(actions):
        calls.append({'method': 'session.act', 'params': {'sessionId': sid,
                      'requestId': ['navigate', 'fill', 'click', 'read'][index], 'action': action},
                      'response': {'ok': True, 'result': {'text': 'orbit-disposable-host-input'} if index == 3 else {}}})
    calls += [{'method': 'session.observe', 'params': {'sessionId': sid}, 'response': {'ok': True, 'result': observed}},
              {'method': 'session.stop', 'params': {'sessionId': sid}, 'response': {'ok': True, 'result': {'state': 'closed'}}}]
    result = []
    for host in ('codex', 'claude', 'api', 'cli'):
        result.append(copy.deepcopy({'host': host, 'state': 'passed', 'source': source,
          'sourceUnchanged': True, 'privateRootRemoved': True, 'survivorsAfterStop': [], 'cleanupSurvivors': [],
          'ownedProcessWitnesses': [{'pid': 123, 'startTicks': '456'}], 'brokerCalls': calls,
          'submissions': ['orbit-disposable-host-input'],
          'deliveryChecks': [{'step': step, 'matched': True} for step in range(1, 8)],
          'observationArtifact': str(image_path),
          'launcher': {'path': '/disposable/' + host, 'resolved': '/disposable/' + host,
                       'sha256': hashlib.sha256(host.encode()).hexdigest(),
                       'version': 'codex-cli test' if host == 'codex' else 'test (Claude Code)',
                       'argv': ['/disposable/' + host, 'app-server', '--listen', 'stdio://'] if host == 'codex' else
                               ['/disposable/' + host, '--bare', '--print', '--output-format', 'stream-json']},
          'postStop': {'sessions': {'ok': True, 'result': [{'sessionId': sid, 'state': 'closed'}]},
                       'stale': {'ok': False, 'error': {'code': 'SESSION_CLOSED'}}}}))
    tools = ['orbit_create'] + ['orbit_act'] * 4 + ['orbit_observe', 'orbit_stop']
    for report in result:
        report['modelRequests'] = [{'path': '/local-model'}]
        contents = []
        for index, call in enumerate(calls):
            returned = call['response']['result']
            metadata = {k: v for k, v in returned.items() if k not in ('imageBytes', 'imageSha256')}
            content = [{'type': 'text', 'text': json.dumps(metadata)}]
            if index == 5:
                content.insert(0, {'type': 'image', 'data': image_witness, 'mimeType': 'image/jpeg'})
            contents.append(content)
            report['modelRequests'].append({'path': '/local-model', 'latestToolOutput': content})
            report['modelRequests'][-1]['latestToolOutputId'] = f'callid_{index}' if report['host'] == 'codex' else f'tool_{index}'
        if report['host'] == 'codex':
            report['turnStatus'] = 'completed'
            report['modelImageForwarding'] = 'not measured: only the native host event image was validated'
            report['hostEvents'] = [{'type': 'mcpToolCall', 'id': f'callid_{i}', 'server': 'orbit',
                'tool': name, 'status': 'completed', 'arguments': copy.deepcopy(calls[i]['params']),
                'result': {'content': contents[i]}} for i, name in enumerate(tools)]
        elif report['host'] == 'claude':
            report['hostExit'] = 0
            report['hostEvents'] = [{'type': 'assistant', 'message': {'content':
                [{'type': 'tool_use', 'id': f'tool_{i}', 'name': 'mcp__orbit__' + name, 'input': copy.deepcopy(calls[i]['params'])}]}}
                for i, name in enumerate(tools)] + [{'type': 'result', 'subtype': 'success', 'is_error': False}]
        elif report['host'] == 'cli':
            report['cliSource'] = {'path': '/disposable/src/cli.ts', 'sha256': files['src/cli.ts']}
            report['hostEvents'], report['cliOutput'] = [], []
            for i, call in enumerate(calls):
                params = call['params']
                argv = (['act', sid, json.dumps(params['action'])] if i in range(1, 5) else
                        ['session', call['method'].split('.')[1], 'browser' if i == 0 else sid])
                returned = copy.deepcopy(call['response']['result'])
                if i == 5:
                    returned.pop('imageBytes')
                    returned.pop('imageSha256')
                    returned['image'] = encoded
                out = (json.dumps({'ok': True, 'result': returned}) + '\n').encode()
                path = root / f'cli.step-{i}.stdout'
                path.write_bytes(out)
                report['cliOutput'].append({'step': i, 'argv': argv, 'exit': 0, 'stdoutBytes': len(out),
                    'stdoutSha256': hashlib.sha256(out).hexdigest(), 'path': str(path), 'stderr': '',
                    'invocation': [report['launcher']['path'], report['cliSource']['path'], *argv],
                    'requestId': params.get('requestId', 'cli-create')})
                report['hostEvents'].append({'argv': argv, 'response': copy.deepcopy(call['response']['result'])})
    return result


class ParityControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orbit-parity-control-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def rejected(self, mutate):
        values = reports(self.root)
        for value in values:
            mutate(value)
        with self.assertRaises((AssertionError, ValueError)):
            compare(values)

    def test_valid_receipts_preserve_limited_tier(self):
        self.assertEqual(compare(reports(self.root))['tier'], 'Limited')

    def test_wrong_action_sequence_is_rejected_even_when_all_paths_agree(self):
        self.rejected(lambda r: r['brokerCalls'][1].update(method='session.pause'))

    def test_wrong_session_is_rejected_even_when_all_paths_agree(self):
        self.rejected(lambda r: r['brokerCalls'][2]['params'].update(sessionId='other'))

    def test_empty_process_witnesses_are_rejected(self):
        self.rejected(lambda r: r.update(ownedProcessWitnesses=[]))

    def test_failed_delivery_check_is_rejected(self):
        self.rejected(lambda r: r['deliveryChecks'][2].update(matched=False))

    def test_duplicate_delivery_steps_are_rejected(self):
        self.rejected(lambda r: r['deliveryChecks'][2].update(step=2))

    def test_stale_request_success_is_rejected(self):
        self.rejected(lambda r: r['postStop']['stale'].update(ok=True))

    def test_missing_image_bytes_are_rejected(self):
        self.rejected(lambda r: r['brokerCalls'][5]['response']['result'].update(imageBytes=0))

    def test_no_actual_form_submission_is_rejected(self):
        self.rejected(lambda r: r.update(submissions=[]))

    def test_changed_source_manifest_is_rejected(self):
        self.rejected(lambda r: r['source']['files'].update({'src/fixture.ts': 'c' * 64}))

    def test_null_survivor_lists_are_rejected(self):
        self.rejected(lambda r: r.update(survivorsAfterStop=None, cleanupSurvivors=None))

    def test_zero_process_start_is_rejected(self):
        self.rejected(lambda r: r['ownedProcessWitnesses'][0].update(startTicks='0'))

    def test_missing_host_trace_is_rejected(self):
        self.rejected(lambda r: r.update(hostEvents=[], modelRequests=[]))

    def test_failed_codex_turn_is_rejected(self):
        self.rejected(lambda r: r.update(turnStatus='failed'))

    def test_failed_claude_exit_is_rejected(self):
        self.rejected(lambda r: r.update(hostExit=1))

    def test_wrong_browser_backend_is_rejected(self):
        self.rejected(lambda r: r['brokerCalls'][0]['response']['result'].update(backend='native'))

    def test_missing_launcher_version_is_rejected(self):
        self.rejected(lambda r: r['launcher'].pop('version'))

    def test_changed_host_image_is_rejected(self):
        def mutate(report):
            if report['host'] == 'codex':
                report['hostEvents'][5]['result']['content'][0]['data']['sha256'] = 'a' * 64
        self.rejected(mutate)

    def test_missing_observation_artifact_is_rejected(self):
        self.rejected(lambda r: r.update(observationArtifact=str(self.root / 'absent.jpg')))

    def test_mismatched_sources_are_rejected(self):
        values = reports(self.root)
        values[1]['source']['sha256'] = 'c' * 64
        with self.assertRaises((AssertionError, ValueError)):
            compare(values)

    def test_missing_cli_trace_is_rejected(self):
        self.rejected(lambda r: r.update(hostEvents=[], cliOutput=[]) if r['host'] == 'cli' else None)

    def test_failed_cli_exit_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][3].update(exit=1) if r['host'] == 'cli' else None)

    def test_wrong_cli_invocation_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][1].update(argv=['session', 'stop', 'disposable']) if r['host'] == 'cli' else None)

    def test_missing_cli_stdout_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][5].update(path=str(self.root / 'absent.stdout')) if r['host'] == 'cli' else None)

    def test_cli_stdout_digest_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][5].update(stdoutSha256='a' * 64) if r['host'] == 'cli' else None)

    def test_cli_stdout_length_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][5].update(stdoutBytes=1) if r['host'] == 'cli' else None)

    def test_cli_result_trace_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][4].update(response={'text': 'other'}) if r['host'] == 'cli' else None)

    def rewrite_cli_stdout(self, report, index, mutate):
        if report['host'] != 'cli':
            return
        receipt = report['cliOutput'][index]
        path = Path(receipt['path'])
        body = json.loads(path.read_bytes())
        mutate(body)
        out = (json.dumps(body) + '\n').encode()
        path.write_bytes(out)
        receipt.update(stdoutBytes=len(out), stdoutSha256=hashlib.sha256(out).hexdigest())

    def test_cli_failed_stdout_result_is_rejected(self):
        self.rejected(lambda r: self.rewrite_cli_stdout(r, 3, lambda b: b.update(ok=False)))

    def test_cli_changed_stdout_result_is_rejected(self):
        self.rejected(lambda r: self.rewrite_cli_stdout(r, 4, lambda b: b.update(result={'text': 'other'})))

    def test_cli_changed_stdout_image_is_rejected(self):
        self.rejected(lambda r: self.rewrite_cli_stdout(r, 5, lambda b: b['result'].update(image=base64.b64encode(b'other').decode())))

    def test_codex_extra_create_policy_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][0]['arguments'].update(policy={'persist': True}) if r['host'] == 'codex' else None)

    def test_claude_extra_create_policy_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][0]['message']['content'][0]['input'].update(policy={'persist': True}) if r['host'] == 'claude' else None)

    def test_codex_extra_stop_argument_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][6]['arguments'].update(force=True) if r['host'] == 'codex' else None)

    def test_codex_nonobserve_identity_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][1].update(id='callid_other') if r['host'] == 'codex' else None)

    def test_claude_tool_identity_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][1]['message']['content'][0].update(id='tool_other') if r['host'] == 'claude' else None)

    def test_codex_client_result_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][4].update(result={'content': [{'type': 'text', 'text': '{"text":"other"}'}]}) if r['host'] == 'codex' else None)

    def test_codex_wrong_image_media_is_rejected(self):
        self.rejected(lambda r: r['hostEvents'][5]['result']['content'][0].update(mimeType='image/png') if r['host'] == 'codex' else None)

    def test_missing_cli_executable_provenance_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][0].pop('invocation') if r['host'] == 'cli' else None)

    def test_wrong_cli_executable_provenance_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][0]['invocation'].__setitem__(0, '/other/bun') if r['host'] == 'cli' else None)

    def test_wrong_cli_source_provenance_is_rejected(self):
        self.rejected(lambda r: r['cliSource'].update(sha256='a' * 64) if r['host'] == 'cli' else None)

    def test_wrong_cli_request_identity_is_rejected(self):
        self.rejected(lambda r: r['cliOutput'][2].update(requestId='other') if r['host'] == 'cli' else None)

    def test_codex_missing_model_output_identity_is_rejected(self):
        self.rejected(lambda r: r['modelRequests'][2].pop('latestToolOutputId') if r['host'] == 'codex' else None)

    def test_codex_changed_model_output_identity_is_rejected(self):
        self.rejected(lambda r: r['modelRequests'][2].update(latestToolOutputId='callid_other') if r['host'] == 'codex' else None)

    def test_claude_changed_model_output_identity_is_rejected(self):
        self.rejected(lambda r: r['modelRequests'][2].update(latestToolOutputId='tool_other') if r['host'] == 'claude' else None)

    def test_cli_unrepresentable_create_fields_are_rejected(self):
        def mutate(report):
            report['brokerCalls'][0]['params'].update(policy={'persist': True})
            if report['host'] == 'codex':
                report['hostEvents'][0]['arguments'].update(policy={'persist': True})
            elif report['host'] == 'claude':
                report['hostEvents'][0]['message']['content'][0]['input'].update(policy={'persist': True})
        self.rejected(mutate)


if __name__ == '__main__':
    unittest.main()
