"""Read-only helper wire/freshness/parent-death tests, no application bus access."""
import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import a11y_host_worker as worker
from src.native.a11y_host import A11yHost

GENERATION = "a" * 32


def request(**changes):
    value = {"protocol": 1, "generation": GENERATION, "requestId": "b" * 32, "method": "observe",
             "target": {"pid": os.getpid(), "title": "Fixture", "maxNodes": 300, "budgetMs": 1500,
                        "deadlineNs": time.monotonic_ns() + 4_000_000_000}}
    value.update(changes)
    return value


def read_response(connection):
    def exact(size):
        data = b""
        while len(data) < size:
            part = connection.recv(size - len(data))
            if not part:
                raise EOFError()
            data += part
        return data
    size = struct.unpack("!I", exact(4))[0]
    return json.loads(exact(size))


class ProtocolTests(unittest.TestCase):
    def test_qt_binds_before_provider_fields_and_reuses_that_proof_after_traversal(self):
        trace = []
        provider = worker.ReadOnlyProvider.__new__(worker.ReadOnlyProvider)
        provider.pump = lambda: None
        provider.identity = lambda node: (":1.2", "/org/a11y/atspi/accessible/1", os.getpid())
        provider.atspi = SimpleNamespace(Cache=SimpleNamespace(NONE=0))
        app = SimpleNamespace(get_toolkit_name=lambda: "Qt", set_cache_mask=lambda value: trace.append("cache"))
        node = SimpleNamespace(get_application=lambda: (trace.append("application") or app),
                               clear_cache_single=lambda: trace.append("clear"))
        proof = SimpleNamespace(bind=lambda path: trace.append("bind"),
                                retain=lambda nodes, identity: trace.append("retain"),
                                close=lambda: trace.append("close"))
        with patch("src.native.a11y_qt_identity.QtIdentity", return_value=proof) as constructor:
            provider.begin_qualification(app, node, os.getpid())
            provider.refresh(node)
            trace.append("fields")
            result = provider.qualify(app, node, [(node, {"role": "button"})], os.getpid())
        self.assertIsNone(constructor.call_args.args[2])
        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(trace, ["bind", "application", "cache", "clear", "fields", "retain"])
        self.assertIs(result, proof)
        self.assertIsNone(provider._qt_preproof)

    def test_qt_mapping_change_during_fields_cannot_be_requalified_after_traversal(self):
        closed = []
        provider = worker.ReadOnlyProvider.__new__(worker.ReadOnlyProvider)
        app = SimpleNamespace(get_toolkit_name=lambda: "Qt")
        def replaced(nodes, identity):
            raise ValueError("Original numeric ID now maps to another widget")
        provider._qt_preproof = SimpleNamespace(retain=replaced, close=lambda: closed.append(True))
        with self.assertRaises(worker.SnapshotError):
            provider.qualify(app, object(), [(object(), {"role": "button"})], os.getpid())
        self.assertEqual(closed, [True])
        self.assertIsNone(provider._qt_preproof)

    def test_publication_reserves_scoped_ref_bytes_without_leaking_placeholder_handles(self):
        from src.native.a11y_snapshots import SnapshotStore
        records = [{"role": "button", "box": [1, 2, 3, 4], "name": "x" * 75} for _ in range(300)]
        kept, cut = worker.trim_refs(records)
        self.assertEqual(cut, "bytes")
        self.assertTrue(0 < len(kept) < len(records))
        self.assertTrue(all("ref" not in item for item in kept))
        store = SnapshotStore(lambda item: (":1.1", "/" + str(item), 1), lambda root, item: True)
        published, _ = store.publish((1,), 0, 0, list(enumerate(kept)))
        self.assertLessEqual(len(json.dumps(published, ensure_ascii=False, separators=(",", ":")).encode()), 16000)
        self.assertTrue(all(item["ref"].startswith("@") for item in published))

    def test_selected_ref_expiry_during_post_resolution_reads_is_rejected(self):
        from src.native.a11y_snapshots import SnapshotStore
        now = [1.0]
        provider = worker.ReadOnlyProvider.__new__(worker.ReadOnlyProvider)
        provider.epoch, provider.changed, provider.pid = 4, False, os.getpid()
        provider.pump = lambda: None
        provider.identity = lambda node: (":1.2", "/a11y/root", os.getpid())
        provider.snapshots = SnapshotStore(provider.identity, lambda root, node: True, clock=lambda: now[0], ttl=1)
        def delayed_name():
            now[0] = 2.0
            return "Fixture"
        node = SimpleNamespace(get_role_name=lambda: "frame", get_name=delayed_name)
        binding = (os.getpid(), "generation", "Fixture", "abc")
        nodes, _ = provider.snapshots.publish(binding, 4, node, [(node, {"role": "frame", "name": "Fixture"})])
        target = request()["target"]
        target["selection"] = {"window": "abc", "resolve": nodes[0]["ref"]}
        with patch.object(worker, "process_generation", return_value="generation"):
            result = provider.observe(target)
        self.assertEqual(result, {"status": "ref-error", "code": "STALE_REF"})

    def test_root_expiry_during_qualification_closes_new_proof_without_publication(self):
        from src.native.a11y_snapshots import SnapshotStore
        now, closed = [1.0], []
        provider = worker.ReadOnlyProvider.__new__(worker.ReadOnlyProvider)
        provider.epoch, provider.changed, provider.pid = 4, False, os.getpid()
        provider.pump = lambda: None
        provider.refresh = lambda node: None
        provider.atspi = None
        provider.identity = lambda node: (":1.2", "/a11y/root", os.getpid())
        provider.snapshots = SnapshotStore(provider.identity, lambda root, node: True, clock=lambda: now[0], ttl=1)
        node = SimpleNamespace(get_application=lambda: None)
        binding = (os.getpid(), "generation", "Fixture", "abc")
        nodes, _ = provider.snapshots.publish(binding, 4, node, [(node, {"role": "frame"})])
        def qualify(*args):
            now[0] = 2.0
            return SimpleNamespace(close=lambda: closed.append(True))
        provider.qualify = qualify
        def walk(*args):
            args[5](node, {"role": "frame"}, {})
            return [{"role": "frame"}], {"truncated": None}
        target = request()["target"]
        target["selection"] = {"window": "abc", "root": nodes[0]["ref"]}
        with patch.object(worker, "process_generation", return_value="generation"), patch.object(worker.a11y_dump, "box_of", return_value=[0, 0, 100, 100]), patch.object(worker.a11y_dump, "walk", side_effect=walk):
            result = provider.observe(target)
        self.assertEqual(result, {"status": "ref-error", "code": "STALE_REF"})
        self.assertEqual(closed, [True])
        self.assertEqual(len(provider.snapshots.entries), 0)

    def test_only_explicit_bounded_observe_requests_are_accepted(self):
        self.assertEqual(worker.parse_request(request(), GENERATION)["title"], "Fixture")
        for changes in ({"method": "click"}, {"protocol": True}, {"generation": "c" * 32},
                        {"requestId": "not-qualified"}, {"extra": "PRIVATE"}):
            with self.assertRaises(ValueError):
                worker.parse_request(request(**changes), GENERATION)
        for key, value in (("pid", True), ("pid", 0), ("maxNodes", 301), ("maxNodes", True),
                           ("budgetMs", 1501), ("title", "\0"), ("title", "😀" * 5000),
                           ("deadlineNs", 0), ("deadlineNs", time.monotonic_ns() + 9_000_000_000)):
            message = request()
            message["target"][key] = value
            with self.assertRaises(ValueError):
                worker.parse_request(message, GENERATION)

    def test_server_reuses_only_read_provider_and_never_serializes_provider_errors(self):
        parent, child = socket.socketpair()
        calls = []
        class Provider:
            def observe(self, target):
                calls.append(target["title"])
                if len(calls) == 2:
                    raise RuntimeError("PRIVATE_PROVIDER_CONTENT")
                return {"status": "ok", "nodes": [{"name": "مرحبا"}]}
        made = []
        def factory():
            made.append(True)
            return Provider()
        thread = threading.Thread(target=worker.serve, args=(child, GENERATION, factory))
        thread.start()
        try:
            self.assertEqual(read_response(parent), {"protocol": 1, "generation": GENERATION, "kind": "ready"})
            for index in range(2):
                message = request(requestId=(str(index) * 32))
                worker.send(parent, message)
                response = read_response(parent)
                self.assertEqual(response["requestId"], message["requestId"])
                self.assertTrue(response["ok"])
                self.assertNotIn("PRIVATE_PROVIDER_CONTENT", json.dumps(response))
                self.assertEqual(response["result"]["status"], "ok" if index == 0 else "unavailable")
            self.assertEqual(made, [True])
        finally:
            parent.close()
            thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_invalid_action_closes_without_initializing_provider(self):
        parent, child = socket.socketpair()
        factory = lambda: self.fail("provider initialized for input action")
        thread = threading.Thread(target=worker.serve, args=(child, GENERATION, factory))
        thread.start()
        try:
            read_response(parent)
            worker.send(parent, request(method="set-value"))
            self.assertEqual(parent.recv(1), b"")
        finally:
            parent.close()
            thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_frame_bound_is_checked_before_payload_read(self):
        parent, child = socket.socketpair()
        try:
            parent.sendall(struct.pack("!I", worker.MAX_REQUEST + 1))
            with self.assertRaises(ValueError):
                worker.receive(child)
        finally:
            parent.close()
            child.close()

    def test_expected_parent_mismatch_fails_before_prctl(self):
        with patch.object(worker.os, "getppid", return_value=99), patch.object(worker.ctypes, "CDLL") as library:
            with self.assertRaises(RuntimeError):
                worker.arm_parent_death(100)
            library.assert_not_called()

    def test_parent_race_is_checked_after_parent_death_signal_is_armed(self):
        fake = SimpleNamespace(prctl=lambda *args: 0)
        with patch.object(worker.os, "getppid", side_effect=[100, 101]), patch.object(worker.ctypes, "CDLL", return_value=fake):
            with self.assertRaises(RuntimeError):
                worker.arm_parent_death(100)

    def test_real_worker_is_killed_and_reaped_when_its_supervisor_dies(self):
        import ctypes
        import select
        import signal
        import subprocess
        import tempfile
        library = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        if not hasattr(os, "pidfd_open") or library.prctl(37, ctypes.byref(previous), 0, 0, 0) != 0:
            self.skipTest("pidfd/subreaper unavailable")
        self.assertEqual(library.prctl(36, 1, 0, 0, 0), 0)
        parent = None
        helper_pid, descriptor = None, None
        try:
            with tempfile.TemporaryDirectory() as runtime:
                code = ("import sys,time; sys.path.insert(0," + repr(str(Path(__file__).resolve().parents[1])) + "); "
                        "from src.native.a11y_host import A11yHost; host=A11yHost(" + repr(runtime) + "); "
                        "host._start(time.monotonic_ns()+3000000000); print(host._process.pid,flush=True); sys.stdin.readline()")
                parent = subprocess.Popen(["/usr/bin/python3", "-I", "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                self.assertTrue(select.select([parent.stdout], [], [], 4)[0], "helper did not become ready")
                helper_pid = int(parent.stdout.readline())
                descriptor = os.pidfd_open(helper_pid)
                parent.kill()
                parent.wait(timeout=1)
                self.assertTrue(select.select([descriptor], [], [], 2)[0], "helper survived its supervisor")
                waited, status = os.waitpid(helper_pid, 0)
                helper_pid = None
                self.assertTrue(os.WIFSIGNALED(status))
                self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
        finally:
            if parent is not None:
                if parent.poll() is None:
                    parent.kill()
                parent.wait(timeout=2)
                parent.stdin.close()
                parent.stdout.close()
            if helper_pid is not None and descriptor is not None:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                if select.select([descriptor], [], [], 2)[0]:
                    os.waitpid(helper_pid, 0)
            if descriptor is not None:
                os.close(descriptor)
            library.prctl(36, previous.value, 0, 0, 0)

    def test_real_worker_handshake_does_not_initialize_accessibility(self):
        import tempfile
        with tempfile.TemporaryDirectory() as runtime:
            host = A11yHost(runtime)
            try:
                deadline = time.monotonic_ns() + 3_000_000_000
                connection, generation = host._start(deadline)
                self.assertIsNotNone(connection)
                self.assertEqual(len(generation), 32)
            finally:
                host.close()
            self.assertIsNone(host._process)


class CacheTests(unittest.TestCase):
    def provider(self):
        provider = worker.ReadOnlyProvider.__new__(worker.ReadOnlyProvider)
        provider.deadline = time.monotonic_ns() + 4_000_000_000
        provider.changed = False
        provider.atspi = SimpleNamespace(Cache=SimpleNamespace(NONE=0))
        provider.context = SimpleNamespace(pending=lambda: False, iteration=lambda _: None)
        return provider

    def test_each_proxy_disables_and_clears_existing_cache(self):
        provider = self.provider()
        calls = []
        node = SimpleNamespace(set_cache_mask=lambda mask: calls.append(("mask", mask)),
                               clear_cache_single=lambda: calls.append(("clear",)))
        node.get_application = lambda: node
        provider.refresh(node)
        self.assertEqual(calls, [("mask", 0), ("clear",)])

    def test_child_cache_mask_is_applied_to_application_root(self):
        provider = self.provider()
        calls = []
        root = SimpleNamespace(set_cache_mask=lambda value: calls.append(("root-mask", value)))
        child = SimpleNamespace(get_application=lambda: root, clear_cache_single=lambda: calls.append(("child-clear",)))
        provider.refresh(child)
        self.assertEqual(calls, [("root-mask", 0), ("child-clear",)])

    def test_switching_owner_invalidates_retained_refs_before_later_resolution(self):
        provider = self.provider()
        provider.owner, provider.epoch = ":1.10", 7
        calls = []
        provider.snapshots = SimpleNamespace(clear=lambda: calls.append("clear"))
        provider.watch_owner = lambda owner: None
        provider.select_owner(":1.11")
        self.assertEqual((provider.owner, provider.epoch, calls), (":1.11", 8, ["clear"]))
        provider.select_owner(":1.11")
        self.assertEqual(provider.epoch, 8)

    def test_event_flood_is_bounded_and_marks_observation_unstable(self):
        provider = self.provider()
        calls = []
        provider.context = SimpleNamespace(pending=lambda: True, iteration=lambda _: calls.append(True))
        provider.pump()
        self.assertEqual(len(calls), 16)
        self.assertTrue(provider.changed)

    def test_process_or_observed_event_churn_discards_partial_observation(self):
        for generations, changed in ((["old", "new"], False), (["same", "same"], True)):
            provider = self.provider()
            def walk(*args, **kwargs):
                provider.changed = changed
                return {"status": "ok", "nodes": [{"name": "PRIVATE_PARTIAL"}]}
            with patch.object(worker, "process_generation", side_effect=generations), patch.object(worker.a11y_dump, "main", side_effect=walk):
                result = provider.observe(request()["target"])
            self.assertEqual(result["status"], "unavailable")
            self.assertNotIn("PRIVATE_PARTIAL", json.dumps(result))

    def test_current_process_generation_can_be_read_without_application_access(self):
        self.assertTrue(worker.process_generation(os.getpid()).isdigit())


if __name__ == "__main__":
    unittest.main()
