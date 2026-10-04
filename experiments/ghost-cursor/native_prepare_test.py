#!/usr/bin/python3
"""Preparation refusal and publication failure checks, no desktop access."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native import prepare as runtime


class PreparationTests(unittest.TestCase):
    def setUp(self):
        private = Path(__file__).resolve().parents[2] / ".private"
        private.mkdir(mode=0o700, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="prepare-test-", dir=private)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "bundle %u space"
        self.directory.mkdir(mode=0o700)
        self.plan = {"compositor": [1, 2], "abi_hash": "test-only"}
        self.addCleanup(patch.stopall)
        patch.object(runtime, "inspect_host", return_value=self.plan).start()
        patch.object(runtime, "verify_host", return_value=True).start()

    def test_shared_directory_refused_before_host(self):
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            runtime.prepare(self.directory, {})
        runtime.inspect_host.assert_not_called()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_nonempty_directory_preserved(self):
        marker = self.directory / "owner-file"
        marker.write_text("keep")
        with self.assertRaises(ValueError):
            runtime.prepare(self.directory, {})
        self.assertEqual(marker.read_text(), "keep")
        runtime.inspect_host.assert_not_called()

    def test_symlink_refused(self):
        alias = self.directory.with_name("alias")
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            runtime.prepare(alias, {})
        runtime.inspect_host.assert_not_called()

    def test_percent_escaped_only_in_unit_directive(self):
        result = runtime.prepare(self.directory, {})
        self.assertTrue(result["prepared"])
        self.assertEqual(result["mode"], "protected")
        self.assertIn("%%u", (self.directory / "service-drop-in.conf").read_text())
        self.assertIn("%u", (self.directory / "broker-native.env").read_text())
        self.assertNotIn("%%u", (self.directory / "broker-native.env").read_text())
        self.assertEqual((self.directory / "host.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.directory / "control").stat().st_mode & 0o777, 0o700)

    def test_failed_manifest_file_sync_cannot_publish_success(self):
        original = os.fsync

        def fail(fd):
            name = os.readlink(f"/proc/self/fd/{fd}")
            if name.endswith("preparation.pending.json") or name.endswith("preparation.json"):
                raise OSError("Injected manifest file sync failure")
            return original(fd)

        with patch.object(runtime.os, "fsync", side_effect=fail), self.assertRaises(OSError):
            runtime.prepare(self.directory, {})
        self.assertFalse((self.directory / "preparation.json").exists())

    def test_failed_final_directory_sync_removes_success(self):
        original = os.fsync
        identity = self.directory.stat()

        def fail(fd):
            current = os.fstat(fd)
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                raise OSError("Injected bundle directory sync failure")
            return original(fd)

        with patch.object(runtime.os, "fsync", side_effect=fail), self.assertRaises(OSError):
            runtime.prepare(self.directory, {})
        self.assertFalse((self.directory / "preparation.json").exists())
        self.assertTrue((self.directory / "host.json").exists())


if __name__ == "__main__":
    unittest.main()
