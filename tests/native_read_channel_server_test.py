"""Real private Unix listener and owned connector process fixtures."""
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import read_channel_server as subject
from src.native import read_peer

CHILD = r'''
import errno, os, socket, sys, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
payload = bytes.fromhex(sys.argv[2])
if sys.argv[3] == "trickle":
    s.sendall(payload[:1]); time.sleep(1)
else:
    s.sendall(payload)
    s.shutdown(socket.SHUT_WR)
if sys.argv[3] == "disconnect":
    s.close(); os.write(2, b"disconnect"); raise SystemExit(0)
s.settimeout(3)
out = bytearray()
status = b"error"
try:
    while True:
        part = s.recv(4096)
        if not part:
            status = b"eof"
            break
        out.extend(part)
except OSError as error:
    status = b"reset" if error.errno == errno.ECONNRESET else b"error"
finally:
    os.write(1, bytes(out))
    os.write(2, status)
    s.close()
'''


def frame(body): return struct.pack(">I", len(body)) + body
GOOD = frame(b'{"v":1,"op":"hello"}')
ACK = frame(b'{"v":1,"ok":true}')


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orbit-channel-")
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "listener.sock")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        os.chmod(self.path, 0o600)
        self.listener.listen(4)
        self.listener.setblocking(False)
        self.addCleanup(self.listener.close)
        self.children = []
        self.addCleanup(self.finish_children)
        self.context = object()
        self.generation = object()
        self.lock = threading.Lock()
        self.current = True
        self.operations = []
        self.ids = []
        self.expected_pid = None

    def finish_children(self):
        for child in self.children:
            try:
                child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=2)

    def spawn(self, data=GOOD, mode="normal"):
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", CHILD,
                                  self.path, data.hex(), mode], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, close_fds=True)
        self.children.append(child)
        return child

    def authorize(self, identity):
        self.ids.append(identity)
        return (self.context, self.generation) if self.current and identity.pid == self.expected_pid else None

    def operation(self, context): self.operations.append(context)

    def serve(self, deadline=None, operation=None, cancel=None):
        return subject.serve_once(self.listener, deadline=deadline or time.monotonic() + 2,
                                  cancel=cancel, authority_lock=self.lock,
                                  authorize=self.authorize, operation=operation or self.operation)

    def result(self, child, expected_status=(b"eof",)):
        out, err = child.communicate(timeout=3)
        self.assertEqual(child.returncode, 0)
        self.assertIn(err, expected_status)
        return out

    def refused(self, data, mode="normal", deadline=None):
        child = self.spawn(data, mode)
        self.expected_pid = child.pid
        with self.assertRaises(subject.ReadChannelError) as caught:
            self.serve(deadline=deadline)
        self.assertNotIn("hello", str(caught.exception))
        self.assertIsNone(caught.exception.__context__)
        self.assertEqual(self.result(child, (b"eof", b"reset")), b"")
        return child

    def test_real_child_valid_fixed_ack(self):
        child = self.spawn()
        self.expected_pid = child.pid
        self.assertTrue(self.serve())
        self.assertEqual(self.result(child), ACK)
        self.assertEqual(self.operations, [self.context])
        self.assertEqual(len(self.ids), 2)
        self.assertEqual(self.ids[0].pid, child.pid)
        self.assertEqual(self.ids[0], self.ids[1])
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_second_unapproved_connector_refused(self):
        first = self.spawn()
        self.expected_pid = first.pid
        self.assertTrue(self.serve())
        self.assertEqual(self.result(first), ACK)
        second = self.spawn()
        with self.assertRaises(subject.ReadChannelError): self.serve()
        self.assertEqual(self.result(second), b"")
        self.assertEqual(self.operations, [self.context])

    def test_malformed_unknown_and_duplicate_fields(self):
        for payload in (b"{", b'{"v":1,"op":"hello","pid":1}',
                        b'{"v":1,"v":1,"op":"hello"}', b'{"v":true,"op":"hello"}',
                        b'{"v":2,"op":"hello"}'):
            with self.subTest(payload=payload): self.refused(frame(payload))
        self.assertEqual(self.operations, [])

    def test_oversize_refused(self):
        self.refused(struct.pack(">I", 4097))
        self.assertEqual(self.operations, [])

    def test_duplicate_frame_refused(self):
        self.refused(GOOD + GOOD)
        self.assertEqual(self.operations, [])

    def test_trickled_frame_deadline(self):
        self.refused(GOOD, mode="trickle", deadline=time.monotonic() + 0.2)
        self.assertEqual(self.operations, [])

    def test_disconnect_refused(self):
        child = self.spawn(GOOD, "disconnect")
        self.expected_pid = child.pid
        with self.assertRaises(subject.ReadChannelError): self.serve()
        self.assertEqual(self.result(child, (b"disconnect",)), b"")

    def test_revoked_during_staging_no_ack(self):
        child = self.spawn()
        self.expected_pid = child.pid
        def operation(_):
            with self.lock:
                self.current = False
        with self.assertRaises(subject.ReadChannelError): self.serve(operation=operation)
        self.assertEqual(self.result(child), b"")

    def test_reapprove_same_context_new_generation_refused(self):
        child = self.spawn()
        self.expected_pid = child.pid
        def operation(_):
            with self.lock:
                self.current = False
                self.generation = object()
                self.current = True
        with self.assertRaises(subject.ReadChannelError): self.serve(operation=operation)
        self.assertEqual(self.result(child), b"")

    def test_peer_exit_during_staging_no_ack(self):
        child = self.spawn()
        self.expected_pid = child.pid
        def operation(_):
            child.kill()
            child.wait(timeout=2)
        with self.assertRaises(subject.ReadChannelError): self.serve(operation=operation)
        out, _ = child.communicate(timeout=3)
        self.assertEqual(out, b"")
        self.assertNotEqual(child.returncode, 0)

    def test_listener_replacement_during_staging_no_ack(self):
        child = self.spawn()
        self.expected_pid = child.pid
        def operation(_):
            os.unlink(self.path)
            replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(replacement.close)
            replacement.bind(self.path)
        with self.assertRaises(subject.ReadChannelError): self.serve(operation=operation)
        self.assertEqual(self.result(child), b"")

    def test_cancel_during_staging_no_ack(self):
        child = self.spawn()
        self.expected_pid = child.pid
        cancel = threading.Event()
        with self.assertRaises(subject.ReadChannelError):
            self.serve(cancel=cancel, operation=lambda _: cancel.set())
        self.assertEqual(self.result(child), b"")

    def test_staging_does_not_block_revocation(self):
        child = self.spawn()
        self.expected_pid = child.pid
        entered, release, revoked = threading.Event(), threading.Event(), threading.Event()
        results = []
        def stage(_):
            entered.set()
            release.wait(1)
        def run():
            try: results.append(self.serve(operation=stage))
            except BaseException as error: results.append(error)
        def revoke():
            with self.lock:
                self.current = False
                revoked.set()
        server = threading.Thread(target=run)
        server.start()
        self.assertTrue(entered.wait(1))
        other = threading.Thread(target=revoke)
        other.start()
        self.assertTrue(revoked.wait(0.5))
        release.set()
        server.join(2)
        other.join(2)
        self.assertFalse(server.is_alive())
        self.assertFalse(other.is_alive())
        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], subject.ReadChannelError)
        self.assertEqual(self.result(child), b"")

    def test_trickled_input_does_not_block_revocation(self):
        child = self.spawn(mode="trickle")
        self.expected_pid = child.pid
        results = []
        read_entered, release_read = threading.Event(), threading.Event()
        original_read = read_peer._FrameReader.read_request
        def controlled_read(reader):
            read_entered.set()
            if not release_read.wait(1):
                raise RuntimeError("fixture synchronization failed")
            return original_read(reader)
        def run():
            try: results.append(self.serve(deadline=time.monotonic() + 1.5))
            except BaseException as error: results.append(error)
        with patch.object(read_peer._FrameReader, "read_request", controlled_read):
            server = threading.Thread(target=run)
            server.start()
            self.assertTrue(read_entered.wait(1))
            acquired = self.lock.acquire(timeout=0.2)
            try:
                self.assertTrue(acquired)
                if acquired:
                    self.current = False
            finally:
                if acquired:
                    self.lock.release()
                release_read.set()
            server.join(2)
        self.assertFalse(server.is_alive())
        self.assertIsInstance(results[0], subject.ReadChannelError)
        self.assertEqual(self.result(child), b"")

    def test_final_authorization_and_send_hold_revocation_lock(self):
        child = self.spawn()
        self.expected_pid = child.pid
        entered, release, revoked = threading.Event(), threading.Event(), threading.Event()
        results = []
        original = socket.socket.send
        def controlled_send(sock, data, flags=0):
            entered.set()
            release.wait(1)
            return original(sock, data, flags)
        def run():
            try: results.append(self.serve())
            except BaseException as error: results.append(error)
        def revoke():
            with self.lock:
                self.current = False
                revoked.set()
        with patch.object(socket.socket, "send", controlled_send):
            server = threading.Thread(target=run)
            server.start()
            self.assertTrue(entered.wait(1))
            other = threading.Thread(target=revoke)
            other.start()
            self.assertFalse(revoked.wait(0.05))
            release.set()
            server.join(2)
            other.join(2)
        self.assertEqual(results, [True])
        self.assertTrue(revoked.is_set())
        self.assertEqual(self.result(child), ACK)

    def test_partial_send_is_unknown_no_retry(self):
        child = self.spawn()
        self.expected_pid = child.pid
        original = socket.socket.send
        calls = []
        def partial(sock, data, flags=0):
            calls.append(bytes(data))
            return original(sock, data[:1], flags)
        with patch.object(socket.socket, "send", partial):
            with self.assertRaises(subject.ReadChannelError): self.serve()
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.result(child), ACK[:1])

    def test_operation_error_is_redacted(self):
        child = self.spawn()
        self.expected_pid = child.pid
        def operation(_): raise ValueError("private data")
        with self.assertRaises(subject.ReadChannelError) as caught: self.serve(operation=operation)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(self.result(child), b"")


if __name__ == "__main__":
    unittest.main()
