import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.native import plugin_bundle, prepare as preparation

if len(sys.argv) > 2 and sys.argv[1] == "--prepare-module":
    sys.argv.pop(1)
    spec = importlib.util.spec_from_file_location("unfixed_prepare", sys.argv.pop(1))
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    candidate.__file__ = preparation.__file__
    preparation = candidate

if len(sys.argv) > 1 and sys.argv[1].endswith(".py"):
    spec = importlib.util.spec_from_file_location("unfixed_plugin_bundle", sys.argv.pop(1))
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    plugin_bundle = candidate


class PluginBundleTests(unittest.TestCase):
    def setUp(self):
        private = ROOT / ".private"
        private.mkdir(exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="plugin-bundle-test-", dir=private))
        self.destination = self.directory / "destination"
        self.destination.mkdir(mode=0o700)
        self.fd = os.open(self.destination, os.O_RDONLY | os.O_DIRECTORY)
        self.binary = self.directory / "build.so"
        header = bytearray(64)
        header[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HHI", header, 16, 3, 62, 1)
        self.binary.write_bytes(header + b"owned ELF header fixture, not loaded")
        self.source = self.directory / "source.cpp"
        self.source.write_text("int owned_fixture = 1;\n")
        self.manifest = self.directory / "build.json"
        self.plan = {"abi_hash": "owned-test-abi", "commit": "a" * 40, "version": "owned-test-version"}
        self.value = {"schema": 1, "binary": str(self.binary), "source": str(self.source), **self.plan,
                      "binary_sha256": hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                      "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest()}
        self.write_manifest()

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.value))
        self.manifest.chmod(0o600)

    def stage(self):
        return plugin_bundle.stage_plugin(self.fd, self.manifest, self.plan)

    def tearDown(self):
        os.close(self.fd)
        shutil.rmtree(self.directory)

    def test_copy_readback_is_pinned_and_private(self):
        report = self.stage()
        copied = self.destination / "plugin.so"
        self.assertEqual(copied.read_bytes(), self.binary.read_bytes())
        self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
        self.assertEqual(report["binary_sha256"], self.value["binary_sha256"])
        self.assertEqual(report["compositor_loader"], "not run")
        self.assertEqual(report["owner_activation"], "not performed")

    def test_changed_binary_refuses_before_copy(self):
        self.binary.write_bytes(self.binary.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "binary digest"):
            self.stage()
        self.assertFalse((self.destination / "plugin.so").exists())

    def prepare(self, verify):
        plan = self.plan | {"compositor": "owned fixture, never connected"}
        with patch.object(preparation, "require_budget"), patch.object(preparation, "inspect_host", return_value=plan), \
                patch.object(preparation, "verify_host", side_effect=verify):
            return preparation.prepare(self.destination, {}, self.manifest)

    def test_preparation_publishes_verified_artifact(self):
        report = self.prepare(lambda _: None)
        self.assertTrue(report["prepared"])
        self.assertEqual(report["mode"], "protected")
        self.assertEqual(json.loads((self.destination / "preparation.json").read_text()), report)
        plugin_bundle.verify_staged_plugin(self.fd, report["plugin"])

    def test_changed_artifact_during_host_check_prevents_publication(self):
        def change(_):
            (self.destination / "plugin.so").write_bytes(b"changed during host verification")
        with self.assertRaisesRegex(RuntimeError, "Staged plugin"):
            self.prepare(change)
        self.assertFalse((self.destination / "preparation.json").exists())
        self.assertTrue((self.destination / "plugin.so").exists())

    def test_identical_replacement_during_host_check_prevents_publication(self):
        def replace(_):
            replacement = self.directory / "replacement.so"
            replacement.write_bytes(self.binary.read_bytes())
            replacement.chmod(0o600)
            replacement.replace(self.destination / "plugin.so")
        with self.assertRaisesRegex(RuntimeError, "Staged plugin"):
            self.prepare(replace)
        self.assertFalse((self.destination / "preparation.json").exists())

    def test_source_pin_and_host_build_identity_refuse(self):
        self.source.write_text("int changed_source = 2;\n")
        with self.assertRaisesRegex(ValueError, "source digest"):
            self.stage()
        self.value["source_sha256"] = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.value["abi_hash"] = "different-abi"
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "build identity"):
            self.stage()
        self.assertFalse((self.destination / "plugin.so").exists())

    def test_shared_manifest_and_symlink_are_refused(self):
        self.manifest.chmod(0o644)
        with self.assertRaises(ValueError):
            self.stage()
        self.manifest.chmod(0o600)
        linked = self.directory / "linked.json"
        linked.symlink_to(self.manifest)
        with self.assertRaises(ValueError):
            plugin_bundle.stage_plugin(self.fd, linked, self.plan)
        self.assertFalse((self.destination / "plugin.so").exists())

    def test_existing_destination_preserves_other_file(self):
        preserved = self.directory / "simulated-other-file"
        preserved.write_bytes(b"unchanged owned fixture")
        (self.destination / "plugin.so").symlink_to(preserved)
        with self.assertRaises(FileExistsError):
            self.stage()
        self.assertEqual(preserved.read_bytes(), b"unchanged owned fixture")

    def test_input_path_swap_during_copy_is_refused(self):
        original_sync = os.fsync
        def swap(fd):
            original_sync(fd)
            replacement = self.directory / "replacement.so"
            replacement.write_bytes(self.binary.read_bytes())
            replacement.replace(self.binary)
        with patch.object(plugin_bundle.os, "fsync", swap):
            with self.assertRaisesRegex(RuntimeError, "input changed"):
                self.stage()
        self.assertTrue((self.destination / "plugin.so").is_file())

    def test_output_path_swap_is_refused(self):
        original_sync = os.fsync
        preserved = self.directory / "simulated-profile"
        preserved.write_bytes(b"untouched")
        def swap(fd):
            original_sync(fd)
            (self.destination / "plugin.so").unlink()
            (self.destination / "plugin.so").symlink_to(preserved)
        with patch.object(plugin_bundle.os, "fsync", swap):
            with self.assertRaisesRegex(RuntimeError, "Staged plugin path changed"):
                self.stage()
        self.assertEqual(preserved.read_bytes(), b"untouched")

    def test_duplicate_and_unknown_fields_are_refused(self):
        self.manifest.write_text('{"schema":1,' + json.dumps(self.value)[1:])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.stage()
        self.value["activate"] = True
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Unknown"):
            self.stage()

    def test_non_elf_file_is_refused_even_when_pinned(self):
        self.binary.write_bytes(b"not a shared object")
        self.value["binary_sha256"] = hashlib.sha256(self.binary.read_bytes()).hexdigest()
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "ELF64"):
            self.stage()
        self.assertFalse((self.destination / "plugin.so").exists())


if __name__ == "__main__":
    unittest.main()
