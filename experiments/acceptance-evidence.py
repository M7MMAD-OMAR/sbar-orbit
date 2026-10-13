#!/usr/bin/env python3
"""Validate acceptance receipt integrity without starting Orbit or closing a gate."""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
import re

REQUIRED = ({f'U{number}' for number in range(1, 13)} |
            {'F-timeout', 'F-invalid-session', 'F-duplicate-action', 'F-busy-profile',
             'F-backend-crash', 'F-unavailable-capture', 'F-preview-disconnection',
             'F-shutdown-during-input', 'S-selected-only', 'S-in-place-save',
             'S-atomic-save', 'S-canonical-lease', 'S-host-conflict', 'S-cleanup',
             'A-login-restart', 'A-competing-lease', 'A-source-integrity',
             'H-codex-client', 'H-codex-model', 'H-claude-model', 'H-hermes',
             'H-release-policy', 'P-matched-pairs'})
STATES = {'passed', 'failed', 'refused', 'not measured', 'blocked'}
HELD = {'U9', 'S-in-place-save', 'S-atomic-save', 'S-host-conflict'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def validate_ledger(ledger):
    require(ledger.get('schemaVersion') == 1, 'Unknown ledger schema')
    gates = ledger['gates']
    require(len({g['id'] for g in gates}) == len(gates), 'Duplicate gate')
    require({g['id'] for g in gates} == REQUIRED, 'Missing or unknown acceptance gate')
    for gate in gates:
        require(gate['state'] in ('not measured', 'blocked'), 'Prepared ledger cannot certify a result')
        require(bool(gate['requiredObservations']) and len(set(gate['requiredObservations'])) ==
                len(gate['requiredObservations']), 'Missing or duplicate observation contract')
        require(isinstance(gate['participantRequired'], bool) and isinstance(gate['held'], bool), 'Invalid gate boundary')
        require(bool(gate['scope']) and bool(gate['nextEvidence']), 'Missing scope or evidence contract')
    require({g['id'] for g in gates if g['held']} == HELD, 'Native release hold cannot be relaxed')
    return {g['id']: g for g in gates}


def artifact_bytes(artifact, root):
    path = Path(artifact['path'])
    require(not path.is_absolute() and '..' not in path.parts and path.parts,
            'Artifact path must stay in the receipt directory')
    require(len(path.parts) <= 32 and len(str(path).encode()) <= 4096,
            'Artifact path exceeds limit')
    # Walk directory descriptors without following symlinks. Every read is bounded.
    descriptors = []
    try:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in path.parts[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
            descriptors.append(directory)
        descriptor = os.open(path.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
        descriptors.append(descriptor)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 4 * 1024 * 1024,
                'Artifact absent or exceeds 4 MiB')
        content = bytearray()
        while len(content) <= 4 * 1024 * 1024:
            block = os.read(descriptor, min(65536, 4 * 1024 * 1024 + 1 - len(content)))
            if not block:
                break
            content.extend(block)
        after = os.fstat(descriptor)
        current = os.stat(path.parts[-1], dir_fd=directory, follow_symlinks=False)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size,
                                 info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(after) == identity(current) and
                len(content) == before.st_size, 'Artifact changed during bounded read')
        require(content and digest(artifact['sha256']) and
                hashlib.sha256(content).hexdigest() == artifact['sha256'],
                'Artifact bytes do not match digest')
        return bytes(content)
    except OSError as error:
        raise ValueError('Artifact absent or symlink escapes receipt directory') from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def bound_witness(content, receipt, source_digest, kind):
    try:
        witness = json.loads(content)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError('Bound witness must be JSON') from error
    require(isinstance(witness, dict) and witness.get('gate') == receipt['gate'] and
            witness.get('runId') == receipt['runId'] and
            witness.get('sourceSha256') == source_digest and
            witness.get('gitHead') == receipt['source']['gitHead'],
            'Artifact run/source/gate binding differs')
    require(isinstance(witness.get('observations'), dict), 'Artifact observations absent')
    if kind == 'runtime':
        require(witness.get('environment') == receipt['environment'],
                'Runtime artifact environment binding differs')
    else:
        require(witness.get('recordedBy') == 'participant',
                'Participant artifact origin declaration absent')
    return witness


def validate_receipt(receipt, ledger, root, expected_source=None):
    gates = validate_ledger(ledger)
    require(receipt.get('schemaVersion') == 1 and receipt['gate'] in gates, 'Unknown receipt schema or gate')
    gate = gates[receipt['gate']]
    state = receipt['state']
    require(state in STATES and bool(receipt['limit']), 'Unknown result or absent measurement limit')
    require(not gate['held'] or state in ('blocked', 'not measured'), 'Native held gate cannot claim execution')
    if state in ('blocked', 'not measured'):
        require(bool(receipt['reason']), 'Missing external prerequisite')
        return {'gate': gate['id'], 'receiptIntegrity': 'valid', 'claimedState': state, 'acceptance': 'open'}
    source = receipt['source']
    files = source['files']
    require(bool(files) and all(digest(v) for v in files.values()), 'Source manifest absent or malformed')
    require(all(not Path(p).is_absolute() and '..' not in Path(p).parts for p in files), 'Invalid source manifest path')
    actual_digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    require(source['sha256'] == actual_digest, 'Source manifest digest mismatch')
    require(re.fullmatch('[0-9a-f]{40}', source['gitHead']) is not None, 'Missing source Git identity')
    require(expected_source is None or expected_source == actual_digest, 'Receipt is for another tested source')
    environment = receipt['environment']
    require(all(isinstance(environment.get(k), str) and environment[k] for k in
                ('os', 'architecture', 'deviceClass', 'installation', 'runtimeVersion')), 'Missing executed environment identity')
    require(isinstance(receipt.get('runId'), str) and bool(receipt['runId']), 'Missing run identity')
    artifacts = receipt['artifacts']
    require(isinstance(artifacts, list) and 0 < len(artifacts) <= 128 and len({a['id'] for a in artifacts}) == len(artifacts), 'Missing or duplicate artifact')
    witnesses = {}
    for artifact in artifacts:
        require(artifact['kind'] in ('runtime', 'participant', 'review'), 'Unknown artifact kind')
        content = artifact_bytes(artifact, root)
        if artifact['kind'] in ('runtime', 'participant'):
            witnesses[artifact['id']] = bound_witness(content, receipt, actual_digest, artifact['kind'])
    identifiers = {a['id'] for a in artifacts}
    require(any(a['kind'] == 'runtime' for a in artifacts), 'Actual runtime receipt absent')
    observations = receipt['observations']
    if state == 'passed':
        require(set(observations) == set(gate['requiredObservations']), 'Required observations absent or unknown')
        for name, observation in observations.items():
            require(observation['artifact'] in witnesses and observation['value'] is not None,
                    'Observation lacks a retained witness')
            require(name in witnesses[observation['artifact']]['observations'] and
                    witnesses[observation['artifact']]['observations'][name] == observation['value'],
                    'Observation differs from retained witness')
        if gate['participantRequired']:
            participant_artifacts = {a['id'] for a in artifacts if a['kind'] == 'participant'}
            attestation = receipt['participant']
            require(attestation['recordedBy'] == 'participant' and attestation['runId'] == receipt['runId'] and
                    attestation['sourceSha256'] == actual_digest and attestation['artifact'] in participant_artifacts,
                    'Participant-origin receipt with matching run and source absent')
            require(witnesses[attestation['artifact']]['observations'] ==
                    {name: observation['value'] for name, observation in observations.items()},
                    'Participant attestation differs from claimed observations')
    else:
        require(bool(receipt['reason']), 'Failure/refusal needs an observed reason')
    require(isinstance(receipt['runId'], str) and bool(receipt['runId']) and
            receipt['tier'] in ('Limited', 'Measured'), 'Missing run or unsupported evidence tier')
    return {'gate': gate['id'], 'receiptIntegrity': 'valid', 'claimedState': state,
            'sourceSha256': actual_digest, 'acceptance': 'open',
            'limit': 'Integrity only. Actual observations, participant origin and support claims require independent review.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ledger', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--source-sha256', help='Required tested runtime digest when reviewing a final-source receipt')
    args = parser.parse_args()
    try:
        ledger = json.loads(args.ledger.read_text())
        gates = validate_ledger(ledger)
        result = ({'receiptIntegrity': 'valid', 'acceptance': 'open', 'gates': len(gates)} if args.receipt is None else
                  validate_receipt(json.loads(args.receipt.read_text()), ledger, args.receipt.parent, args.source_sha256))
        print(json.dumps(result, sort_keys=True))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({'receiptIntegrity': 'invalid', 'acceptance': 'open', 'error': str(error)}))
        raise SystemExit(1)
