#!/usr/bin/python3
"""Real socket transport checks without connecting to a desktop compositor."""
import json
import os
from pathlib import Path
import socket
import sys
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.host import HostError, inspect_host
from src.native.transport import NativeTransport
from action_control import ActionControl, ControlError, dispatch_native
import native_host_test as fixtures

if "--transport-source" in sys.argv:
    index = sys.argv.index("--transport-source")
    source = Path(sys.argv.pop(index + 1))
    sys.argv.pop(index)
    module = types.ModuleType("unfixed_transport")
    module.__package__ = "src.native"
    exec(compile(source.read_text(), str(source), "exec"), module.__dict__)
    NativeTransport = module.NativeTransport


class TransportTests(unittest.TestCase):
    setUp = fixtures.HostTests.setUp
    close = fixtures.HostTests.close
    record_request = fixtures.HostTests.record_request

    def serve(self, index, listener):
        while not self.stop.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                connection.settimeout(4)
                request = bytearray()
                while True:
                    chunk = connection.recv(1023)
                    request.extend(chunk)
                    if len(chunk) < 1023:
                        break
                request = bytes(request)
                self.record_request(request)
                if not index:
                    continue
                if request == b"j/version":
                    response = json.dumps(self.version).encode()
                elif getattr(self, "action_stall", False):
                    self.stop.wait(4)
                    continue
                else:
                    response = getattr(self, "response", b"ok")
                try:
                    connection.sendall(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    def actions(self):
        return [request for request in self.requests if request not in (b"", b"j/version")]

    def prepare(self):
        self.plan = inspect_host(self.env)
        self.transport = NativeTransport(self.plan)
        self.control = ActionControl(self.runtime / "control")
        self.addCleanup(self.control.close)

    def test_protected_denial_precedes_wire_and_full_records_success(self):
        self.prepare()
        request = "ghost-cursor 0x123 40 50"
        with self.assertRaises(ControlError):
            self.transport.execute(request, self.control)
        self.assertEqual(self.actions(), [])
        self.control.configure(mode="full")
        self.assertEqual(self.transport.execute(request, self.control), "ok")
        self.assertEqual(self.actions(), [request.encode()])
        snapshot = self.control.inspect()
        self.assertEqual(snapshot["unresolved"], [])
        self.assertEqual(snapshot["events"][-1]["outcome"], "success")

    def test_stale_abi_prevents_action(self):
        self.prepare()
        self.control.configure(mode="full")
        self.version["abiHash"] = "changed"
        with self.assertRaisesRegex(HostError, "stale"):
            self.transport.execute("ghost-click 0x123 40 50 1", self.control)
        self.assertEqual(self.actions(), [])
        self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")

    def test_connected_peer_checked_before_send(self):
        self.prepare()
        self.control.configure(mode="full")
        with patch("src.native.transport.peer", return_value=[os.getpid(), 1]):
            with self.assertRaisesRegex(HostError, "changed before"):
                self.transport.execute("ghost-cursor 0x123 40 50", self.control)
        self.assertEqual(self.actions(), [])

    def test_caller_plan_mutation_does_not_rebind_transport(self):
        self.prepare()
        self.plan["compositor"][1] = 1
        self.plan["signature"] = "other"
        self.control.configure(mode="full")
        self.assertEqual(self.transport.execute("ghost-hide-cursor 0x123", self.control), "ok")

    def test_journal_failure_precedes_action(self):
        self.prepare()
        self.control.configure(mode="full")
        with patch.object(self.control, "_record", side_effect=OSError("storage unavailable")):
            with self.assertRaises(OSError):
                self.transport.execute("ghost-cursor 0x123 40 50", self.control)
        self.assertEqual(self.actions(), [])

    def test_missing_resource_budget_prevents_action(self):
        self.prepare()
        self.control.configure(mode="full")
        with patch("src.native.transport.require_budget", side_effect=RuntimeError("budget absent")):
            with self.assertRaisesRegex(RuntimeError, "budget absent"):
                self.transport.execute("ghost-cursor 0x123 40 50", self.control)
        self.assertEqual(self.actions(), [])

    def test_unrelated_commands_and_multiline_input_refused(self):
        self.prepare()
        for request in ("dispatch focuswindow 0x123", "ghost-mode full", "ghost-cursor 0x123\nfoo",
                        "ghost-cursor\0foo", "ghost-type " + "x" * 65536):
            with self.subTest(request=request[:40]), self.assertRaises(HostError):
                self.transport.execute(request, self.control)
        self.assertEqual(self.actions(), [])

    def test_error_and_oversize_reply_fail_and_record_error(self):
        self.prepare()
        self.control.configure(mode="full")
        for response in (b"target not owned", b"x" * 65537, b"\xff"):
            self.response = response
            with self.subTest(size=len(response)), self.assertRaises((HostError, UnicodeError)):
                self.transport.execute("ghost-click 0x123 40 50 1", self.control)
            snapshot = self.control.inspect()
            self.assertEqual(snapshot["unresolved"], [])
            self.assertEqual(snapshot["events"][-1]["outcome"], "error")

    def test_state_query_requires_structured_boolean_fields(self):
        self.prepare()
        self.control.configure(mode="full")
        for response in (b"ok", b"{}", b'{"suspended":0,"render_unfocused":true}'):
            self.response = response
            with self.subTest(response=response), self.assertRaises(HostError):
                self.transport.execute("ghost-state 0x123", self.control)
            self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")
            with patch.dict(sys.modules, {"ghost": types.SimpleNamespace(_hypr=lambda _: response.decode())}):
                with self.assertRaises(ControlError):
                    dispatch_native("ghost-state 0x123")
        self.response = b'{"suspended":false,"render_unfocused":true}'
        self.assertEqual(json.loads(self.transport.execute("ghost-state 0x123", self.control)),
                         {"suspended": False, "render_unfocused": True})

    def test_stalled_action_has_deadline_and_no_retry(self):
        self.prepare()
        self.control.configure(mode="full")
        self.action_stall = True
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.transport.execute("ghost-scroll 0x123 0 -1", self.control)
        self.assertLess(time.monotonic() - started, 3.5)
        self.assertEqual(len(self.actions()), 1)
        self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")

    def test_exact_hyprland_input_chunks_terminate_without_stalling(self):
        self.prepare()
        self.control.configure(mode="full")
        prefix = "ghost-type 0x123 "
        for length in (1023, 2046, 4092):
            request = prefix + "x" * (length - len(prefix))
            self.assertEqual(self.transport.execute(request, self.control), "ok")
        self.assertEqual([len(request) for request in self.actions()], [1023, 2046, 4092])

    def test_scope_enrollment_checks_membership_before_and_after(self):
        self.prepare()
        self.control.configure(mode="full")
        unit = "orbit-native-" + "a" * 32 + ".scope"
        token = "12345678-1234-1234-1234-123456789abc"
        self.response = ("ok " + token).encode()
        process = (os.getpid(), 123)
        lease = types.SimpleNamespace(unit=unit, contains=lambda identity: identity == process)
        self.assertEqual(self.transport.enroll(lease, process, self.control), token)
        with patch.object(lease, "contains", return_value=False):
            with self.assertRaisesRegex(HostError, "outside"):
                self.transport.enroll(lease, process, self.control)
        self.assertEqual(len(self.actions()), 1)
        with patch.object(lease, "contains", side_effect=[True, False]):
            with self.assertRaisesRegex(HostError, "changed during"):
                self.transport.enroll(lease, process, self.control)
        self.assertEqual(len(self.actions()), 2)
        self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")


if __name__ == "__main__":
    unittest.main()
