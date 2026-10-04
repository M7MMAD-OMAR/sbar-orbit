"""Protocol boundary checks; real proxy/app interference remains a separate gate."""
import struct
import unittest
from x11_selection_namespace import SelectionNamespace


class SelectionNamespaceTests(unittest.TestCase):
    def setUp(self):
        self.namespace = SelectionNamespace(80, 1001, 1002, 138, 87)

    def request(self, order, opcode, size, offset, atom, minor=0, extended=False):
        frame = bytearray(size + (4 if extended else 0))
        frame[0:2] = bytes((opcode, minor))
        struct.pack_into(order + "H", frame, 2, 0 if extended else len(frame) // 4)
        if extended:
            struct.pack_into(order + "I", frame, 4, len(frame) // 4)
        struct.pack_into(order + "I", frame, offset + (4 if extended else 0), atom)
        return bytes(frame)

    def test_selection_requests_preserve_every_other_byte(self):
        for order in ("<", ">"):
            for extended in (False, True):
                for opcode, size, offset, minor in [(22, 16, 8, 0), (23, 8, 4, 0), (24, 24, 8, 0), (138, 16, 8, 2)]:
                    for public, private in [(1, 1001), (80, 1002), (90, 90)]:
                        with self.subTest(order=order, extended=extended, opcode=opcode, atom=public):
                            frame = self.request(order, opcode, size, offset, public, minor, extended)
                            expected = self.request(order, opcode, size, offset, private, minor, extended)
                            self.assertEqual(self.namespace.request(frame, order), expected)

    def test_selection_events_and_send_event_round_trip(self):
        for order in ("<", ">"):
            for kind, offset in [(29, 12), (30, 16), (31, 12), (87, 12)]:
                for synthetic in (0, 128):
                    public = bytearray(32)
                    public[0] = kind | synthetic
                    struct.pack_into(order + "H", public, 2, 1234)
                    struct.pack_into(order + "I", public, offset, 1)
                    private = bytearray(public)
                    struct.pack_into(order + "I", private, offset, 1001)
                    self.assertEqual(self.namespace.server(bytes(private), order), bytes(public))
                    send = bytearray(self.request(order, 25, 44, 4, 777))
                    send[12:] = public
                    expected = bytearray(send)
                    expected[12:] = private
                    self.assertEqual(self.namespace.request(bytes(send), order), bytes(expected))

    def test_unrelated_messages_and_reply_payload_are_unchanged(self):
        for order in ("<", ">"):
            request = self.request(order, 18, 24, 8, 1)
            self.assertEqual(self.namespace.request(request, order), request)
            reply = bytearray(36)
            reply[0] = 1
            struct.pack_into(order + "I", reply, 4, 1)
            struct.pack_into(order + "I", reply, 12, 1001)
            self.assertEqual(self.namespace.server(bytes(reply), order), bytes(reply))

    def test_rejects_malformed_frames_and_configuration(self):
        for frame in (b"", b"\x16\0\0\0", b"\x17\0\x02\0", b"\x16\0\x02\0" + b"\0"*4):
            with self.assertRaises(ValueError):
                self.namespace.request(frame, "<")
        for frame in (b"", bytes(31), b"\x01" + bytes(3) + b"\x01" + bytes(27)):
            with self.assertRaises(ValueError):
                self.namespace.server(frame, "<")
        with self.assertRaises(ValueError):
            self.namespace.request(bytes(4), "l")
        for args in [(80, 80, 1002, 138, 87), (80, 2, 1002, 138, 87), (80, 1001, 1002, 22, 87)]:
            with self.assertRaises(ValueError):
                SelectionNamespace(*args)


if __name__ == "__main__":
    unittest.main()
