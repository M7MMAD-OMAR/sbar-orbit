#!/usr/bin/env python3
"""Compare retained four-path evidence. This command starts no runtime."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import runpy

helpers = runpy.run_path(str(Path(__file__).with_name('host-action-acceptance.py')))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def normalize(value):
    if isinstance(value, dict):
        return {key: ('SESSION' if key == 'sessionId' else normalize(child)) for key, child in value.items()}
    if isinstance(value, list):
        return [normalize(child) for child in value]
    if isinstance(value, str):
        return re.sub(r'http://127\.0\.0\.1:[0-9]+', 'http://127.0.0.1:PORT', value)
    return value


def image_witness(value, image):
    encoded = base64.b64encode(image).decode()
    expected = {'bytes': len(encoded), 'sha256': hashlib.sha256(encoded.encode()).hexdigest()}
    for node in helpers['expanded'](value):
        if not isinstance(node, dict) or node.get('type') not in ('image', 'input_image', 'image_url'):
            continue
        data = node.get('data')
        media = node.get('mimeType')
        if isinstance(node.get('source'), dict):
            data = node['source'].get('data')
            media = node['source'].get('media_type')
        if media == 'image/jpeg' and (data == expected or data == encoded):
            return True
    return False


def host_contract(report, calls, image):
    host = report['host']
    launcher = report['launcher']
    version, argv = launcher.get('version'), launcher.get('argv')
    require(isinstance(version, str) and ('codex-cli' in version if host == 'codex' else 'Claude Code' in version),
            'Actual host launcher version absent')
    require(isinstance(argv, list) and argv and argv[0] == launcher['path'], 'Actual host invocation absent')
    require(re.fullmatch('[0-9a-f]{64}', launcher['sha256']) is not None and bool(launcher['resolved']),
            'Actual host launcher identity absent')
    tools = ['orbit_create'] + ['orbit_act'] * 4 + ['orbit_observe', 'orbit_stop']
    events, requests = report.get('hostEvents'), report.get('modelRequests')
    require(isinstance(events, list) and events and isinstance(requests, list) and len(requests) == 8,
            'Actual host events or model requests absent')
    if host == 'codex':
        require(argv[1:] == ['app-server', '--listen', 'stdio://'] and report.get('turnStatus') == 'completed',
                'Actual Codex turn did not complete')
        require([e['tool'] for e in events] == tools and all(e['type'] == 'mcpToolCall' and
                e['server'] == 'orbit' and e['status'] == 'completed' and not e.get('error') for e in events),
                'Actual Codex tool sequence failed or absent')
        arguments = [e['arguments'] for e in events]
        require([e.get('id') for e in events] == [f'callid_{i}' for i in range(7)],
                'Actual Codex tool identity differs')
        for index, event in enumerate(events):
            expected = calls[index]['response']['result']
            if index == 5:
                expected = {k: v for k, v in expected.items() if k not in ('imageBytes', 'imageSha256')}
            require(not event['result'].get('isError') and
                    any(node == expected for node in helpers['expanded'](event['result'])),
                    'Actual Codex client result differs from broker result')
        observe = events[5]
        require(observe['id'] == 'callid_5' and observe['arguments'] == calls[5]['params'] and
                image_witness(observe['result'], image), 'Exact Codex client observation image absent')
    else:
        require('--bare' in argv and '--print' in argv and 'stream-json' in argv and
                type(report.get('hostExit')) is int and report['hostExit'] == 0,
                'Actual Claude command failed or absent')
        terminal = [e for e in events if e.get('type') == 'result']
        require(len(terminal) == 1 and terminal[0].get('subtype') == 'success' and not terminal[0].get('is_error'),
                'Actual Claude final turn failed or absent')
        uses = [c for e in events if e.get('type') == 'assistant' for c in e['message']['content']
                if c.get('type') == 'tool_use']
        require([e['name'] for e in uses] == ['mcp__orbit__' + t for t in tools], 'Actual Claude tool sequence absent')
        require([e.get('id') for e in uses] == [f'tool_{i}' for i in range(7)],
                'Actual Claude tool identity differs')
        arguments = [e['input'] for e in uses]
        require(image_witness(requests[6]['latestToolOutput'], image), 'Actual Claude model observation image absent')
    require(arguments == [call['params'] for call in calls], 'Exact host requests differ from broker requests')
    for index, request in enumerate(requests[1:]):
        require(request.get('latestToolOutputId') == (f'callid_{index}' if host == 'codex' else f'tool_{index}'),
                'Actual model output identity differs from host tool call')
        expected = calls[index]['response']['result']
        if index == 5:
            expected = {k: v for k, v in expected.items() if k not in ('imageBytes', 'imageSha256')}
        require(any(node == expected for node in helpers['expanded'](request['latestToolOutput'])),
                'Retained model tool result differs from broker result')


def cli_contract(report, calls, image):
    outputs, events = report.get('cliOutput'), report.get('hostEvents')
    require(isinstance(outputs, list) and len(outputs) == 7 and isinstance(events, list) and len(events) == 7,
            'Actual CLI output or invocation trace absent')
    launcher, source = report['launcher'], report.get('cliSource')
    require(isinstance(source, dict) and isinstance(source.get('path'), str) and
            Path(source['path']).is_absolute() and source['path'].endswith('/src/cli.ts') and
            source.get('sha256') == report['source']['files'].get('src/cli.ts') and
            re.fullmatch('[0-9a-f]{64}', source.get('sha256', '')) is not None,
            'Actual CLI source identity absent or differs from manifest')
    require(isinstance(launcher.get('path'), str) and Path(launcher['path']).is_absolute() and
            isinstance(launcher.get('resolved'), str) and Path(launcher['resolved']).is_absolute() and
            re.fullmatch('[0-9a-f]{64}', launcher.get('sha256', '')) is not None,
            'Actual CLI executable identity absent')
    paths = []
    for index, (receipt, event, call) in enumerate(zip(outputs, events, calls)):
        require(type(receipt.get('step')) is int and receipt['step'] == index and
                type(receipt.get('exit')) is int and receipt['exit'] == 0, 'Actual CLI step failed or out of order')
        argv, params = receipt.get('argv'), call['params']
        require(isinstance(argv, list) and len(argv) == 3 and event.get('argv') == argv,
                'Actual CLI invocation absent or differs from event')
        require(receipt.get('invocation') == [launcher['path'], source['path'], *argv] and
                receipt.get('requestId') == params.get('requestId', 'cli-create'),
                'Actual CLI executable invocation or request identity differs')
        if 1 <= index <= 4:
            require(set(params) == {'sessionId', 'requestId', 'action'}, 'CLI action request has unrepresented fields')
            require(argv[:2] == ['act', params['sessionId']] and json.loads(argv[2]) == params['action'],
                    'Actual CLI action invocation differs from broker request')
        else:
            require(params == ({'backend': 'browser'} if index == 0 else {'sessionId': params['sessionId']}),
                    'CLI session request has unrepresented fields')
            require(argv == ['session', call['method'].split('.')[1], 'browser' if index == 0 else params['sessionId']],
                    'Actual CLI session invocation differs from broker request')
        path = Path(receipt['path'])
        require(path.is_file(), 'Actual CLI stdout artifact absent')
        paths.append(str(path.resolve()))
        with path.open('rb') as stream:
            out = stream.read(8 * 1024 * 1024 + 1)
        require(type(receipt.get('stdoutBytes')) is int and len(out) == receipt['stdoutBytes'] and
                0 < len(out) <= 8 * 1024 * 1024 and hashlib.sha256(out).hexdigest() == receipt.get('stdoutSha256'),
                'Actual CLI stdout artifact differs from retained identity')
        body = json.loads(out)
        require(body.get('ok') is True and 'result' in body, 'Actual CLI stdout result failed or absent')
        result = helpers['summarize'](body['result'])
        require(result == call['response']['result'] and event.get('response') == result,
                'Actual CLI result differs from broker or event')
        if index == 5:
            require(base64.b64decode(body['result']['image'], validate=True) == image,
                    'Actual CLI observation image differs from artifact')
    require(len(set(paths)) == 7, 'Actual CLI stdout artifacts are not distinct')


def contract(report):
    require(report['state'] == 'passed' and report['sourceUnchanged'] is True and report['privateRootRemoved'] is True,
            'Unsuccessful, changed or uncleaned measurement')
    require(type(report['survivorsAfterStop']) is list and report['survivorsAfterStop'] == [] and
            type(report['cleanupSurvivors']) is list and report['cleanupSurvivors'] == [], 'Owned survivor list absent or nonempty')
    witnesses = report['ownedProcessWitnesses']
    require(type(witnesses) is list and bool(witnesses) and all(type(w['pid']) is int and w['pid'] > 0 and
            isinstance(w['startTicks'], str) and w['startTicks'].isdigit() and int(w['startTicks']) > 0 for w in witnesses),
            'Owned process creation identities absent')
    require(len({(w['pid'], w['startTicks']) for w in witnesses}) == len(witnesses), 'Duplicate process witness')
    calls = report['brokerCalls']
    require([c['method'] for c in calls] == ['session.create'] + ['session.act'] * 4 + ['session.observe', 'session.stop'],
            'Wrong actual action sequence')
    require(all(call['response']['ok'] is True for call in calls), 'Failed broker call')
    created, stopped = calls[0]['response']['result'], calls[-1]['response']['result']
    observed = calls[5]['response']['result']
    sid = created['sessionId']
    require(isinstance(sid, str) and bool(sid) and all(c['params']['sessionId'] == sid for c in calls[1:]), 'Wrong actual session identity')
    require([c['params']['action']['type'] for c in calls[1:5]] == ['navigate', 'fill', 'click', 'read'],
            'Wrong input workload')
    marker = 'orbit-disposable-host-input'
    require(report['submissions'] == [marker] and calls[4]['response']['result'] == {'text': marker},
            'Actual form submission/readback absent')
    require(created['state'] == 'running' and created['backend'] == 'browser' and
            calls[0]['params']['backend'] == 'browser' and stopped['state'] == 'closed', 'Wrong browser create/stop state')
    require(type(observed['imageBytes']) is int and observed['imageBytes'] > 0 and
            re.fullmatch('[0-9a-f]{64}', observed['imageSha256']) is not None and
            (observed['width'], observed['height'], observed['mimeType']) == (1280, 800, 'image/jpeg'),
            'Actual JPEG witness absent or wrong dimensions')
    artifact = Path(report['observationArtifact'])
    require(artifact.is_file(), 'Actual JPEG artifact absent')
    with artifact.open('rb') as stream:
        image = stream.read(4 * 1024 * 1024 + 1)
    require(len(image) == observed['imageBytes'] and len(image) <= 4 * 1024 * 1024 and
            hashlib.sha256(image).hexdigest() == observed['imageSha256'] and
            helpers['jpeg_dimensions'](image) == (1280, 800), 'Actual JPEG artifact differs from broker witness')
    sessions, stale = report['postStop']['sessions'], report['postStop']['stale']
    require(sessions['ok'] is True and len(sessions['result']) == 1 and
            sessions['result'][0]['sessionId'] == sid and sessions['result'][0]['state'] == 'closed',
            'Actual session registry is not closed')
    require(stale['ok'] is False and stale['error']['code'] == 'SESSION_CLOSED', 'Stale session was not refused')
    if report['host'] in ('codex', 'claude'):
        require(report['deliveryChecks'] == [{'step': step, 'matched': True} for step in range(1, 8)] and
                all(type(check['step']) is int and check['matched'] is True for check in report['deliveryChecks']),
                'Actual host delivery checks absent, failed or out of order')
        require(not report.get('deliveryError'), 'Actual host delivery failed')
        host_contract(report, calls, image)
    elif report['host'] == 'cli':
        cli_contract(report, calls, image)
    return {'requests': normalize([{'method': call['method'], 'params': call['params']} for call in calls]),
            'created': {key: created[key] for key in ('backend', 'capabilities', 'surface', 'policy', 'egressTier')},
            'actionResults': normalize([call['response']['result'] for call in calls[1:5]]),
            'observation': {key: observed[key] for key in ('width', 'height', 'mimeType')},
            'observedTitle': observed['presence']['title'],
            'stoppedState': stopped['state'], 'staleCode': report['postStop']['stale']['error']['code']}


def compare(reports):
    require({r['host'] for r in reports} == {'codex', 'claude', 'api', 'cli'} and len(reports) == 4, 'Missing or duplicate path')
    for report in reports:
        files = report['source']['files']
        require(bool(files) and all(re.fullmatch('[0-9a-f]{64}', digest) for digest in files.values()),
                'Source file manifest absent or malformed')
        require(hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest() == report['source']['sha256'],
                'Source manifest does not match its digest')
    require(len({r['source']['sha256'] for r in reports}) == 1, 'Different tested source digests')
    contracts = [contract(report) for report in reports]
    require(all(value == contracts[0] for value in contracts), 'Action contracts differ')
    hosts = [r for r in reports if r['host'] in ('codex', 'claude')]
    require(len({r['launcher']['resolved'] for r in hosts}) == 2 and
            len({r['launcher']['sha256'] for r in hosts}) == 2, 'Duplicate actual host identity')
    return {'state': 'passed', 'tier': 'Limited', 'actualHosts': [r['launcher'] for r in hosts],
            'sourceSha256': reports[0]['source']['sha256'], 'contract': contracts[0],
            'limit': 'Fresh disposable Fedora browser and deterministic local model. Policy configuration parity, real model reasoning, accounts, native and other OS hosts not measured.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs=4, type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = compare([json.loads(path.read_text()) for path in args.reports])
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'state': result['state'], 'sourceSha256': result['sourceSha256'], 'output': str(args.output)}))
