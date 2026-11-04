"""Owned AF_UNIX listener and child fixtures, with no desktop operations."""
import errno
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import read_peer as subject

CHILD = r'''
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall(b"{forged pid uid start conversation}\n")
sys.stdin.buffer.read(1)
s.close()
'''


class PeerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orbit-owned-peer-")
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "peer.sock")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        os.chmod(self.path, 0o600)
        self.listener.listen(4)
        self.listener.setblocking(False)
        self.addCleanup(self.listener.close)
        self.child = None
        self.addCleanup(self.stop_child)

    def start_child(self):
        self.child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", CHILD, self.path],
                                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, close_fds=True)
        return self.child

    def stop_child(self):
        if self.child is not None:
            if self.child.stdin and not self.child.stdin.closed:
                self.child.stdin.close()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=2)

    def accept(self, **kwargs):
        return subject.accept_owned_peer(self.listener, deadline=time.monotonic() + 2, **kwargs)

    def require_peer(self):
        self.start_child()
        try:
            peer = self.accept()
        except subject.ReadPeerError as error:
            if error.code == "UNSUPPORTED":
                self.skipTest("kernel has no SO_PEERPIDFD")
            raise
        self.addCleanup(peer.close)
        return peer

    def test_real_child_accepted_identity_and_untrusted_body(self):
        peer = self.require_peer()
        seen = peer.run(lambda identity: identity)
        self.assertEqual(seen.pid, self.child.pid)
        self.assertEqual(seen.uid, os.getuid())
        self.assertEqual(seen.gid, os.getgid())
        self.assertGreater(seen.start, 0)
        self.assertFalse(os.get_inheritable(peer._pidfd))
        self.assertNotEqual(seen.pid, os.getpid())
        self.assertEqual(peer._connection.recv(128), b"{forged pid uid start conversation}\n")
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_child_exit_during_callback_discards_result(self):
        peer = self.require_peer()
        def callback(_):
            self.child.stdin.close()
            self.child.wait(timeout=2)
            return "must not escape"
        with self.assertRaises(subject.ReadPeerError): peer.run(callback)

    def test_child_exit_before_callback_refuses(self):
        peer = self.require_peer()
        self.child.stdin.close()
        self.child.wait(timeout=2)
        called = []
        with self.assertRaises(subject.ReadPeerError): peer.run(lambda _: called.append(True))
        self.assertEqual(called, [])

    def test_path_replaced_during_callback_discards_result(self):
        peer = self.require_peer()
        def callback(_):
            os.unlink(self.path)
            replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(replacement.close)
            replacement.bind(self.path)
            return "must not escape"
        with self.assertRaises(subject.ReadPeerError): peer.run(callback)

    def test_closed_listener_during_callback_discards_result(self):
        peer = self.require_peer()
        def callback(_):
            self.listener.close()
            return "must not escape"
        with self.assertRaises(subject.ReadPeerError): peer.run(callback)

    def test_cancellation_after_callback_discards_result(self):
        cancel = threading.Event()
        self.start_child()
        try:
            peer = self.accept(cancel=cancel)
        except subject.ReadPeerError as error:
            if error.code == "UNSUPPORTED": self.skipTest("kernel has no SO_PEERPIDFD")
            raise
        self.addCleanup(peer.close)
        with self.assertRaises(subject.ReadPeerError) as caught:
            peer.run(lambda _: cancel.set())
        self.assertEqual(caught.exception.code, "CANCELLED")

    def test_fake_callback_identity_cannot_override_peer(self):
        peer = self.require_peer()
        actual = peer.run(lambda _: {"pid": 9, "start": 1})
        self.assertEqual(actual, {"pid": 9, "start": 1})
        self.assertNotEqual(peer._identity.pid, actual["pid"])
        with self.assertRaises(subject.ReadPeerError): peer.run(lambda _: True)

    def test_socketpair_not_listener(self):
        left, right = socket.socketpair()
        try:
            left.setblocking(False)
            with self.assertRaises(subject.ReadPeerError):
                subject.accept_owned_peer(left, deadline=time.monotonic() + 1)
            self.assertGreaterEqual(left.fileno(), 0)
            self.assertGreaterEqual(right.fileno(), 0)
        finally:
            left.close()
            right.close()

    def test_same_process_connection_refused(self):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(client.close)
        client.connect(self.path)
        with self.assertRaises(subject.ReadPeerError) as caught: self.accept()
        self.assertEqual(caught.exception.code, "IDENTITY")
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_blocking_listener_refused_without_mutation(self):
        self.listener.setblocking(True)
        with self.assertRaises(subject.ReadPeerError): self.accept()
        self.assertTrue(os.get_blocking(self.listener.fileno()))

    def test_world_accessible_directory_refused(self):
        os.chmod(self.tmp.name, 0o755)
        self.addCleanup(os.chmod, self.tmp.name, 0o700)
        with self.assertRaises(subject.ReadPeerError): self.accept()

    def test_world_accessible_socket_refused(self):
        os.chmod(self.path, 0o666)
        with self.assertRaises(subject.ReadPeerError): self.accept()

    def test_deadline_and_cancel_before_accept(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(subject.ReadPeerError) as caught: self.accept(cancel=cancel)
        self.assertEqual(caught.exception.code, "CANCELLED")
        with self.assertRaises(subject.ReadPeerError):
            subject.accept_owned_peer(self.listener, deadline=10 ** 1000)

    def test_unsupported_pidfd_refuses_and_keeps_listener(self):
        self.start_child()
        with patch.object(subject, "_peerpidfd_option", side_effect=subject.ReadPeerError("UNSUPPORTED")):
            with self.assertRaises(subject.ReadPeerError) as caught: self.accept()
        self.assertEqual(caught.exception.code, "UNSUPPORTED")
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_listener_state_attempts_both_closes_after_error(self):
        first = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        second = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        real_close = os.close
        attempts = []
        def close(fd):
            attempts.append(fd)
            real_close(fd)
            if fd == first:
                raise OSError("secret close")
        with (patch.object(subject, "_listener_pin", return_value=(("state",), second, first)),
              patch.object(subject.os, "close", side_effect=close)):
            with self.assertRaises(subject.ReadPeerError) as caught:
                subject._listener_state(self.listener)
        self.assertEqual(attempts, [first, second])
        self.assertEqual(caught.exception.code, "UNKNOWN")
        self.assertNotIn("secret", str(caught.exception))

    def test_accept_selector_close_failure_still_closes_connection(self):
        self.start_child()
        original_selector = subject.selectors.DefaultSelector
        original_socket = socket.socket.close
        closed = []
        class FailingSelector:
            def __init__(self): self.inner = original_selector()
            def register(self, *args): return self.inner.register(*args)
            def select(self, *args): return self.inner.select(*args)
            def close(self):
                self.inner.close()
                raise OSError("secret selector close")
        def close_socket(sock):
            closed.append(sock.fileno())
            return original_socket(sock)
        with (patch.object(subject.selectors, "DefaultSelector", FailingSelector),
              patch.object(socket.socket, "close", close_socket)):
            with self.assertRaises(subject.ReadPeerError) as caught:
                self.accept()
        self.assertEqual(caught.exception.code, "UNKNOWN")
        self.assertNotIn("secret", str(caught.exception))
        self.assertTrue(closed)
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_pidfd_getsockopt_error_classification(self):
        for error_number, expected in ((errno.ENOPROTOOPT, "UNSUPPORTED"),
                                       (errno.EOPNOTSUPP, "UNSUPPORTED"),
                                       (errno.ENODATA, "PEER_GONE"),
                                       (errno.ESRCH, "PEER_GONE"),
                                       (errno.EMFILE, "UNKNOWN"),
                                       (errno.ENFILE, "UNKNOWN"),
                                       (errno.EACCES, "UNKNOWN")):
            with self.subTest(error_number=error_number):
                child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", CHILD, self.path],
                                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, close_fds=True)
                original = socket.socket.getsockopt
                def injected(sock, level, option, *args):
                    if level == socket.SOL_SOCKET and option == subject._peerpidfd_option():
                        raise OSError(error_number, "private detail")
                    return original(sock, level, option, *args)
                try:
                    with patch.object(socket.socket, "getsockopt", injected):
                        with self.assertRaises(subject.ReadPeerError) as caught:
                            self.accept()
                    self.assertEqual(caught.exception.code, expected)
                    self.assertNotIn("private detail", str(caught.exception))
                finally:
                    child.stdin.close()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)

    def test_connection_inode_change_refused(self):
        peer = self.require_peer()
        peer._socket_id = (0, 0)
        with self.assertRaises(subject.ReadPeerError): peer.run(lambda _: True)

    def test_birth_change_refused_before_callback(self):
        peer = self.require_peer()
        with patch.object(subject, "_proc", return_value=peer._identity.start + 1):
            with self.assertRaises(subject.ReadPeerError): peer.run(lambda _: True)

    def test_reentrant_close_rejected_without_closing_peer(self):
        peer = self.require_peer()
        def callback(_):
            with self.assertRaises(subject.ReadPeerError) as caught:
                peer.close()
            self.assertEqual(caught.exception.code, "BUSY")
            return True
        self.assertTrue(peer.run(callback))
        self.assertGreaterEqual(peer._connection.fileno(), 0)

    def test_concurrent_close_waits_for_running_callback(self):
        peer = self.require_peer()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        results = []
        def runner():
            try:
                results.append(peer.run(lambda _: (entered.set(), release.wait(1), True)[2]))
            except BaseException as error:
                results.append(error)
        def closer():
            peer.close()
            closed.set()
        first = threading.Thread(target=runner)
        second = threading.Thread(target=closer)
        first.start()
        self.assertTrue(entered.wait(1))
        second.start()
        self.assertFalse(closed.wait(0.05))
        release.set()
        first.join(1)
        second.join(1)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(results, [True])
        self.assertTrue(closed.is_set())
        self.assertGreaterEqual(self.listener.fileno(), 0)

    def test_close_only_owned_descriptors(self):
        peer = self.require_peer()
        peer.close()
        peer.close()
        self.assertGreaterEqual(self.listener.fileno(), 0)
        with self.assertRaises(subject.ReadPeerError): peer.run(lambda _: True)

    def test_listener_pin_cleanup_attempts_both_after_failure(self):
        real_close = os.close
        attempts = []
        def close(fd):
            attempts.append(fd)
            real_close(fd)
            if len(attempts) == 1:
                raise OSError("private close")
        with (patch.object(subject.os, "close", side_effect=close),
              patch.object(subject, "_socket_id", side_effect=ValueError("private identity"))):
            with self.assertRaises(subject.ReadPeerError) as caught:
                subject._listener_pin(self.listener)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(caught.exception.code, "UNKNOWN")
        self.assertNotIn("private", str(caught.exception))

    def test_callback_peer_error_is_redacted(self):
        peer = self.require_peer()
        def callback(_): raise subject.ReadPeerError("private callback")
        with self.assertRaises(subject.ReadPeerError) as caught: peer.run(callback)
        self.assertEqual(caught.exception.code, "UNKNOWN")
        self.assertNotIn("private", str(caught.exception))
        self.assertIsNone(caught.exception.__context__)

    def test_exchange_never_acknowledges_incomplete_reader(self):
        peer = self.require_peer()
        with self.assertRaises(subject.ReadPeerError):
            peer.exchange_one(lambda identity, reader: object(), lambda *_: True, threading.Lock())

    def test_exchange_stage_exception_is_redacted(self):
        peer = self.require_peer()
        def stage(identity, reader): raise ValueError("private stage")
        with self.assertRaises(subject.ReadPeerError) as caught:
            peer.exchange_one(stage, lambda *_: True, threading.Lock())
        self.assertEqual(caught.exception.code, "UNKNOWN")
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn("private", str(caught.exception))

    def test_callback_exception_is_redacted(self):
        peer = self.require_peer()
        def callback(_): raise ValueError("secret body")
        with self.assertRaises(subject.ReadPeerError) as caught: peer.run(callback)
        self.assertNotIn("secret", str(caught.exception))
        self.assertIsNone(caught.exception.__context__)
        self.assertIsNone(caught.exception.__cause__)


if __name__ == "__main__":
    unittest.main()
