"""Owned fake helper fixtures only. No accessibility bus or live application access."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import a11y_host

FIXTURE = r'''
import argparse, ctypes, json, os, signal, socket, struct, time
parser = argparse.ArgumentParser()
parser.add_argument("--fd", type=int)
parser.add_argument("--generation")
parser.add_argument("--expected-parent", type=int)
args = parser.parse_args()
# Exercise the real parent-death lifecycle using an owned fake provider.
if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != args.expected_parent:
    os._exit(1)
connection = socket.socket(fileno=args.fd)
def send(value):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    connection.sendall(struct.pack(">I", len(body)) + body)
def exact(size):
    body = b""
    while len(body) < size:
        chunk = connection.recv(size - len(body))
        if not chunk: os._exit(0)
        body += chunk
    return body
if MODE == "blocked-start":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(60)
hello = {"protocol": 1, "generation": args.generation, "kind": "ready"}
if MODE == "wrong-hello": hello["generation"] = "foreign"
if MODE == "extra-hello": hello["private"] = "private-content"
send(hello)
while True:
    size = struct.unpack(">I", exact(4))[0]
    request = json.loads(exact(size))
    assert set(request) == {"protocol", "generation", "requestId", "method", "target"}
    assert request["method"] == "observe" and request["protocol"] == 1
    assert request["generation"] == args.generation
    target = request["target"]
    assert set(target) == {"pid", "title", "maxNodes", "budgetMs", "deadlineNs"}
    assert target["maxNodes"] == 300 and target["budgetMs"] == 1500
    assert target["deadlineNs"] > time.monotonic_ns()
    result = {"status": "ok", "nodes": [{"name": "owned-✓-اختبار"}], "helperPid": os.getpid()}
    reply = {"protocol": 1, "generation": args.generation, "requestId": request["requestId"], "ok": True, "result": result}
    if MODE == "blocked-read":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(60)
    if MODE == "delayed": time.sleep(0.3)
    if MODE == "exit": os._exit(7)
    if MODE == "wrong-id": reply["requestId"] = "foreign"
    if MODE == "wrong-generation": reply["generation"] = "foreign"
    if MODE == "extra-reply": reply["private"] = "private-content"
    if MODE == "bad-result": reply["result"] = []
    if MODE == "bad-ok": reply["ok"] = 1
    if MODE == "remote-error":
        reply.pop("result"); reply.update(ok=False, error={"code": "UNAVAILABLE"})
    if MODE == "private-error":
        reply.pop("result"); reply.update(ok=False, error={"code": "private-content"})
    if MODE == "oversize":
        connection.sendall(struct.pack(">I", 256 * 1024 + 1)); time.sleep(60)
    if MODE == "truncated":
        connection.sendall(struct.pack(">I", 100) + b"{}"); os._exit(0)
    if MODE in ("malformed", "invalid-utf8", "nonfinite", "duplicate", "zero"):
        body = {"malformed": b"private-content", "invalid-utf8": b"\xff", "nonfinite": b'{"x":1e999}',
                "duplicate": b'{"protocol":1,"protocol":1}', "zero": b""}[MODE]
        connection.sendall(struct.pack(">I", len(body)) + body)
        continue
    if MODE == "environment": reply["result"] = {"environment": dict(os.environ)}
    if MODE == "unavailable": reply["result"] = {"status": "unavailable", "reason": "no matching frame"}
    body = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode()
    if MODE == "at-limit":
        reply["result"]["padding"] = ""
        empty = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode()
        reply["result"]["padding"] = "x" * (256 * 1024 - len(empty))
        body = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode()
    packet = struct.pack(">I", len(body)) + body
    if MODE == "split":
        for byte in packet:
            connection.sendall(bytes([byte]))
    elif MODE == "surplus":
        connection.sendall(packet + b"extra")
    else:
        connection.sendall(packet)
'''


@unittest.skipUnless(sys.platform == "linux", "Linux helper transport")
class HostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="orbit-a11y-host-test-")
        self.worker = Path(self.directory.name) / "fixture.py"
        self.write_mode("normal")
        self.path_patch = patch.object(a11y_host, "WORKER_PATH", self.worker)
        self.path_patch.start()
        self.host = a11y_host.A11yHost(self.directory.name)

    def tearDown(self):
        self.host.close()
        self.path_patch.stop()
        self.directory.cleanup()

    def write_mode(self, mode):
        self.worker.write_text("MODE = " + repr(mode) + "\n" + FIXTURE)

    def assert_failed(self, timeout_ms=500):
        process = self.host._process
        with self.assertRaisesRegex(a11y_host.A11yHostError, "^Accessibility helper transport failed$"):
            self.host.observe(os.getpid(), "owned fixture", timeout_ms=timeout_ms)
        self.assertIsNone(self.host._generation)
        self.assertIsNone(self.host._socket)
        self.assertIsNone(self.host._process)
        if process is not None:
            self.assertIsNotNone(process.poll())

    def test_lazy_start_reuses_process_and_generation(self):
        self.assertIsNone(self.host._process)
        first = self.host.observe(os.getpid(), "owned fixture")
        process, generation = self.host._process, self.host._generation
        second = self.host.observe(os.getpid(), "owned fixture")
        self.assertIs(self.host._process, process)
        self.assertEqual(self.host._generation, generation)
        self.assertEqual(first["helperPid"], second["helperPid"])
        self.assertEqual(first["nodes"][0]["name"], "owned-✓-اختبار")

    def test_split_unicode_and_header_are_reassembled(self):
        self.write_mode("split")
        self.assertEqual(self.host.observe(os.getpid(), "عنوان owned")["nodes"][0]["name"], "owned-✓-اختبار")

    def test_environment_is_allowlisted(self):
        self.write_mode("environment")
        with patch.dict(os.environ, {"SECRET_FIXTURE": "private-content", "LD_PRELOAD": "/not-real", "PYTHONPATH": "/not-real"}):
            environment = self.host.observe(os.getpid(), "owned")["environment"]
        # CPython may set LC_CTYPE while initializing from the fixed locale.
        self.assertTrue(set(environment) <= {"PATH", "LANG", "XDG_RUNTIME_DIR", "LC_CTYPE"})
        self.assertEqual(environment["XDG_RUNTIME_DIR"], self.directory.name)

    def test_mismatched_or_extra_handshake_destroys_generation(self):
        for mode in ("wrong-hello", "extra-hello"):
            with self.subTest(mode=mode):
                self.write_mode(mode)
                self.assert_failed()

    def test_malformed_response_destroys_process_without_content_leak(self):
        for mode in ("wrong-id", "wrong-generation", "extra-reply", "bad-result", "bad-ok", "remote-error",
                     "private-error", "malformed", "invalid-utf8", "nonfinite", "duplicate", "zero", "oversize", "truncated", "surplus", "exit"):
            with self.subTest(mode=mode):
                self.write_mode(mode)
                self.assert_failed()

    def test_valid_unavailable_observation_is_not_transport_failure(self):
        self.write_mode("unavailable")
        self.assertEqual(self.host.observe(os.getpid(), "owned")["status"], "unavailable")
        self.assertIsNotNone(self.host._generation)

    def test_startup_and_read_timeouts_kill_term_resistant_child(self):
        for mode in ("blocked-start", "blocked-read"):
            with self.subTest(mode=mode):
                self.write_mode(mode)
                started = time.monotonic()
                self.assert_failed(timeout_ms=200)
                self.assertLess(time.monotonic() - started, 1.5)

    def test_failure_has_no_automatic_retry_and_next_explicit_call_is_new_generation(self):
        self.host.observe(os.getpid(), "owned")
        prior = self.host._generation
        process = self.host._process
        process.kill(); process.wait(timeout=1)
        with patch.object(a11y_host.subprocess, "Popen", wraps=subprocess.Popen) as spawn:
            self.assert_failed()
            self.assertEqual(spawn.call_count, 0)
            self.host.observe(os.getpid(), "owned")
            self.assertEqual(spawn.call_count, 1)
        self.assertNotEqual(prior, self.host._generation)

    def test_close_is_idempotent_permanent_and_reaps(self):
        self.host.observe(os.getpid(), "owned")
        process = self.host._process
        self.host.close(); self.host.close()
        self.assertIsNotNone(process.poll())
        self.assert_failed()

    def test_invalid_requests_never_start_worker(self):
        with patch.object(a11y_host.subprocess, "Popen") as spawn:
            for pid, title, timeout in ((True, "x", 100), (0, "x", 100), (1, None, 100), (1, "x\0y", 100),
                                        (1, "x" * 16385, 100), (1, "x", 5001), (1, "x", float("nan")), (1, "x", True)):
                with self.subTest(pid=pid, timeout=timeout):
                    with self.assertRaises(a11y_host.A11yHostError):
                        self.host.observe(pid, title, timeout_ms=timeout)
            spawn.assert_not_called()

    def test_exact_response_byte_limit_is_accepted(self):
        self.write_mode("at-limit")
        self.assertGreater(len(self.host.observe(os.getpid(), "owned")["padding"]), 250_000)

    def test_invalid_input_preserves_existing_helper(self):
        self.host.observe(os.getpid(), "owned")
        process, generation = self.host._process, self.host._generation
        with self.assertRaises(a11y_host.A11yHostError):
            self.host.observe(0, "invalid")
        self.assertIs(self.host._process, process)
        self.assertEqual(self.host._generation, generation)
        self.assertIsNone(process.poll())
        self.assertEqual(self.host.observe(os.getpid(), "owned")["helperPid"], process.pid)

    def test_waiting_timeout_does_not_abort_admitted_observation(self):
        self.write_mode("delayed")
        outcomes, errors = [], []
        entered = threading.Event()
        original_read = self.host._read
        def read(connection, deadline):
            if self.host._generation is not None:
                entered.set()
            return original_read(connection, deadline)
        def observe():
            try:
                outcomes.append(self.host.observe(os.getpid(), "owned"))
            except BaseException as error:
                errors.append(error)
        with patch.object(self.host, "_read", side_effect=read):
            thread = threading.Thread(target=observe)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                process, generation = self.host._process, self.host._generation
                started = time.monotonic()
                with self.assertRaises(a11y_host.A11yHostError):
                    self.host.observe(os.getpid(), "competing", timeout_ms=30)
                self.assertLess(time.monotonic() - started, 1)
                self.assertIs(self.host._process, process)
                self.assertEqual(self.host._generation, generation)
                self.assertIsNone(process.poll())
            finally:
                thread.join(timeout=2)
                if thread.is_alive():
                    self.host.close()
                    thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(outcomes[0]["status"], "ok")

    def test_request_byte_limit_is_checked_before_send(self):
        with patch.object(a11y_host, "MAX_REQUEST_BYTES", 20):
            self.assert_failed()

    def test_runtime_must_be_absolute_owned_directory(self):
        for runtime in ("relative", str(self.worker), "/does-not-exist-owned-fixture"):
            with self.subTest(runtime=runtime):
                with self.assertRaises(a11y_host.A11yHostError):
                    a11y_host.A11yHost(runtime)

    def test_unreaped_child_is_quarantined_and_not_replaced(self):
        process = Mock(pid=99999999)
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("private-content", 0.1)
        self.host._process = process
        with patch.object(a11y_host.os, "killpg"), patch.object(a11y_host.subprocess, "Popen") as spawn:
            with self.assertRaises(a11y_host.A11yHostError): self.host.close()
            self.assertIs(self.host._process, process)
            with self.assertRaises(a11y_host.A11yHostError): self.host.observe(os.getpid(), "owned")
            spawn.assert_not_called()
            process.poll.return_value = 0
            process.wait.side_effect = None
            self.host.close()
        self.assertIsNone(self.host._process)

    def test_parent_death_kills_owned_fixture_worker(self):
        driver = Path(self.directory.name) / "parent.py"
        root = str(Path(__file__).resolve().parents[1])
        driver.write_text(
            "import sys,time,os\nfrom pathlib import Path\nsys.path.insert(0," + repr(root) + ")\n"
            "from src.native import a11y_host\na11y_host.WORKER_PATH=Path(" + repr(str(self.worker)) + ")\n"
            "host=a11y_host.A11yHost(" + repr(self.directory.name) + ")\n"
            "host.observe(os.getpid(),'owned')\nprint(host._process.pid,flush=True)\ntime.sleep(60)\n")
        parent = subprocess.Popen(["/usr/bin/python3", "-I", str(driver)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        child_fd = None
        try:
            import select
            self.assertTrue(select.select([parent.stdout], [], [], 3)[0])
            child_pid = int(parent.stdout.readline())
            # The live parent retains this child; pin it before killing the parent.
            # pidfd readiness proves original-root exit without racy /proc text reads.
            child_fd = os.pidfd_open(child_pid)
            self.assertFalse(select.select([child_fd], [], [], 0)[0], "Owned helper exited before parent death")
            parent.kill(); parent.wait(timeout=1)
            self.assertTrue(select.select([child_fd], [], [], 2)[0], "Owned fixture helper survived parent death")
        finally:
            if parent.poll() is None: parent.kill()
            parent.wait(timeout=1)
            parent.stdout.close()
            if child_fd is not None:
                try:
                    try: signal.pidfd_send_signal(child_fd, signal.SIGKILL)
                    except ProcessLookupError: pass
                finally:
                    os.close(child_fd)


if __name__ == "__main__":
    unittest.main()
