"""Pure negative controls for host-delivery acceptance. No hosts or browser start."""
import base64
import hashlib
import json
from pathlib import Path
import runpy
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('host-action-acceptance.py')))


class DeliveryControls(unittest.TestCase):
    def body(self, result):
        return {'input': [{'type': 'function_call_output', 'output': json.dumps(result)}]}

    def test_absent_host_result_is_rejected(self):
        with self.assertRaises(AssertionError):
            probe['delivered_result']({'input': []}, 'codex', {'sessionId': 'real'})

    def test_broker_session_id_cannot_repair_wrong_host_result(self):
        calls = [{'method': 'session.create', 'response': {'ok': True, 'result': {'sessionId': 'real'}}}]
        body = self.body({'sessionId': 'wrong'})
        with self.assertRaises(AssertionError):
            probe['next_call'](body, 'codex', 1, [('orbit_create', {}), ('orbit_act', {})], calls)

    def test_empty_host_content_is_rejected(self):
        with self.assertRaises(AssertionError):
            probe['delivered_result'](self.body({'content': []}), 'codex', {'sessionId': 'real'})

    def test_read_text_loss_is_rejected(self):
        with self.assertRaises(AssertionError):
            probe['delivered_result'](self.body({'text': ''}), 'codex', {'text': 'submitted'})

    def test_observe_metadata_without_image_is_rejected(self):
        image = b'disposable-image'
        expected = {'width': 1280, 'height': 800, 'imageBytes': len(image),
                    'imageSha256': hashlib.sha256(image).hexdigest()}
        with self.assertRaises(AssertionError):
            probe['delivered_result'](self.body({'width': 1280, 'height': 800}), 'codex', expected, True)

    def test_changed_observation_image_is_rejected(self):
        expected = {'width': 1280, 'height': 800, 'imageBytes': 1,
                    'imageSha256': hashlib.sha256(b'original').hexdigest()}
        body = self.body([{'type': 'text', 'text': '{"width":1280,"height":800}'},
                          {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(b'wrong').decode()}])
        with self.assertRaises(AssertionError):
            probe['delivered_result'](body, 'codex', expected, True)

    def test_claude_error_result_is_rejected(self):
        body = {'messages': [{'role': 'user', 'content': [{'type': 'tool_result', 'is_error': True,
                'content': '{"sessionId":"real"}'}]}]}
        with self.assertRaises(AssertionError):
            probe['delivered_result'](body, 'claude', {'sessionId': 'real'})

    def test_codex_observe_event_must_match_exact_session(self):
        body = {'input': [{'type': 'function_call', 'arguments': '{"sessionId":"real"}'},
                {'type': 'function_call_output', 'output': '{"width":1280,"height":800}'}]}
        calls = [{'response': {'ok': True, 'result': {}}}] * 5 + [{'response': {'ok': True,
                 'result': {'width': 1280, 'height': 800, 'imageBytes': 1, 'imageSha256': 'unused'}}}]
        event = {'id': 'callid_5', 'server': 'orbit', 'tool': 'orbit_observe', 'status': 'completed',
                 'arguments': {'sessionId': 'wrong'}, 'result': {}}
        with self.assertRaises(AssertionError):
            probe['next_call'](body, 'codex', 6, [('orbit_create', {})] * 7, calls, event)

    def test_successful_create_uses_host_session_id(self):
        calls = [{'response': {'ok': True, 'result': {'sessionId': 'real'}}}]
        name, arguments, image = probe['next_call'](self.body({'sessionId': 'real'}), 'codex', 1,
            [('orbit_create', {}), ('orbit_act', {'requestId': 'next'})], calls)
        self.assertEqual((name, arguments, image), ('orbit_act', {'requestId': 'next', 'sessionId': 'real'}, None))

    def test_codex_timing_prefix_preserves_result(self):
        body = {'input': [{'type': 'function_call_output', 'output': 'Wall time: 1 second\nOutput:\n{"text":"submitted"}'}]}
        result, image = probe['delivered_result'](body, 'codex', {'text': 'submitted'})
        self.assertEqual((result, image), ({'text': 'submitted'}, None))

    def test_arbitrary_base64_is_not_a_jpeg(self):
        with self.assertRaises(AssertionError):
            probe['jpeg_dimensions'](b'x')


if __name__ == '__main__':
    unittest.main()
