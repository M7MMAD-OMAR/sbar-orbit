#!/usr/bin/python3
"""Real Unix socket checks for first-input preparation and non-replayed commits."""
import json
import socket
import unittest
from unittest.mock import patch

from native_transport_test import TransportTests, HostError
from src.native.keyboard import prepared_input


class PreparationTimingTests(unittest.TestCase):
    """A virtual monotonic clock measures waits without scheduler noise."""
    target = "0x123@1@lease-" + "a" * 32

    def setUp(self):
        self.now = 0.0
        self.waits = []
        self.requests = []
        self.ready_after = 1
        self.reply = "ok"

    def monotonic(self):
        return self.now

    def sleep(self, delay):
        self.waits.append(delay)
        self.now += delay

    def exchange(self, request, deadline):
        self.requests.append(request)
        command, _, token, *_ = request.split()
        if command == "ghost-keyboard-prepare":
            polls = sum(r.startswith(command + " ") for r in self.requests)
            return json.dumps({"schema": 1, "status": "ready" if polls > self.ready_after else "pending",
                               "token": token, "serial": 9})
        if command == "ghost-keyboard-cancel":
            return "ok"
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    def run_input(self, payload="ghost-key", deadline=1.0):
        value = "End" if payload == "ghost-key" else "6162"
        with patch("src.native.keyboard.time", self), patch("src.native.host.time.monotonic", self.monotonic):
            return prepared_input(f"{payload} {self.target} {value}", self.exchange, deadline)

    def test_fast_acknowledgement_uses_one_millisecond_wait(self):
        self.assertEqual(self.run_input(), "ok")
        self.assertEqual(self.waits, [0.001])
        self.assertEqual(len(self.requests), 3)

    def test_slow_acknowledgement_backs_off_at_ten_milliseconds(self):
        self.ready_after = 7
        self.run_input()
        self.assertEqual(self.waits, [0.001, 0.002, 0.004, 0.008, 0.01, 0.01, 0.01])

    def test_immediate_readiness_does_not_sleep(self):
        self.ready_after = 0
        self.run_input()
        self.assertEqual(self.waits, [])

    def test_wait_is_clipped_to_absolute_deadline_without_commit(self):
        self.ready_after = 100
        with self.assertRaises(TimeoutError):
            self.run_input(deadline=0.0005)
        self.assertEqual(self.waits, [0.0005])
        self.assertEqual(len(self.requests), 1)

    def test_text_count_acknowledgement_skips_cleanup(self):
        self.reply = "ok 4 keys\n"
        self.assertEqual(self.run_input("ghost-texthex"), self.reply)
        self.assertFalse(any("cancel" in r for r in self.requests))

    def test_key_refuses_text_acknowledgement_and_unknown_reply_still_cancels(self):
        for reply in ("ok 4 keys", "okay", "", "refused: owner active"):
            with self.subTest(reply=reply):
                self.requests = []
                self.reply = reply
                self.run_input()
                self.assertTrue(self.requests[-1].startswith("ghost-keyboard-cancel "))

    def test_lost_commit_reply_cancels_exact_token_without_resending_input(self):
        self.reply = HostError("lost reply")
        with self.assertRaisesRegex(HostError, "lost reply"):
            self.run_input()
        commits = [r for r in self.requests if r.startswith("ghost-key-prepared ")]
        self.assertEqual(len(commits), 1)
        self.assertEqual(self.requests[-1], "ghost-keyboard-cancel " + self.target + " " + commits[0].split()[2])


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
                    if getattr(self, "pending_rejection", False):
                        connection.sendall(b"refused: another keyboard operation is pending")
                        continue
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
                    if getattr(self, "reject_commit", False):
                        self.pending_rejection = True
                        response = b"unknown modifier invalid"
                    else:
                        response = getattr(self, "commit_reply", b"ok")
                elif request.startswith(b"ghost-keyboard-cancel "):
                    self.pending_rejection = False
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
        self.assertFalse(any(request.startswith(b"ghost-keyboard-cancel ") for request in actions))

    def test_wrong_preparation_token_refuses_before_input(self):
        self.full()
        self.wrong_token = True
        with self.assertRaises(HostError):
            self.transport.execute("ghost-key 0x123@1@lease-" + "a" * 32 + " End", self.control)
        self.assertEqual(self.commits(), [])

    def test_successful_text_receipt_does_not_send_redundant_cancellation(self):
        self.full()
        self.commit_reply = b"ok 4 keys\n"
        self.assertEqual(self.transport.execute("ghost-type 0x123@1@lease-" + "a" * 32 + " ab", self.control), "ok 4 keys")
        self.assertEqual(len(self.commits()), 1)
        self.assertTrue(self.commits()[0].endswith(b" 6162"))
        self.assertFalse(any(r.startswith(b"ghost-keyboard-cancel ") for r in self.actions()))

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

    def test_rejected_commit_releases_its_preparation_before_next_operation(self):
        self.full()
        self.reject_commit = True
        target = "0x123@1@lease-" + "a" * 32
        with self.assertRaisesRegex(HostError, "unknown modifier"):
            self.transport.execute("ghost-key " + target + " invalid+l", self.control)
        self.reject_commit = False
        self.assertEqual(self.transport.execute("ghost-key " + target + " End", self.control), "ok")
        commits = self.commits()
        self.assertEqual(len(commits), 2)
        failed_token = commits[0].decode().split()[2]
        cancels = [r.decode() for r in self.actions() if r.startswith(b"ghost-keyboard-cancel ")]
        self.assertIn("ghost-keyboard-cancel " + target + " " + failed_token, cancels)


if __name__ == "__main__":
    unittest.main()
