"""Real private listener/server-child fixtures, not broker or conversation enrollment."""
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import read_channel_client as subject
from src.native import read_peer

SECRET = "PRIVATE-channel-path-error-secret"
ACK = b'\x00\x00\x00\x11{"v":1,"ok":true}'
CHILD = r'''
import os, socket, sys, threading, time
sys.path.insert(0, sys.argv[1])
from src.native import read_channel_server, read_peer
root, mode = sys.argv[2:4]
path = os.path.join(root, "server.sock")
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path); os.chmod(path, 0o600); s.listen(2); s.setblocking(False)
parent = os.getppid(); parent_start = read_peer._proc(parent)
context, generation, lock = object(), object(), threading.Lock()
os.write(1, b"R")
try:
    if mode == "exit":
        sys.stdin.buffer.read(1)
        raise SystemExit(0)
    if mode in ("hello", "deny", "revoke", "stage-wait"):
        def authorize(identity):
            return (context, generation) if mode != "deny" and identity.pid == parent and identity.uid == os.getuid() and identity.start == parent_start else None
        def operation(value):
            global generation
            if value is not context: raise RuntimeError()
            if mode == "revoke":
                with lock: generation = object()
            if mode == "stage-wait": sys.stdin.buffer.read(1)
        read_channel_server.serve_once(s, deadline=time.monotonic()+1.5, authority_lock=lock,
                                       authorize=authorize, operation=operation)
    else:
        s.setblocking(True); s.settimeout(1)
        conn, _ = s.accept(); conn.settimeout(1)
        request = bytearray()
        try:
            while len(request) <= 24:
                part = conn.recv(25-len(request))
                if not part: break
                request.extend(part)
            if mode == "capture":
                os.write(1, b"Z" if not request else b"B")
            elif mode == "partial": conn.sendall(bytes.fromhex("000000117b"))
            elif mode == "junk": conn.sendall(b'\x00\x00\x00\x11{"v":1,"ok":true}x')
            elif mode == "duplicate": conn.sendall(b'\x00\x00\x00\x11{"v":1,"ok":true}'*2)
            elif mode == "wrong": conn.sendall(b'\x00\x00\x00\x11{"v":1,"ok":null}')
            elif mode == "slow":
                conn.sendall(b"\x00"); sys.stdin.buffer.read(1)
            elif mode == "no-eof":
                conn.sendall(b'\x00\x00\x00\x11{"v":1,"ok":true}'); sys.stdin.buffer.read(1)
            elif mode == "exit-mid":
                conn.close(); os._exit(0)
            elif mode != "close": raise RuntimeError()
        finally: conn.close()
except SystemExit: raise
except BaseException: os.write(1, b"N")
else: os.write(1, b"Y")
finally: s.close()
# The creator process stays alive after connection EOF for final pinned-pidfd checks.
sys.stdin.buffer.read(1)
'''


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix=".orbit-read-client-", dir=Path.home())
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.path = os.path.join(self.root, "server.sock")
        self.children = []
        self.addCleanup(self.finish_children)
        self.lock, self.generation = threading.Lock(), object()
        self.allowed = True

    def finish_children(self):
        for child in self.children:
            if not getattr(child, "_child_created", False):
                continue
            try:
                child.communicate(input=b"x", timeout=.2)
            except (subprocess.TimeoutExpired, ValueError):
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=1)

    def spawn(self, mode="hello", root=None):
        child = subprocess.Popen.__new__(subprocess.Popen)
        self.children.append(child)  # Retain exact own process even on startup failure.
        subprocess.Popen.__init__(child, [sys.executable, "-I", "-S", "-c", CHILD,
                                         str(Path(__file__).resolve().parents[1]), self.root if root is None else root, mode],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
        ready, _, _ = select.select([child.stdout], [], [], 2)
        self.assertTrue(ready)
        self.assertEqual(os.read(child.stdout.fileno(), 1), b"R")
        expected = read_peer.PeerIdentity(child.pid, os.getuid(), os.getgid(), read_peer._proc(child.pid))
        return child, expected

    def guard(self):
        return self.generation if self.allowed else None

    def hello(self, expected, **overrides):
        values = dict(deadline=time.monotonic() + 1, authority_lock=self.lock, guard=self.guard)
        values.update(overrides)
        return subject.hello_once(self.root, "server.sock", expected, **values)

    def refused(self, operation, code=None):
        with self.assertRaises(subject.ReadChannelClientError) as caught:
            operation()
        if code is not None:
            self.assertEqual(caught.exception.code, code)
        self.assertNotIn(self.root, str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIsNone(caught.exception.__context__)
        return caught.exception

    def test_real_server_authorizes_actual_client_kernel_identity_and_client_pins_creator(self):
        child, expected = self.spawn()
        self.assertTrue(self.hello(expected))
        self.assertIsNone(child.poll())
        out, _ = child.communicate(input=b"x", timeout=1)
        self.assertEqual(out, b"Y")
        self.assertEqual(child.returncode, 0)

    def test_fixed_ack_requires_eof_not_only_all_ack_bytes(self):
        child, expected = self.spawn("no-eof")
        received = bytearray()
        original = socket.socket.recv
        def receive(connection, size, flags=0):
            part = original(connection, size, flags); received.extend(part); return part
        with patch.object(subject.socket.socket, "recv", receive):
            self.refused(lambda: self.hello(expected, deadline=time.monotonic() + .1), "DEADLINE")
        self.assertEqual(received, ACK)
        self.assertIsNone(child.poll())
        self.assertEqual(read_peer._proc(child.pid), expected.start)

    def test_malformed_partial_duplicate_and_trailing_ack_refused(self):
        for mode in ("partial", "junk", "duplicate", "wrong", "close"):
            with self.subTest(mode=mode):
                child, expected = self.spawn(mode)
                received = bytearray()
                original = socket.socket.recv
                def receive(connection, size, flags=0):
                    part = original(connection, size, flags); received.extend(part); return part
                with patch.object(subject.socket.socket, "recv", receive):
                    self.refused(lambda: self.hello(expected), "UNKNOWN")
                wire = {"partial": ACK[:5], "junk": ACK + b"x", "duplicate": (ACK * 2)[:22],
                        "wrong": b'\x00\x00\x00\x11{"v":1,"ok":null}', "close": b""}[mode]
                self.assertEqual(received, wire)
                self.assertIsNone(child.poll())
                self.assertEqual(read_peer._proc(child.pid), expected.start)
                child.communicate(input=b"x", timeout=1)
                os.unlink(self.path)

    def test_wrong_expected_server_pid_sends_no_hello(self):
        child, expected = self.spawn("capture")
        wrong = read_peer.PeerIdentity(expected.pid + 1, expected.uid, expected.gid, expected.start)
        self.refused(lambda: self.hello(wrong), "IDENTITY")
        out, _ = child.communicate(input=b"x", timeout=1)
        self.assertIn(b"Z", out)
        self.assertNotIn(b"B", out)

    def test_wrong_server_birth_refused_before_hello(self):
        child, expected = self.spawn("capture")
        wrong = read_peer.PeerIdentity(expected.pid, expected.uid, expected.gid, expected.start + 1)
        self.refused(lambda: self.hello(wrong), "IDENTITY")
        out, _ = child.communicate(input=b"x", timeout=1)
        self.assertIn(b"Z", out)

    def test_server_denial_and_revoke_during_stage_have_no_success(self):
        for mode in ("deny", "revoke"):
            child, expected = self.spawn(mode)
            self.refused(lambda: self.hello(expected))
            out, _ = child.communicate(input=b"x", timeout=1)
            self.assertEqual(out, b"N")
            os.unlink(self.path)

    def test_client_revoked_or_epoch_replaced_during_staging(self):
        child, expected = self.spawn("capture")
        calls = [0]
        def guard():
            calls[0] += 1
            return self.generation if calls[0] == 1 else object()
        self.refused(lambda: self.hello(expected, guard=guard), "IDENTITY")
        out, _ = child.communicate(input=b"x", timeout=1)
        self.assertIn(b"Z", out)

    def test_no_authority_from_boolean_generation_or_labels(self):
        _, expected = self.spawn()
        for value in (True, False, "owner", {}, None):
            self.refused(lambda: self.hello(expected, guard=lambda: value), "IDENTITY")

    def test_cancel_before_connection_and_during_slow_reply(self):
        child, expected = self.spawn("slow")
        event = threading.Event(); event.set()
        self.refused(lambda: self.hello(expected, cancel=event), "CANCELLED")
        event.clear()
        received, original = bytearray(), socket.socket.recv
        def receive(connection, size, flags=0):
            part = original(connection, size, flags)
            received.extend(part)
            if part: event.set()  # Cancel only after the controlled partial ACK arrives.
            return part
        with patch.object(subject.socket.socket, "recv", receive):
            self.refused(lambda: self.hello(expected, cancel=event), "CANCELLED")
        self.assertEqual(received, b"\x00")
        self.assertIsNone(child.poll())

    def test_absolute_deadline_not_renewed_by_partial_reply(self):
        child, expected = self.spawn("slow")
        received, original = bytearray(), socket.socket.recv
        def receive(connection, size, flags=0):
            part = original(connection, size, flags); received.extend(part); return part
        deadline = time.monotonic() + .08
        with patch.object(subject.socket.socket, "recv", receive):
            self.refused(lambda: self.hello(expected, deadline=deadline), "DEADLINE")
        self.assertEqual(received, b"\x00")
        self.assertIsNone(child.poll())

    def test_dead_server_process_is_not_valid_even_with_leftover_socket_path(self):
        child, expected = self.spawn("exit")
        child.stdin.write(b"x"); child.stdin.flush(); child.wait(timeout=1)
        self.refused(lambda: self.hello(expected))

    def test_server_pidfd_option_is_mandatory_and_cannot_fallback_to_claimed_pid(self):
        _, expected = self.spawn()
        with patch.object(read_peer, "_peerpidfd_option", side_effect=read_peer.ReadPeerError("UNSUPPORTED")):
            self.refused(lambda: self.hello(expected), "UNSUPPORTED")

    def test_anomalous_kernel_pidfd_values_never_claim_or_close_unowned_descriptors(self):
        for invalid in (True, False, -1, -9, 0, 1, 2):
            child, expected = self.spawn("capture")
            original_get = socket.socket.getsockopt
            original_close, original_inherit = os.close, os.set_inheritable
            closed, inherited = [], []
            option = read_peer._peerpidfd_option()
            def getsockopt(connection, level, name, *rest):
                if level == socket.SOL_SOCKET and name == option: return invalid
                return original_get(connection, level, name, *rest)
            def close(fd):
                closed.append(fd); original_close(fd)
            def inherit(fd, value):
                inherited.append(fd); original_inherit(fd, value)
            with patch.object(subject.socket.socket, "getsockopt", getsockopt), patch.object(subject.os, "close", close), patch.object(subject.os, "set_inheritable", inherit):
                self.refused(lambda: self.hello(expected), "UNKNOWN")
            self.assertNotIn(invalid, closed)
            self.assertNotIn(invalid, inherited)
            for standard in (0, 1, 2): os.fstat(standard)
            out, _ = child.communicate(input=b"x", timeout=1)
            self.assertIn(b"Z", out)
            os.unlink(self.path)

    def test_private_root_and_socket_modes_required(self):
        _, expected = self.spawn()
        os.chmod(self.root, 0o750)
        self.refused(lambda: self.hello(expected), "IDENTITY")
        os.chmod(self.root, 0o700)
        os.chmod(self.path, 0o660)
        self.refused(lambda: self.hello(expected), "IDENTITY")

    def test_socket_symlink_regular_file_and_hardlink_are_refused(self):
        _, expected = self.spawn()
        moved = self.path + ".saved"
        os.rename(self.path, moved)
        os.symlink(moved, self.path)
        self.refused(lambda: self.hello(expected), "IDENTITY")
        os.unlink(self.path)
        Path(self.path).write_bytes(b"not-a-socket")
        self.refused(lambda: self.hello(expected), "IDENTITY")
        os.unlink(self.path)
        os.link(moved, self.path)
        self.refused(lambda: self.hello(expected), "IDENTITY")

    def test_root_symlink_and_noncanonical_request_paths_refused(self):
        _, expected = self.spawn()
        for root in (self.root + "/.", self.root + "/../" + os.path.basename(self.root), "relative", self.root + "\0"):
            self.refused(lambda: subject.hello_once(root, "server.sock", expected, deadline=time.monotonic()+1,
                                                  authority_lock=self.lock, guard=self.guard), "INVALID")
        for name in ("../server.sock", "/server.sock", "", "..", "a"*65):
            self.refused(lambda: subject.hello_once(self.root, name, expected, deadline=time.monotonic()+1,
                                                  authority_lock=self.lock, guard=self.guard), "INVALID")

    def test_actual_symlink_root_is_not_followed(self):
        _, expected = self.spawn()
        alias = self.root + ".alias"
        os.symlink(self.root, alias)
        self.addCleanup(lambda: os.unlink(alias))
        self.refused(lambda: subject.hello_once(alias, "server.sock", expected,
                     deadline=time.monotonic()+1, authority_lock=self.lock, guard=self.guard), "INVALID")

    def test_peer_server_dies_after_receiving_hello_before_ack(self):
        child, expected = self.spawn("exit-mid")
        error = self.refused(lambda: self.hello(expected))
        self.assertIn(error.code, ("PEER_GONE", "UNKNOWN", "IDENTITY"))
        self.assertEqual(child.wait(timeout=1), 0)

    def test_socket_replacement_during_client_guard_refuses_without_following_replacement(self):
        _, expected = self.spawn()
        calls = [0]
        def guard():
            calls[0] += 1
            if calls[0] == 2:
                os.rename(self.path, self.path + ".moved")
                Path(self.path).write_bytes(b"replacement")
            return self.generation
        self.refused(lambda: self.hello(expected, guard=guard))
        self.assertEqual(Path(self.path).read_bytes(), b"replacement")

    def test_writable_or_special_ancestor_is_refused_without_owner_directory_changes(self):
        ancestor = os.path.join(self.root, "ancestor")
        nested = os.path.join(ancestor, "private")
        path = os.path.join(nested, "server.sock")
        os.mkdir(ancestor, 0o700)
        os.mkdir(nested, 0o700)
        try:
            for mode in (0o770, 0o1777, 0o2700):
                child, expected = self.spawn(root=nested)
                os.chmod(ancestor, mode)  # Only this fixture's newly created directory.
                try:
                    self.refused(lambda: subject.hello_once(nested, "server.sock", expected,
                        deadline=time.monotonic()+1, authority_lock=self.lock, guard=self.guard), "IDENTITY")
                    self.assertIsNone(child.poll())
                    self.assertEqual(read_peer._proc(child.pid), expected.start)
                finally:
                    os.chmod(ancestor, 0o700)
                # Same kernel identity and one-shot listener now succeed. A prior
                # connect/hello would have consumed that listener, exposing a false rejection.
                self.assertTrue(subject.hello_once(nested, "server.sock", expected,
                    deadline=time.monotonic()+1, authority_lock=self.lock, guard=self.guard))
                out, _ = child.communicate(input=b"x", timeout=1)
                self.assertEqual(out, b"Y")
                self.assertEqual(child.returncode, 0)
                os.unlink(path)
        finally:
            os.chmod(ancestor, 0o700)

    def test_final_guard_and_handshake_wait_do_not_hold_owner_lock(self):
        _, expected = self.spawn()
        # Initial guard is outside the lock; later locked guards can observe it held.
        observations = []
        def guard():
            acquired = self.lock.acquire(blocking=False)
            observations.append(not acquired)
            if acquired: self.lock.release()
            return self.generation
        self.assertTrue(self.hello(expected, guard=guard))
        self.assertFalse(observations[0]); self.assertIn(True, observations)

    def test_lock_contention_obeys_cancellation_without_network_read_under_lock(self):
        _, expected = self.spawn()
        self.lock.acquire()
        event = threading.Event()
        timer = threading.Timer(.03, event.set); timer.start()
        try:
            self.refused(lambda: self.hello(expected, cancel=event))
        finally:
            self.lock.release(); timer.cancel(); timer.join(timeout=1)

    def test_static_identity_deadline_lock_and_cancel_types_are_strict(self):
        _, expected = self.spawn()
        for deadline in (True, float("nan"), float("inf"), 10 ** 1000):
            self.refused(lambda: self.hello(expected, deadline=deadline), "INVALID")
        for values in (dict(deadline=time.monotonic()+4), dict(authority_lock=None), dict(guard=None), dict(cancel=True)):
            self.refused(lambda: self.hello(expected, **values))
        self.refused(lambda: self.hello({"pid": expected.pid}), "INVALID")

    def test_guard_errors_are_fixed_content_free_and_context_free(self):
        _, expected = self.spawn()
        def guard(): raise OSError(SECRET + self.path)
        self.refused(lambda: self.hello(expected, guard=guard), "UNKNOWN")

    def test_raw_path_encoding_or_os_error_is_not_exposed(self):
        _, expected = self.spawn()
        with patch.object(subject.os.path, "realpath", side_effect=OSError(SECRET + self.path)):
            self.refused(lambda: self.hello(expected))

    def test_cleanup_failure_suppresses_success_and_still_closes_other_owned_resources(self):
        _, expected = self.spawn()
        original = os.close
        root_info = os.stat(self.root)
        closed = set()
        received, eof = bytearray(), [False]
        original_recv = socket.socket.recv
        def receive(connection, size, flags=0):
            part = original_recv(connection, size, flags)
            if part: received.extend(part)
            else: eof[0] = True
            return part
        def close(fd):
            info = os.fstat(fd)
            is_root = (info.st_dev, info.st_ino) == (root_info.st_dev, root_info.st_ino)
            if is_root: closed.add("root")
            if stat.S_ISSOCK(info.st_mode): closed.add("entry")
            if os.readlink("/proc/self/fd/" + str(fd)).startswith("anon_inode:[pidfd]"):
                closed.add("pidfd")
            original(fd)
            if is_root: raise OSError(SECRET)
        with patch.object(subject.socket.socket, "recv", receive), patch.object(subject.os, "close", close):
            self.refused(lambda: self.hello(expected), "UNKNOWN")
        self.assertEqual(received, ACK)
        self.assertTrue(eof[0])
        self.assertEqual(closed, {"root", "entry", "pidfd"})

    def test_cancel_during_connection_close_cannot_publish_fixed_ack(self):
        _, expected = self.spawn()
        event = threading.Event()
        original = socket.socket.close
        def close(connection):
            original(connection); event.set()
        with patch.object(subject.socket.socket, "close", close):
            self.refused(lambda: self.hello(expected, cancel=event), "CANCELLED")


if __name__ == "__main__":
    unittest.main()
