#!/usr/bin/python3
"""Exercise endpoint binding with real Unix sockets, without desktop input."""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.native.host import HostError, inspect_host, read_plan, verify_host


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-host-")
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name)
        (self.runtime / "hypr" / "test").mkdir(parents=True, mode=0o700)
        self.env = {"XDG_RUNTIME_DIR": str(self.runtime), "HYPRLAND_INSTANCE_SIGNATURE": "test", "WAYLAND_DISPLAY": "wayland-test"}
        self.version = {"abiHash": "test_abi", "commit": "a" * 40, "version": "test"}
        self.requests = []
        self.requests_ready = threading.Condition()
        self.stall = False
        self.threads = []
        self.listeners = []
        for path in (self.runtime / "wayland-test", self.runtime / "hypr" / "test" / ".socket.sock"):
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(path))
            listener.listen()
            listener.settimeout(0.1)
            self.listeners.append(listener)
        self.stop = threading.Event()
        self.addCleanup(self.close)
        for index, listener in enumerate(self.listeners):
            thread = threading.Thread(target=self.serve, args=(index, listener))
            thread.start()
            self.threads.append(thread)

    def serve(self, index, listener):
        while not self.stop.is_set():
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.settimeout(1)
                if index:
                    self.record_request(conn.recv(1024))
                    if self.stall:
                        self.stop.wait(4)
                        continue
                    try:
                        conn.sendall(json.dumps(self.version).encode())
                    except BrokenPipeError:
                        pass
                else:
                    self.record_request(conn.recv(1024))

    def record_request(self, request):
        with self.requests_ready:
            self.requests.append(request)
            self.requests_ready.notify_all()

    def close(self):
        self.stop.set()
        for listener in self.listeners:
            listener.close()
        for thread in self.threads:
            thread.join(2)

    def test_plan_and_revalidation_only_request_version(self):
        plan = inspect_host(self.env)
        self.assertEqual(plan["compositor"][0], os.getpid())
        self.assertEqual(verify_host(plan), plan)
        with self.requests_ready:
            self.assertTrue(self.requests_ready.wait_for(lambda: len(self.requests) == 4, timeout=1))
        self.assertEqual(sorted(self.requests), [b"", b"", b"j/version", b"j/version"])
        self.assertEqual(plan["owner_activation"], "not performed")
        self.assertEqual(plan["theme_match"], "not measured")

    def test_stale_process_abi_and_socket_fail(self):
        plan = inspect_host(self.env)
        for key, value in (("compositor", [os.getpid(), 1]), ("abi_hash", "other"), ("ipc_socket", [0, 0])):
            with self.subTest(key=key), self.assertRaisesRegex(HostError, "stale"):
                verify_host({**plan, key: value})

    def test_unsafe_paths_and_permissions_fail_before_connection(self):
        for key, value in (("WAYLAND_DISPLAY", "../wayland-test"), ("HYPRLAND_INSTANCE_SIGNATURE", "."), ("XDG_RUNTIME_DIR", str(self.runtime) + "/..")):
            with self.subTest(key=key), self.assertRaises(HostError):
                inspect_host({**self.env, key: value})
        self.runtime.chmod(0o777)
        with self.assertRaises(HostError):
            inspect_host(self.env)
        self.runtime.chmod(0o700)
        self.assertEqual(self.requests, [])

    def test_symlink_socket_fails(self):
        path = self.runtime / "wayland-test"
        path.rename(self.runtime / "real-socket")
        path.symlink_to("real-socket")
        with self.assertRaises(HostError):
            inspect_host(self.env)

    def test_invalid_and_oversize_version_fail(self):
        for version in ({}, {**self.version, "commit": "short"}, {**self.version, "abiHash": "x" * 40000}):
            self.version = version
            with self.subTest(version=list(version)), self.assertRaises(HostError):
                inspect_host(self.env)

    def test_distinct_endpoint_processes_fail(self):
        with patch("src.native.host.peer", side_effect=([1, 2], [3, 4])):
            with self.assertRaisesRegex(HostError, "different compositor"):
                inspect_host(self.env)

    def test_stalled_version_has_bounded_deadline(self):
        self.stall = True
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            inspect_host(self.env)
        self.assertLess(time.monotonic() - started, 3.5)

    def test_plan_reader_rejects_special_and_large_files(self):
        plan = self.runtime / "plan.json"
        plan.write_text('{"schema": 1}')
        self.assertEqual(read_plan(plan), {"schema": 1})
        plan.write_bytes(b" " * 65537)
        with self.assertRaisesRegex(HostError, "too large"):
            read_plan(plan)
        plan.unlink()
        os.mkfifo(plan)
        with self.assertRaisesRegex(HostError, "regular file"):
            read_plan(plan)
        plan.unlink()
        plan.symlink_to("wayland-test")
        with self.assertRaises(OSError):
            read_plan(plan)

    def test_unknown_plan_fails(self):
        for plan in (None, {}, {"schema": 2}, {"schema": True}):
            with self.subTest(plan=plan), self.assertRaises(HostError):
                verify_host(plan)


if __name__ == "__main__":
    unittest.main()
