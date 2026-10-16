#!/usr/bin/python3
"""Real Unix socket checks for first-input preparation and non-replayed commits."""
import json
import socket
import unittest

from native_transport_test import TransportTests, HostError


class KeyboardTransportTests(unittest.TestCase):
    setUp = TransportTests.setUp
    close = TransportTests.close
    record_request = TransportTests.record_request
    actions = TransportTests.actions
    prepare = TransportTests.prepare

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
                data = bytearray()
                while True:
                    chunk = connection.recv(1023)
                    data.extend(chunk)
                    if len(chunk) < 1023:
                        break
                request = bytes(data)
                self.record_request(request)
                if not index:
                    continue
                if request == b"j/version":
                    response = json.dumps(self.version).encode()
                elif request.startswith(b"ghost-keyboard-prepare "):
                    self.prepare_count = getattr(self, "prepare_count", 0) + 1
                    token = request.decode().split()[2]
                    status = "ready" if self.prepare_count >= 2 else "pending"
                    if getattr(self, "never_ready", False):
                        status = "pending"
                    if getattr(self, "wrong_token", False):
                        token = "0" * 32
                    response = json.dumps({"schema": 1, "status": status, "token": token, "serial": 9}).encode()
                elif request.startswith((b"ghost-key-prepared ", b"ghost-texthex-prepared ")):
                    if getattr(self, "drop_commit_reply", False):
                        continue
                    response = b"ok"
                else:
                    response = b"ok"
                try:
                    connection.sendall(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    def full(self):
        self.prepare()
        self.control.configure(mode="full")

    def commits(self):
        return [request for request in self.actions()
                if request.startswith((b"ghost-key-prepared ", b"ghost-texthex-prepared "))]

    def test_first_key_waits_for_matching_preparation_then_commits_once(self):
        self.full()
        self.assertEqual(self.transport.execute("ghost-key 0x123@1@lease-" + "a" * 32 + " End", self.control), "ok")
        actions = self.actions()
        prepares = [request for request in actions if request.startswith(b"ghost-keyboard-prepare ")]
        self.assertEqual(len(prepares), 2)
        self.assertEqual(len(self.commits()), 1)
        token = prepares[0].decode().split()[2]
        self.assertEqual(prepares[0], prepares[1])
        self.assertEqual(self.commits()[0].decode(), "ghost-key-prepared 0x123@1@lease-" + "a" * 32 + " " + token + " End")
        self.assertFalse(any(request.startswith(b"ghost-key ") for request in actions))

    def test_wrong_preparation_token_refuses_before_input(self):
        self.full()
        self.wrong_token = True
        with self.assertRaises(HostError):
            self.transport.execute("ghost-key 0x123@1@lease-" + "a" * 32 + " End", self.control)
        self.assertEqual(self.commits(), [])

    def test_missing_readiness_never_sends_input(self):
        self.full()
        self.never_ready = True
        with self.assertRaises((HostError, TimeoutError)):
            self.transport.execute("ghost-type 0x123@1@lease-" + "a" * 32 + " -first", self.control)
        self.assertEqual(self.commits(), [])

    def test_ambiguous_text_commit_is_not_replayed(self):
        self.full()
        self.drop_commit_reply = True
        with self.assertRaises(HostError):
            self.transport.execute("ghost-type 0x123@1@lease-" + "a" * 32 + " -first", self.control)
        self.assertEqual(len(self.commits()), 1)
        self.assertTrue(self.commits()[0].endswith(b" 2d6669727374"))


if __name__ == "__main__":
    unittest.main()
