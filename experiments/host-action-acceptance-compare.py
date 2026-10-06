#!/usr/bin/env python3
"""Compare retained four-path evidence. This command starts no runtime."""
import argparse
import json
from pathlib import Path
import re


def normalize(value):
    if isinstance(value, dict):
        return {key: ('SESSION' if key == 'sessionId' else normalize(child)) for key, child in value.items()}
    if isinstance(value, list):
        return [normalize(child) for child in value]
    if isinstance(value, str):
        return re.sub(r'http://127\.0\.0\.1:[0-9]+', 'http://127.0.0.1:PORT', value)
    return value


def contract(report):
    assert report['state'] == 'passed' and report['sourceUnchanged'] and report['privateRootRemoved']
    assert not report['survivorsAfterStop'] and not report['cleanupSurvivors']
    calls = report['brokerCalls']
    assert len(calls) == 7 and all(call['response']['ok'] for call in calls)
    created, stopped = calls[0]['response']['result'], calls[-1]['response']['result']
    observed = calls[5]['response']['result']
    assert created['state'] == 'running' and stopped['state'] == 'closed'
    return {'requests': normalize([{'method': call['method'], 'params': call['params']} for call in calls]),
            'created': {key: created[key] for key in ('backend', 'capabilities', 'surface', 'policy', 'egressTier')},
            'actionResults': normalize([call['response']['result'] for call in calls[1:5]]),
            'observation': {key: observed[key] for key in ('width', 'height', 'mimeType')},
            'observedTitle': observed['presence']['title'],
            'stoppedState': stopped['state'], 'staleCode': report['postStop']['stale']['error']['code']}


def compare(reports):
    assert {r['host'] for r in reports} == {'codex', 'claude', 'api', 'cli'} and len(reports) == 4
    assert len({r['source']['sha256'] for r in reports}) == 1, 'Different tested source digests'
    contracts = [contract(report) for report in reports]
    assert all(value == contracts[0] for value in contracts), 'Action contracts differ'
    hosts = [r for r in reports if r['host'] in ('codex', 'claude')]
    assert len({r['launcher']['resolved'] for r in hosts}) == 2
    assert len({r['launcher']['sha256'] for r in hosts}) == 2
    assert all(len(r['deliveryChecks']) == 7 for r in hosts)
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
