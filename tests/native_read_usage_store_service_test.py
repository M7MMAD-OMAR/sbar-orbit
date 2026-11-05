"""Actual owned socketpair + durable private store, no process/native-app startup."""
import json
import os
from pathlib import Path
import select
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import read_usage_store_service as subject
from src.native.read_usage_store import ReadUsageStore, ReadUsageStoreError

SECRET = "PRIVATE-service-root-record-error"
INSTANCE = "a" * 64


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def frame(value):
    payload = encoded(value)
    return struct.pack(">I", len(payload)) + payload


def request(request_id=1, slot=0, epoch=1, enabled=True):
    return {"id": request_id, "slot": slot, "record": {"instance": INSTANCE, "epoch": epoch, "enabled": enabled}}


class Call:
    def __init__(self, service, *, deadline=None, cancel=None):
        self.result = self.error = None
        def run():
            try: self.result = service.serve_one(deadline=deadline or time.monotonic()+1, cancel=cancel)
            except BaseException as error: self.error = error
        self.thread = threading.Thread(target=run, name="owned-store-service-fixture", daemon=True)
        self.thread.start()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".orbit-service-", dir=Path.home())
        self.root_fd = None
        self.extra_root_fds, self.service_roots = [], {}
        self.services, self.clients, self.calls, self.releases = [], [], [], []
        self.addCleanup(self.cleanup_owned)
        self.base = Path(self.temp.name)
        self.root = self.base / "store"; self.root.mkdir(mode=0o700)
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.entries = ((object(), "1"*64), (object(), "2"*64))
        self.service, self.client = self.new_service()

    def cleanup_owned(self):
        errors, unknown = [], False
        for release in self.releases: release.set()
        for service in self.services:
            try: service.close()
            except BaseException: errors.append("service-close")
        for call in self.calls:
            call.thread.join(timeout=2)
            if call.thread.is_alive(): unknown = True; errors.append("thread-still-active")
        for service in self.services:
            try:
                if not service.status()["localResourcesClosed"]:
                    unknown = True; errors.append("service-cleanup-unconfirmed")
            except BaseException:
                unknown = True; errors.append("service-status-unconfirmed")
        for client in self.clients:
            try: client.close()
            except OSError: errors.append("client-close")
        for fd in ([self.root_fd] if self.root_fd is not None else []) + self.extra_root_fds:
            try: os.close(fd)
            except OSError: errors.append("root-close")
        if unknown:
            self.temp._finalizer.detach()  # Preserve private artifacts if a syscall has not returned.
        else:
            self.temp.cleanup()
        if errors: raise RuntimeError("Owned service fixture cleanup unconfirmed: " + ",".join(errors))

    def new_service(self):
        # Every independent session gets a genuinely fresh fixture root. Old roots
        # retain their permanent marker and are never silently reinitialized.
        root, root_fd = self.root, self.root_fd
        if self.services:
            root = self.base / ("store-" + str(len(self.services)))
            root.mkdir(mode=0o700)
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            self.extra_root_fds.append(root_fd)
        server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.setblocking(False); client.setblocking(False)
            service = subject.ReadUsageStoreService(server, str(root), self.entries, expected_root_fd=root_fd)
        except BaseException:
            server.close(); client.close(); raise
        self.services.append(service); self.clients.append(client)
        self.service_roots[service] = (root, root_fd)
        return service, client

    def call(self, service=None, **values):
        call = Call(service or self.service, **values); self.calls.append(call); return call

    def join(self, call):
        call.thread.join(timeout=2)
        self.assertFalse(call.thread.is_alive(), "Controlled service fixture did not finish")
        return call

    def send(self, payload, client=None):
        client = client or self.client
        view = memoryview(payload); deadline = time.monotonic()+1
        while view:
            self.assertLess(time.monotonic(), deadline)
            if not select.select([], [client], [], max(0, deadline-time.monotonic()))[1]: continue
            count = client.send(view); self.assertGreater(count, 0); view = view[count:]

    def exact(self, count, client=None):
        client = client or self.client
        data, deadline = bytearray(), time.monotonic()+1
        while len(data) < count:
            self.assertLess(time.monotonic(), deadline)
            if not select.select([client], [], [], max(0, deadline-time.monotonic()))[0]: continue
            chunk = client.recv(count-len(data)); self.assertTrue(chunk); data.extend(chunk)
        return bytes(data)

    def ack(self, request_id, client=None):
        size = struct.unpack(">I", self.exact(4, client))[0]
        self.assertLessEqual(size, 1024)
        self.assertEqual(self.exact(size, client), encoded({"id": request_id, "ok": True}))

    def roundtrip(self, value, service=None, client=None):
        call = self.call(service); self.send(frame(value), client); self.ack(value["id"], client)
        self.join(call); self.assertIsNone(call.error); self.assertIs(call.result, True)

    def fail(self, payload, service=None, client=None):
        service = service or self.service; client = client or self.client
        # Queue while the owned channel is open, before a rejecting service can close it.
        self.send(payload, client); call = self.call(service); self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertNotIn(SECRET, str(call.error))
        self.assertIsNone(call.result)
        self.assertTrue(service.status()["failed"])
        self.assertTrue(service.status()["closed"])
        try:
            reply = client.recv(1024)
        except ConnectionResetError:
            reply = b""  # Unread request can reset AF_UNIX on close; never an ACK.
        self.assertEqual(reply, b"")

    def disk(self, slot=0):
        return json.loads((self.root / (self.entries[slot][1] + ".json")).read_text())

    def test_real_on_then_off_commits_persist_and_use_back_to_back_exact_ids(self):
        self.roundtrip(request(1, epoch=1, enabled=True))
        self.assertEqual(self.disk(), {"schema": 1, "instance": INSTANCE, "epoch": 1, "enabled": True})
        self.roundtrip(request(2, epoch=2, enabled=False))
        self.assertEqual(self.disk(), {"schema": 1, "instance": INSTANCE, "epoch": 2, "enabled": False})
        self.assertFalse(any(path.name.endswith((".pending", ".writing")) for path in self.root.iterdir()))

    def test_global_ids_and_trusted_slots_are_independent_of_record_epochs(self):
        self.roundtrip(request(1, 0, 1, False)); self.roundtrip(request(2, 1, 1, True))
        self.assertFalse(self.disk(0)["enabled"]); self.assertTrue(self.disk(1)["enabled"])

    def test_split_real_header_and_body_are_received_without_extra_frames(self):
        wire = frame(request()); call = self.call()
        for byte in wire: self.send(bytes([byte]))
        self.ack(1); self.join(call); self.assertIs(call.result, True)

    def test_exact_max_safe_request_id_can_complete_but_never_wrap(self):
        self.service._next = 9007199254740991  # Private fixture counter, no unbounded loop.
        self.roundtrip(request(9007199254740991))
        self.fail(frame(request(1)))
        self.assertEqual(self.disk()["epoch"], 1)

    def test_unknown_keys_flattened_body_or_forged_slots_refuse_without_data(self):
        values = [dict(request(), extra=True), {"id": 1, "slot": 0, "instance": INSTANCE, "epoch": 1, "enabled": True},
                  request(slot=2), request(slot=True), request(request_id=True), request(epoch=True)]
        for index, value in enumerate(values):
            service, client = (self.service, self.client) if index == 0 else self.new_service()
            self.fail(frame(value), service, client)
            self.assertFalse((self.root / (self.entries[0][1] + ".json")).exists())

    def test_duplicate_keys_wrong_order_whitespace_escapes_and_nonascii_are_noncanonical(self):
        raw = encoded(request())
        samples = [raw.replace(b'"id":1', b'"id":1,"id":1'), b" " + raw,
                   encoded({"slot": 0, "id": 1, "record": request()["record"]}),
                   raw.replace(b'"instance"', b'"\\u0069nstance"'), b"\xff"]
        for index, value in enumerate(samples):
            service, client = (self.service, self.client) if index == 0 else self.new_service()
            self.fail(struct.pack(">I", len(value)) + value, service, client)

    def test_zero_oversized_truncated_and_extra_pipelined_frames_fail_closed(self):
        samples = [struct.pack(">I", 0), struct.pack(">I", 1025), frame(request()) + frame(request(2, epoch=2))]
        for index, payload in enumerate(samples):
            service, client = (self.service, self.client) if index == 0 else self.new_service()
            # Queue before serving to make pipelining detection deterministic.
            self.send(payload, client); call = self.call(service); self.join(call)
            self.assertIsInstance(call.error, subject.ReadUsageServiceError)
            self.assertTrue(service.status()["failed"])
        service, client = self.new_service(); self.send(b"\x00\x00", client); client.shutdown(socket.SHUT_WR)
        call = self.call(service); self.join(call); self.assertIsInstance(call.error, subject.ReadUsageServiceError)

    def test_duplicate_or_skipped_request_ids_are_sticky_not_replayed(self):
        self.roundtrip(request()); self.fail(frame(request(1, epoch=2)))
        with self.assertRaises(subject.ReadUsageServiceError): self.service.serve_one(deadline=time.monotonic()+1)
        self.assertEqual(self.disk()["epoch"], 1)

    def test_real_store_rejects_stale_epoch_and_service_never_acks_it(self):
        self.roundtrip(request()); self.fail(frame(request(2, epoch=1)))
        self.assertEqual(self.disk()["epoch"], 1)

    def test_record_types_and_lengths_are_validated_before_commit(self):
        changes = [{"instance": "a"*63}, {"epoch": 0}, {"epoch": 9007199254740992}, {"enabled": 1}, {"enabled": None}]
        for index, change in enumerate(changes):
            value = request(); value["record"].update(change)
            service, client = (self.service, self.client) if index == 0 else self.new_service()
            self.fail(frame(value), service, client)
        self.assertFalse((self.root / (self.entries[0][1] + ".json")).exists())

    def test_commit_fsync_failure_has_no_ack_and_keeps_durable_pending_barrier(self):
        native = os.fsync
        def fsync(fd):
            if os.readlink("/proc/self/fd/" + str(fd)).endswith(".pending"): raise OSError(SECRET)
            return native(fd)
        with patch.object(os, "fsync", side_effect=fsync): self.fail(frame(request()))
        self.assertTrue((self.root / (self.entries[0][1] + ".pending")).exists())

    def test_ack_waits_for_actual_final_directory_fsync_to_return(self):
        entered, release = threading.Event(), threading.Event(); self.releases.append(release)
        native = os.fsync
        root_info = os.fstat(self.root_fd)
        def fsync(fd):
            native(fd)
            info = os.fstat(fd)
            if ((info.st_dev, info.st_ino) == (root_info.st_dev, root_info.st_ino)
                    and (self.root / (self.entries[0][1] + ".json")).exists()
                    and not (self.root / (self.entries[0][1] + ".pending")).exists()):
                entered.set()
                if not release.wait(timeout=1): raise OSError("Owned fsync barrier expired")
        with patch.object(os, "fsync", side_effect=fsync):
            call = self.call(); self.send(frame(request()))
            try:
                self.assertTrue(entered.wait(timeout=1))
                self.assertEqual(select.select([self.client], [], [], 0)[0], [])
            finally: release.set()
            self.ack(1); self.join(call); self.assertIs(call.result, True)

    def test_client_disconnect_during_suspended_commit_preserves_work_until_return(self):
        entered, release = threading.Event(), threading.Event(); self.releases.append(release)
        native = ReadUsageStore.commit
        def commit(store, conversation, value):
            entered.set()
            if not release.wait(timeout=1): raise OSError("Owned commit barrier expired")
            return native(store, conversation, value)
        with patch.object(ReadUsageStore, "commit", commit):
            call = self.call(); self.send(frame(request()))
            try:
                self.assertTrue(entered.wait(timeout=1)); self.client.close()
                self.assertTrue(self.service.status()["busy"])
                with self.assertRaises(ReadUsageStoreError): ReadUsageStore(str(self.root), self.entries, expected_root_fd=self.root_fd)
            finally: release.set()
            self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertTrue(self.disk()["enabled"])  # Durable write does not mean client acknowledgement.
        self.assertTrue(self.service.status()["localResourcesClosed"])

    def test_close_false_during_commit_is_not_cancellation_or_store_release(self):
        entered, release = threading.Event(), threading.Event(); self.releases.append(release)
        native = ReadUsageStore.commit
        def commit(store, conversation, value):
            entered.set()
            if not release.wait(timeout=1): raise OSError("Owned commit barrier expired")
            return native(store, conversation, value)
        with patch.object(ReadUsageStore, "commit", commit):
            call = self.call(); self.send(frame(request()))
            try:
                self.assertTrue(entered.wait(timeout=1)); self.assertFalse(self.service.close())
                self.assertFalse(self.service.status()["localResourcesClosed"])
                with self.assertRaises(ReadUsageStoreError): ReadUsageStore(str(self.root), self.entries, expected_root_fd=self.root_fd)
            finally: release.set()
            self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertTrue(self.service.close())

    def test_close_after_last_check_before_completion_cannot_skip_cleanup_or_return_true(self):
        sent, at_boundary, release = threading.Event(), threading.Event(), threading.Event(); self.releases.append(release)
        native_send, native_check = socket.socket.send, self.service._check
        def send(connection, data, flags=0):
            count = native_send(connection, data, flags)
            if connection is self.service._connection and count: sent.set()
            return count
        def check(deadline, cancel, last):
            value = native_check(deadline, cancel, last)
            if sent.is_set():
                at_boundary.set()
                if not release.wait(timeout=1): raise RuntimeError("Owned final boundary expired")
            return value
        with patch.object(socket.socket, "send", send), patch.object(self.service, "_check", side_effect=check):
            call = self.call(); self.send(frame(request()))
            try:
                self.assertTrue(at_boundary.wait(timeout=1)); self.assertFalse(self.service.close())
            finally: release.set()
            self.join(call)
        self.assertIsNone(call.result); self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertTrue(self.service.status()["failed"]); self.assertTrue(self.service.status()["localResourcesClosed"])

    def test_cancel_deadline_and_eof_are_sticky_and_never_create_data(self):
        event = threading.Event(); event.set()
        call = self.call(cancel=event); self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertTrue(self.service.status()["closed"])
        service, client = self.new_service(); call = self.call(service, deadline=time.monotonic()+.03); self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        self.assertTrue(service.status()["closed"])
        self.assertFalse((self.root / (self.entries[0][1] + ".json")).exists())

    def test_lost_ack_is_not_replayed_or_restored_from_durable_on_record(self):
        native = self.service._no_extra; calls = [0]
        def no_extra():
            calls[0] += 1
            if calls[0] == 2: self.client.close()
            return native()
        with patch.object(self.service, "_no_extra", side_effect=no_extra):
            call = self.call(); self.send(frame(request())); self.join(call)
        self.assertIsInstance(call.error, subject.ReadUsageServiceError)
        with self.assertRaises(subject.ReadUsageServiceError): self.service.serve_one(deadline=time.monotonic()+1)
        self.assertTrue((self.root / ReadUsageStore.SESSION).exists())
        self.assertTrue(self.disk()["enabled"])  # Disk bytes are NOT permission or receipt.
        with self.assertRaises(ReadUsageStoreError): ReadUsageStore(str(self.root), self.entries, expected_root_fd=self.root_fd)

    def test_constructor_root_fd_mismatch_precedes_namespace_or_lock_mutation(self):
        other = self.base / "other"; other.mkdir(mode=0o700)
        fd = os.open(other, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        server, client = socket.socketpair(); server.setblocking(False)
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        try:
            with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(server, str(self.root), self.entries, expected_root_fd=fd)
            self.assertEqual({path.name: path.read_bytes() for path in self.root.iterdir()}, before)
            os.fstat(fd)
        finally: os.close(fd); server.close(); client.close()

    def test_constructor_rejects_blocking_listener_wrong_mapping_and_socket_reuse(self):
        server, client = socket.socketpair()
        try:
            with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(server, str(self.root), self.entries, expected_root_fd=self.root_fd)
            self.assertGreaterEqual(server.fileno(), 0)
        finally: server.close(); client.close()
        with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(self.service._connection, str(self.root), self.entries, expected_root_fd=self.root_fd)
        for entries in ((), tuple((object(), str(index)*64) for index in range(5)), ((object(), "not-key"),)):
            server, client = socket.socketpair(); server.setblocking(False)
            try:
                with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(server, str(self.root), entries, expected_root_fd=self.root_fd)
            finally: server.close(); client.close()

    def test_session_marker_exists_before_first_request_and_survives_clean_close(self):
        marker = self.root / ReadUsageStore.SESSION
        self.assertEqual(marker.read_bytes(), ReadUsageStore.SESSION_BYTES)
        identity = (marker.stat().st_dev, marker.stat().st_ino)
        self.roundtrip(request())
        self.assertTrue(self.service.close())
        self.assertEqual((marker.stat().st_dev, marker.stat().st_ino), identity)
        with self.assertRaises(ReadUsageStoreError): ReadUsageStore(str(self.root), self.entries, expected_root_fd=self.root_fd)
        server, client = socket.socketpair(); server.setblocking(False)
        try:
            with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(server, str(self.root), self.entries, expected_root_fd=self.root_fd)
        finally: server.close(); client.close()

    def test_independent_fresh_root_session_works_without_reusing_quarantined_root(self):
        self.service.close()
        other, client = self.new_service()
        self.roundtrip(request(), other, client)
        root, _fd = self.service_roots[other]
        self.assertNotEqual(root, self.root)
        self.assertTrue((self.root / ReadUsageStore.SESSION).exists())
        self.assertTrue((root / ReadUsageStore.SESSION).exists())

    def test_marker_replacement_after_commit_prevents_ack_and_is_not_removed(self):
        native = ReadUsageStore.commit
        def commit(store, conversation, value):
            native(store, conversation, value)
            marker = self.root / ReadUsageStore.SESSION
            marker.rename(self.base / "saved-marker")
            marker.write_bytes(ReadUsageStore.SESSION_BYTES); marker.chmod(0o600)
        with patch.object(ReadUsageStore, "commit", commit): self.fail(frame(request()))
        self.assertTrue((self.root / ReadUsageStore.SESSION).exists())
        self.assertTrue((self.base / "saved-marker").exists())
        self.assertTrue(self.disk()["enabled"])

    def test_corrupt_marker_after_readiness_invalidates_service_before_any_commit(self):
        marker = self.root / ReadUsageStore.SESSION
        marker.write_bytes(b"invalid")
        self.fail(frame(request()))
        self.assertEqual(marker.read_bytes(), b"invalid")
        self.assertFalse((self.root / (self.entries[0][1] + ".json")).exists())

    def test_marker_file_or_directory_fsync_failure_never_publishes_service(self):
        native = os.fsync
        for index, stage in enumerate(("marker", "directory")):
            root = self.base / ("fault-" + stage); root.mkdir(mode=0o700)
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC); self.extra_root_fds.append(fd)
            root_info = os.fstat(fd)
            server, client = socket.socketpair(); server.setblocking(False)
            def fsync(descriptor):
                path = os.readlink("/proc/self/fd/" + str(descriptor))
                info = os.fstat(descriptor)
                marker_exists = (root / ReadUsageStore.SESSION).exists()
                if (stage == "marker" and path.endswith(ReadUsageStore.SESSION)
                        or stage == "directory" and marker_exists and (info.st_dev, info.st_ino) == (root_info.st_dev, root_info.st_ino)):
                    raise OSError("Owned session fsync failpoint")
                return native(descriptor)
            try:
                with patch.object(os, "fsync", side_effect=fsync):
                    with self.assertRaises(subject.ReadUsageServiceError): subject.ReadUsageStoreService(server, str(root), self.entries, expected_root_fd=fd)
                self.assertTrue((root / ReadUsageStore.SESSION).exists())
                with self.assertRaises(ReadUsageStoreError): ReadUsageStore(str(root), self.entries, expected_root_fd=fd)
            finally: server.close(); client.close()

    def test_status_and_error_are_content_free_and_no_peer_or_stop_authority(self):
        status = dict(self.service.status())
        self.assertEqual(set(status), {"busy", "closed", "failed", "localResourcesClosed"})
        for value in (str(self.root), self.entries[0][1], INSTANCE): self.assertNotIn(value, repr(status))
        self.fail(struct.pack(">I", 1) + b"x")
        self.assertNotIn("peerStopped", self.service.status())


if __name__ == "__main__":
    unittest.main()
