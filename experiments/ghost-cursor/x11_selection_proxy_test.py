"""Unix framing and descriptor checks, independent of a running desktop."""
import array
import os
import socket
import threading
import tempfile
from pathlib import Path
from unittest.mock import patch
import unittest
from x11_selection_proxy import MAX_FRAME, MAX_FDS, Proxy, close_fds, release_fds, receive, send


class TransportTests(unittest.TestCase):
    def test_fragmented_bytes_are_exact(self):
        left, right = socket.socketpair()
        def writer():
            left.sendall(b"abcd")
            left.sendall(b"efgh")
        thread = threading.Thread(target=writer)
        try:
            thread.start()
            self.assertEqual(receive(right, 8, []), b"abcdefgh")
        finally:
            thread.join(2)
            left.close()
            right.close()
        self.assertFalse(thread.is_alive())

    def test_descriptor_survives_two_hops_without_inheritable_fd(self):
        first, reader = socket.socketpair()
        second, recipient = socket.socketpair()
        original, writer = os.pipe()
        received = []
        forwarded = []
        try:
            first.sendmsg([b"frame"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [original]))])
            frame = receive(reader, 5, received)
            self.assertEqual(frame, b"frame")
            self.assertEqual(len(received), 1)
            self.assertFalse(os.get_inheritable(received[0]))
            send(second, frame, received)
            self.assertEqual(receive(recipient, 5, forwarded), b"frame")
            self.assertEqual(len(forwarded), 1)
            self.assertFalse(os.get_inheritable(forwarded[0]))
            os.write(writer, b"actual descriptor payload")
            self.assertEqual(os.read(forwarded[0], 64), b"actual descriptor payload")
        finally:
            close_fds([*received, *forwarded, original, writer])
            for sock in [first, reader, second, recipient]:
                sock.close()

    def test_truncated_payload_is_an_error_but_clean_boundary_eof_is_not(self):
        left, right = socket.socketpair()
        try:
            left.sendall(b"abc")
            left.shutdown(socket.SHUT_WR)
            with self.assertRaisesRegex(ValueError, "truncated"):
                receive(right, 4, [], allow_eof=True)
            with self.assertRaisesRegex(ValueError, "truncated"):
                receive(right, 4, [])
            with self.assertRaises(EOFError):
                receive(right, 4, [], allow_eof=True)
        finally:
            left.close()
            right.close()

    def test_excessive_frame_is_refused_before_read(self):
        left, right = socket.socketpair()
        try:
            with self.assertRaisesRegex(ValueError, "bound"):
                receive(right, MAX_FRAME + 1, [])
        finally:
            left.close()
            right.close()

    def test_truncated_ancillary_rights_are_refused_and_received_fds_closed(self):
        left, right = socket.socketpair()
        original, writer = os.pipe()
        supplied = [os.dup(original) for index in range(MAX_FDS + 1)]
        received = []
        try:
            left.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", supplied))])
            with self.assertRaisesRegex(ValueError, "ancillary"):
                receive(right, 1, received)
            self.assertGreater(len(received), 0)
            self.assertLessEqual(len(received), MAX_FDS)
            close_fds(received)
            for descriptor in received:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
            received = []
        finally:
            close_fds([*received, *supplied, original, writer])
            left.close()
            right.close()

    def test_cleanup_continues_after_one_descriptor_error(self):
        closed, writer = os.pipe()
        live, other_writer = os.pipe()
        os.close(closed)
        try:
            with self.assertRaises(ExceptionGroup):
                close_fds([closed, live])
            with self.assertRaises(OSError):
                os.fstat(live)
        finally:
            os.close(writer)
            os.close(other_writer)

    def test_release_consumes_failed_cleanup_without_reclosing(self):
        closed, writer = os.pipe()
        live, other_writer = os.pipe()
        os.close(closed)
        descriptors = [closed, live]
        try:
            with self.assertRaises(ExceptionGroup):
                release_fds(descriptors)
            self.assertEqual(descriptors, [])
            release_fds(descriptors)
            with self.assertRaises(OSError):
                os.fstat(live)
        finally:
            os.close(writer)
            os.close(other_writer)

    def test_state_publication_preserves_external_symlink_target(self):
        root = Path(__file__).resolve().parents[2] / ".private"
        with tempfile.TemporaryDirectory(prefix="proxy-publication-", dir=root) as directory:
            run = Path(directory) / "run"
            run.mkdir(mode=0o700)
            foreign = Path(directory) / "foreign"
            foreign.write_text("preserve this fixture")
            os.chmod(foreign, 0o640)
            proxy = object.__new__(Proxy)
            proxy.lock = threading.Lock()
            proxy.state = {"ready": True}
            proxy.env = {}
            proxy.output = run / "state.json"
            proxy.output_identity = None
            proxy.output.with_suffix(".pending").symlink_to(foreign)
            with patch("x11_selection_proxy.lab.guard"):
                proxy.write_state()
            self.assertEqual(foreign.read_text(), "preserve this fixture")
            self.assertEqual(foreign.stat().st_mode & 0o777, 0o640)
            self.assertTrue(proxy.output.with_suffix(".pending").is_symlink())
            self.assertEqual(proxy.output.stat().st_mode & 0o777, 0o600)
            proxy.output.unlink()
            proxy.output.symlink_to(foreign)
            with patch("x11_selection_proxy.lab.guard"), self.assertRaises(ValueError):
                proxy.write_state()
            self.assertEqual(foreign.read_text(), "preserve this fixture")


if __name__ == "__main__":
    unittest.main()
