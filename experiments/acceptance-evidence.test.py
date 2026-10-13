"""Receipt integrity controls with synthetic artifacts, never participant evidence."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest import mock

validator = runpy.run_path(str(Path(__file__).with_name('acceptance-evidence.py')))
LEDGER = json.loads((Path(__file__).parents[1] / 'docs/acceptance-evidence.json').read_text())


class EvidenceControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orbit-receipt-control-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b'Synthetic unit-test witness, no human or Orbit runtime participated.'
        files = {'src/fixture.ts': hashlib.sha256(b'fixture').hexdigest()}
        sha = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        self.receipt = {'schemaVersion': 1, 'gate': 'U1', 'state': 'passed', 'tier': 'Limited',
            'limit': 'Synthetic validator control only', 'runId': 'unit-fixture',
            'source': {'gitHead': 'a' * 40, 'files': files, 'sha256': sha},
            'environment': {'os': 'test', 'architecture': 'test', 'deviceClass': 'unit-fixture',
                            'installation': 'synthetic', 'runtimeVersion': 'test'},
            'artifacts': [{'id': 'runtime', 'kind': 'runtime', 'path': 'runtime.json',
                           'sha256': hashlib.sha256(self.content).hexdigest()},
                          {'id': 'participant', 'kind': 'participant', 'path': 'participant.json',
                           'sha256': hashlib.sha256(self.content).hexdigest()}],
            'participant': {'recordedBy': 'participant', 'runId': 'unit-fixture',
                            'sourceSha256': sha, 'artifact': 'participant'},
            'observations': {name: {'value': 'synthetic', 'artifact': 'runtime'} for name in
                             next(g for g in LEDGER['gates'] if g['id'] == 'U1')['requiredObservations']}}

        self.refresh_witnesses()

    def refresh_witnesses(self):
        observations = {name: value['value'] for name, value in self.receipt['observations'].items()}
        common = {'gate': self.receipt['gate'], 'runId': self.receipt['runId'],
                  'sourceSha256': self.receipt['source']['sha256'],
                  'gitHead': self.receipt['source']['gitHead'], 'observations': observations}
        for artifact in self.receipt['artifacts']:
            witness = {**common, **({'environment': self.receipt['environment']} if
                       artifact['kind'] == 'runtime' else {'recordedBy': 'participant'})}
            content = json.dumps(witness, sort_keys=True).encode()
            (self.root / artifact['path']).write_bytes(content)
            artifact['sha256'] = hashlib.sha256(content).hexdigest()

    def alter_witness(self, index, field, value):
        artifact = self.receipt['artifacts'][index]
        path = self.root / artifact['path']
        witness = json.loads(path.read_bytes())
        witness[field] = value
        content = json.dumps(witness, sort_keys=True).encode()
        path.write_bytes(content)
        artifact['sha256'] = hashlib.sha256(content).hexdigest()

    def validate(self):
        return validator['validate_receipt'](self.receipt, LEDGER, self.root)

    def test_prepared_ledger_covers_all_stories_and_contracts(self):
        self.assertEqual(len(validator['validate_ledger'](LEDGER)), 35)

    def test_integrity_success_never_closes_acceptance(self):
        self.assertEqual(self.validate()['acceptance'], 'open')

    def test_artifact_changes_are_rejected(self):
        (self.root / 'runtime.json').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'digest'):
            self.validate()

    def test_source_manifest_changes_are_rejected(self):
        self.receipt['source']['files']['src/fixture.ts'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'manifest digest'):
            self.validate()

    def test_other_expected_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'another tested source'):
            validator['validate_receipt'](self.receipt, LEDGER, self.root, 'c' * 64)

    def test_agent_authored_participant_claim_is_rejected(self):
        self.receipt['participant']['recordedBy'] = 'agent'
        with self.assertRaisesRegex(ValueError, 'Participant-origin'):
            self.validate()

    def test_other_participant_run_is_rejected(self):
        self.receipt['participant']['runId'] = 'another-run'
        with self.assertRaisesRegex(ValueError, 'Participant-origin'):
            self.validate()

    def test_missing_observation_is_rejected(self):
        del self.receipt['observations']['hostInputCalls']
        with self.assertRaisesRegex(ValueError, 'observations absent'):
            self.validate()

    def test_missing_runtime_witness_is_rejected(self):
        self.receipt['artifacts'][0]['kind'] = 'review'
        with self.assertRaisesRegex(ValueError, 'runtime receipt absent'):
            self.validate()

    def test_native_execution_claim_remains_held(self):
        self.receipt['gate'] = 'U9'
        with self.assertRaisesRegex(ValueError, 'held gate'):
            self.validate()

    def test_missing_measurement_with_reason_stays_open(self):
        receipt = {'schemaVersion': 1, 'gate': 'H-hermes', 'state': 'not measured',
                   'limit': 'Dependency environment absent', 'reason': 'Owner-provisioned dependencies required'}
        self.assertEqual(validator['validate_receipt'](receipt, LEDGER, self.root)['acceptance'], 'open')

    def test_artifact_path_escape_is_rejected(self):
        self.receipt['artifacts'][0]['path'] = '../runtime.json'
        with self.assertRaisesRegex(ValueError, 'receipt directory'):
            self.validate()

    def test_artifact_symlink_escape_is_rejected(self):
        (self.root / 'outside').symlink_to(self.root.parent)
        self.receipt['artifacts'][0]['path'] = 'outside/arbitrary.json'
        with self.assertRaisesRegex(ValueError, 'symlink escapes'):
            self.validate()

    def test_duplicate_artifacts_are_rejected(self):
        self.receipt['artifacts'][1]['id'] = 'runtime'
        with self.assertRaisesRegex(ValueError, 'duplicate artifact'):
            self.validate()

    def test_missing_environment_is_rejected(self):
        del self.receipt['environment']['runtimeVersion']
        with self.assertRaisesRegex(ValueError, 'environment identity'):
            self.validate()

    def test_ledger_cannot_relax_native_hold(self):
        ledger = copy.deepcopy(LEDGER)
        next(g for g in ledger['gates'] if g['id'] == 'S-host-conflict')['held'] = False
        with self.assertRaisesRegex(ValueError, 'hold cannot be relaxed'):
            validator['validate_ledger'](ledger)

    def test_missing_or_duplicate_gate_is_rejected(self):
        for gates in (LEDGER['gates'][:-1], LEDGER['gates'] + [LEDGER['gates'][0]]):
            with self.assertRaises(ValueError):
                validator['validate_ledger']({**LEDGER, 'gates': gates})


    def test_runtime_run_source_gate_head_and_environment_are_bound(self):
        for field, value in [('runId', 'other'), ('sourceSha256', 'c' * 64),
                             ('gate', 'U2'), ('gitHead', 'b' * 40), ('environment', {})]:
            self.refresh_witnesses()
            self.alter_witness(0, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'binding differs'):
                self.validate()

    def test_participant_artifact_origin_and_run_are_bound(self):
        for field, value in [('runId', 'other'), ('recordedBy', 'agent')]:
            self.refresh_witnesses()
            self.alter_witness(1, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate()

    def test_claimed_observation_must_match_retained_witness(self):
        self.receipt['observations']['hostInputCalls']['value'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'differs from retained witness'):
            self.validate()

    def test_review_artifact_cannot_witness_observation(self):
        artifact = {'id': 'review', 'kind': 'review', 'path': 'review.json'}
        content = b'{}'
        (self.root / artifact['path']).write_bytes(content)
        artifact['sha256'] = hashlib.sha256(content).hexdigest()
        self.receipt['artifacts'].append(artifact)
        self.receipt['observations']['hostInputCalls']['artifact'] = 'review'
        with self.assertRaisesRegex(ValueError, 'lacks a retained witness'):
            self.validate()

    def test_participant_attestation_must_match_claimed_observations(self):
        self.alter_witness(1, 'observations', {})
        with self.assertRaisesRegex(ValueError, 'attestation differs'):
            self.validate()

    def test_artifact_size_and_nonregular_file_are_rejected(self):
        artifact = self.receipt['artifacts'][0]
        (self.root / artifact['path']).write_bytes(b'x' * (4 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, 'exceeds 4 MiB'):
            self.validate()
        (self.root / artifact['path']).unlink()
        (self.root / artifact['path']).mkdir()
        with self.assertRaisesRegex(ValueError, 'exceeds 4 MiB'):
            self.validate()

    def test_growth_after_size_check_cannot_supply_unbounded_bytes(self):
        artifact = self.receipt['artifacts'][0]
        path = self.root / artifact['path']
        oversized = path.read_bytes() + b' ' * (4 * 1024 * 1024)
        artifact['sha256'] = hashlib.sha256(oversized).hexdigest()
        original_read_bytes = Path.read_bytes
        original_fstat = os.fstat
        original_read = os.read
        injected = False
        bytes_read = 0
        runtime_identity = path.stat()

        def grow():
            nonlocal injected
            if not injected:
                path.write_bytes(oversized)
                injected = True

        def grow_before_path_read(candidate):
            # The old helper already completed its is_file/stat size checks.
            if candidate == path:
                grow()
            return original_read_bytes(candidate)

        def grow_after_descriptor_stat(descriptor):
            result = original_fstat(descriptor)
            if (result.st_dev, result.st_ino) == (runtime_identity.st_dev, runtime_identity.st_ino):
                # Return the real pre-growth metadata, then grow the actual file.
                grow()
            return result

        def counted_read(descriptor, size):
            nonlocal bytes_read
            result = original_read(descriptor, size)
            bytes_read += len(result)
            return result

        # Both paths inject real disk growth after the reader's size sample.
        # No fake file contents, metadata or helper implementation are supplied.
        with mock.patch.object(Path, 'read_bytes', grow_before_path_read), \
                mock.patch.object(os, 'fstat', grow_after_descriptor_stat), \
                mock.patch.object(os, 'read', counted_read):
            try:
                with self.assertRaisesRegex(ValueError, 'bounded read|exceeds 4 MiB'):
                    self.validate()
            finally:
                self.assertTrue(injected, 'Growth witness must actually execute')
                self.assertGreater(path.stat().st_size, 4 * 1024 * 1024)
        self.assertGreater(bytes_read, 0, 'Descriptor control must perform the bounded read')
        self.assertLessEqual(bytes_read, 4 * 1024 * 1024 + 1)

    def test_internal_symlink_is_rejected(self):
        (self.root / 'alias.json').symlink_to(self.root / 'runtime.json')
        self.receipt['artifacts'][0]['path'] = 'alias.json'
        with self.assertRaisesRegex(ValueError, 'symlink escapes'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
