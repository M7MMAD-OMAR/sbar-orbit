"""Component refusal checks; these mocks do not measure compositor loading."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.native import plugin_owner
from src.native.plugin_bundle import fingerprint


class OwnerPluginTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="orbit-owner-plugin-")
        self.directory = Path(self.work.name)
        binary = self.directory / "plugin.so"
        binary.write_bytes(b"component fixture, not a loadable plugin")
        binary.chmod(0o600)
        self.plan = {"schema": 1, "compositor": [123, 456], "abi_hash": "fixture-abi", "commit": "c" * 40, "version": "fixture",
                     "runtime": str(self.directory / "runtime"), "signature": "fixture"}
        (self.directory / "runtime/hypr/fixture").mkdir(parents=True, mode=0o700)
        self.artifact = {"schema": 1, "file": "plugin.so", "path": str(binary), "bytes": binary.stat().st_size,
                         "file_identity": [str(value) for value in fingerprint(binary.stat())],
                         "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "source_sha256": "a" * 64,
                         "build_identity": {key: self.plan[key] for key in ("abi_hash", "commit", "version")}}
        self.write("host.json", self.plan)
        self.write("preparation.json", {"schema": 1, "prepared": True, "plan": str(self.directory / "host.json"), "plugin": self.artifact})
        self.loaded = False
        self.calls = []
        self.build = {"schema": 1, "source_sha256": "a" * 64, "abi_hash": "fixture-abi", "live_roots": 0}
        self.host = patch.object(plugin_owner, "verify_host", return_value=self.plan)
        self.host.start()
        self.transport_host = patch("src.native.transport.verify_host", return_value=self.plan)
        self.transport_host.start()
        self.transport = patch.object(plugin_owner.NativeTransport, "_exchange", side_effect=self.exchange)
        self.transport.start()
        self.mapping = patch.object(plugin_owner, "mapped_identity")
        self.mapping.start()

    def tearDown(self):
        self.mapping.stop()
        self.transport.stop()
        self.host.stop()
        self.transport_host.stop()
        self.work.cleanup()

    def write(self, name, value):
        path = self.directory / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def exchange(self, request):
        self.calls.append(request)
        if request == "j/plugin list":
            return json.dumps([{"name": "ghostinput"}] if self.loaded else [])
        if request == "ghost-build-info":
            return json.dumps(self.build)
        if request == "plugin load " + self.artifact["path"]:
            self.loaded = True
            return "ok"
        raise AssertionError(request)

    def run_operation(self, operation):
        return plugin_owner.operate(operation, self.directory)

    def test_status_creates_no_files(self):
        before = sorted(self.directory.iterdir())
        self.assertFalse(self.run_operation("status")["loaded"])
        self.assertEqual(before, sorted(self.directory.iterdir()))

    def test_load_is_journaled_and_idempotent(self):
        self.assertTrue(self.run_operation("load")["load_sent"])
        self.assertFalse(self.run_operation("load")["load_sent"])
        events = [json.loads(line) for line in (self.directory / "plugin-owner.jsonl").read_text().splitlines()]
        self.assertEqual([event["phase"] for event in events], ["begin", "finish", "begin", "finish"])
        self.assertEqual(sum(request.startswith("plugin load ") for request in self.calls), 1)
        self.assertEqual([event["outcome"] for event in events if event["phase"] == "finish"], ["success", "success"])

    def test_changed_artifact_refuses_before_load(self):
        (self.directory / "plugin.so").write_bytes(b"changed")
        with self.assertRaises(RuntimeError):
            self.run_operation("load")
        self.assertEqual(self.calls, [])

    def test_wrong_loaded_stamp_requires_owner_review(self):
        self.build["source_sha256"] = "b" * 64
        with self.assertRaisesRegex(RuntimeError, "Load was sent"):
            self.run_operation("load")
        self.assertTrue(self.loaded)
        event = json.loads((self.directory / "plugin-owner.jsonl").read_text().splitlines()[-1])
        self.assertEqual(event["outcome"], "error")
        self.assertTrue(event["load_sent"])
        self.assertTrue(event["requires_owner_review"])
        self.assertFalse(any("unload" in request for request in self.calls))

    def test_journal_sync_refusal_prevents_load(self):
        with patch.object(plugin_owner.os, "fsync", side_effect=OSError("simulated storage refusal")):
            with self.assertRaises(OSError):
                self.run_operation("load")
        self.assertEqual(self.calls, [])

    def test_linked_journal_refuses_before_load(self):
        (self.directory / "plugin-owner.jsonl").symlink_to(self.directory / "host.json")
        with self.assertRaises(OSError):
            self.run_operation("load")
        self.assertEqual(self.calls, [])

    def test_pending_journal_refuses_before_load(self):
        (self.directory / "plugin-owner.jsonl").write_text('{"id":"old","phase":"begin"}\n')
        (self.directory / "plugin-owner.jsonl").chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "Unfinished"):
            self.run_operation("load")
        self.assertEqual(self.calls, [])

    def test_wrong_kernel_binding_cannot_pass_loaded_status(self):
        self.loaded = True
        with patch.object(plugin_owner, "mapped_identity", side_effect=RuntimeError("wrong kernel identity")):
            with self.assertRaisesRegex(RuntimeError, "wrong kernel identity"):
                self.run_operation("status")

    def test_stale_host_refuses_before_load(self):
        with patch.object(plugin_owner, "verify_host", side_effect=RuntimeError("stale host")):
            with self.assertRaisesRegex(RuntimeError, "stale host"):
                self.run_operation("load")
        self.assertEqual(self.calls, [])

    def test_distinct_preparations_share_the_compositor_lock(self):
        other = self.directory / "second"
        other.mkdir(mode=0o700)
        binary = other / "plugin.so"
        binary.write_bytes((self.directory / "plugin.so").read_bytes())
        binary.chmod(0o600)
        artifact = self.artifact | {"path": str(binary), "file_identity": [str(value) for value in fingerprint(binary.stat())]}
        for name, value in (("host.json", self.plan), ("preparation.json", {"schema": 1, "prepared": True,
                            "plan": str(other / "host.json"), "plugin": artifact})):
            path = other / name
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        bundle = plugin_owner.PreparedPlugin(self.directory)
        journal = plugin_owner.OwnerJournal(bundle)
        def other_preparation_exchange(request):
            if request == "plugin load " + artifact["path"]:
                self.calls.append(request)
                self.loaded = True
                return "ok"
            return self.exchange(request)
        try:
            with patch.object(plugin_owner.NativeTransport, "_exchange", side_effect=other_preparation_exchange):
                with self.assertRaises(BlockingIOError):
                    plugin_owner.operate("load", other)
            self.assertEqual(self.calls, [])
        finally:
            journal.close()
            bundle.close()

    def test_acknowledgement_and_retention_failure_preserve_uncertainty(self):
        original = plugin_owner.OwnerJournal.append
        def failing_finish(journal, event):
            if event["phase"] == "finish":
                raise OSError("simulated outcome storage refusal")
            return original(journal, event)
        def missing_acknowledgement(request):
            reply = self.exchange(request)
            return "lost acknowledgement" if request.startswith("plugin load ") else reply
        with patch.object(plugin_owner.OwnerJournal, "append", failing_finish), patch.object(
                plugin_owner.NativeTransport, "_exchange", side_effect=missing_acknowledgement):
            with self.assertRaises(BaseException) as caught:
                self.run_operation("load")
        self.assertIn("Load was sent", str(caught.exception))
        self.assertIn("not acknowledged", str(caught.exception))
        self.assertIn("simulated outcome storage refusal", str(caught.exception))
        self.assertTrue(caught.exception.load_sent)

    def test_journal_close_failure_preserves_primary_and_closes_bundle(self):
        self.build["source_sha256"] = "b" * 64
        close_journal = plugin_owner.OwnerJournal.close
        close_bundle = plugin_owner.PreparedPlugin.close
        closed = []
        def failing_close(journal):
            close_journal(journal)
            raise OSError("simulated journal close refusal")
        def tracked_close(bundle):
            closed.append(bundle.fd)
            close_bundle(bundle)
        with patch.object(plugin_owner.OwnerJournal, "close", failing_close), patch.object(
                plugin_owner.PreparedPlugin, "close", tracked_close):
            with self.assertRaises(plugin_owner.OwnerLoadError) as caught:
                self.run_operation("load")
        self.assertTrue(caught.exception.load_sent)
        self.assertIn("build differs", str(caught.exception))
        self.assertIn("journal close refusal", str(caught.exception))
        self.assertEqual(len(closed), 1)

    def test_all_journal_descriptors_close_after_one_failure(self):
        bundle = plugin_owner.PreparedPlugin(self.directory)
        journal = plugin_owner.OwnerJournal(bundle)
        descriptors = list(journal.descriptors)
        close = os.close
        attempted = []
        def fail_one(fd):
            attempted.append(fd)
            close(fd)
            if fd == descriptors[-1]:
                raise OSError("simulated descriptor close refusal")
        try:
            with patch.object(plugin_owner.os, "close", fail_one):
                with self.assertRaises(ExceptionGroup):
                    journal.close()
            self.assertEqual(set(attempted), set(descriptors))
            self.assertEqual(journal.descriptors, [])
        finally:
            bundle.close()


if __name__ == "__main__":
    unittest.main()
