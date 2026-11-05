"""Shared literal wire compatibility only, not service process or durability acceptance."""
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.native.read_usage_store_service import ReadUsageServiceError, _encoded, _request

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "read-usage-wire-vectors.json").read_text())
INVALID = (ReadUsageServiceError, ValueError, UnicodeError)


class ProtocolVectorsTests(unittest.TestCase):
    def test_known_literal_anchors_are_not_production_generated_expectations(self):
        self.assertEqual(VECTORS["version"], 1)
        self.assertEqual(len(VECTORS["valid"]), 5)
        self.assertEqual(len(VECTORS["invalidRequests"]), 32)
        self.assertEqual(len(VECTORS["invalidAcks"]), 18)
        first = VECTORS["valid"][0]
        self.assertEqual(first["requestFrameHex"][:8], "00000083")
        self.assertEqual(first["ackFrameHex"], "000000127b226964223a312c226f6b223a747275657d")
        self.assertTrue(bytes.fromhex(first["payloadHex"]).startswith(b'{"id":1,"slot":0,"record":'))

    def test_real_request_parser_accepts_every_literal_including_max_safe_id_and_epoch(self):
        for item in VECTORS["valid"]:
            with self.subTest(name=item["name"]):
                frame = bytes.fromhex(item["requestFrameHex"])
                self.assertEqual(struct.unpack(">I", frame[:4])[0], len(frame) - 4)
                payload = bytes.fromhex(item["payloadHex"])
                self.assertEqual(frame[4:], payload)
                request_id, slot, record = _request(payload, item["id"], 4)
                self.assertEqual((request_id, slot), (item["id"], item["slot"]))
                self.assertEqual(record, {"instance": item["instance"], "epoch": item["epoch"], "enabled": item["enabled"]})

    def test_real_python_encoder_matches_literal_requests_and_ack_frames_byte_for_byte(self):
        for item in VECTORS["valid"]:
            with self.subTest(name=item["name"]):
                record = {"instance": item["instance"], "epoch": item["epoch"], "enabled": item["enabled"]}
                self.assertEqual(_encoded({"id": item["id"], "slot": item["slot"], "record": record}).hex(), item["payloadHex"])
                ack = _encoded({"id": item["id"], "ok": True})
                self.assertEqual((struct.pack(">I", len(ack)) + ack).hex(), item["ackFrameHex"])

    def test_real_parser_refuses_all_shared_noncanonical_or_invalid_requests(self):
        for item in VECTORS["invalidRequests"]:
            with self.subTest(name=item["name"]):
                encoded = item["payloadHex"]
                self.assertIs(type(encoded), str)
                self.assertGreater(len(encoded), 0)
                self.assertEqual(len(encoded) % 2, 0)
                self.assertTrue(all(char in "0123456789abcdef" for char in encoded))
                raw = bytes.fromhex(encoded)  # Fixture decode failures must fail, never satisfy parser rejection.
                self.assertEqual(raw.hex(), encoded)
                expected, slots = item["expectedId"], item["slots"]
                self.assertIs(type(expected), int)
                self.assertIs(type(slots), int)
                self.assertTrue(1 <= expected <= 9007199254740991 and 1 <= slots <= 4)
                parser = Mock(wraps=_request)
                with self.assertRaises(INVALID):
                    parser(raw, expected, slots)
                parser.assert_called_once_with(raw, expected, slots)

    def test_sequence_and_slot_bounds_remain_exact_at_safe_integer_boundary(self):
        maximum = VECTORS["valid"][-1]
        raw = bytes.fromhex(maximum["payloadHex"])
        self.assertEqual(_request(raw, 9007199254740991, 1)[0], 9007199254740991)
        for expected in (9007199254740990, 9007199254740992):
            with self.assertRaises(INVALID): _request(raw, expected, 1)
        slot_three = VECTORS["valid"][2]
        slot_raw = bytes.fromhex(slot_three["payloadHex"])
        self.assertEqual(slot_raw.hex(), slot_three["payloadHex"])
        with self.assertRaises(INVALID): _request(slot_raw, 3, 3)

    def test_truncated_literal_payloads_fail_without_sockets_processes_or_store_operations(self):
        raw = bytes.fromhex(VECTORS["valid"][0]["payloadHex"])
        with patch("socket.socket", side_effect=AssertionError("No socket")), \
                patch("subprocess.Popen", side_effect=AssertionError("No child")), \
                patch("src.native.read_usage_store_service.ReadUsageStore", side_effect=AssertionError("No storage")):
            for length in range(len(raw)):
                with self.subTest(length=length):
                    with self.assertRaises(INVALID): _request(raw[:length], 1, 4)


if __name__ == "__main__":
    unittest.main()
