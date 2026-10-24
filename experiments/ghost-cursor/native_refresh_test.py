#!/usr/bin/python3
"""Renewing the compositor binding keeps the owner's control directory, with no desktop access."""
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native import prepare as prepare_module
from src.native import refresh as runtime
from src.native.control import ActionControl


def elf():
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", header, 16, 3, 62, 1)
    return bytes(header) + b"plugin body"


class RefreshTests(unittest.TestCase):
    def setUp(self):
        private = Path(__file__).resolve().parents[2] / ".private"
        private.mkdir(mode=0o700, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="refresh-test-", dir=private)
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name).resolve()
        self.root = base / "native"
        self.inputs = base / "inputs"
        self.inputs.mkdir(mode=0o700)
        binary, source = self.inputs / "plugin.so", self.inputs / "plugin.cpp"
        binary.write_bytes(elf())
        source.write_text("source")
        os.chmod(binary, 0o600)
        os.chmod(source, 0o600)
        self.live = {"schema": 1, "runtime": "/run/user/1", "signature": "first", "display": "wayland-1",
                     "compositor": [10, 20], "ipc_socket": [1, 2], "wayland_socket": [3, 4],
                     "abi_hash": "abi", "commit": "a" * 40, "version": "1"}
        self.manifest = {"schema": 1, "binary": str(binary), "source": str(source),
                         "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                         "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                         "abi_hash": "abi", "commit": "a" * 40, "version": "1"}
        self.manifest_path = self.inputs / "manifest.json"
        self.manifest_path.write_text(json.dumps(self.manifest))
        os.chmod(self.manifest_path, 0o600)
        self.loaded = []
        self.addCleanup(patch.stopall)
        patch.object(runtime, "require_budget").start()
        patch.object(runtime, "inspect_host", side_effect=lambda _: dict(self.live)).start()
        patch.object(prepare_module, "require_budget").start()
        patch.object(prepare_module, "inspect_host", side_effect=lambda _: dict(self.live)).start()
        patch.object(prepare_module, "verify_host", return_value=True).start()
        patch.object(runtime, "operate", side_effect=self.operate).start()

    def operate(self, operation, directory):
        if operation == "load":
            self.loaded.append(directory)
        return {"loaded": directory in self.loaded}

    def renew(self, manifest=None):
        return runtime.refresh(self.root, {}, manifest)

    def test_first_refresh_needs_a_recorded_build(self):
        with self.assertRaisesRegex(ValueError, "plugin-manifest"):
            self.renew()
        self.assertFalse((self.root / "current").exists())

    def test_if_configured_is_silent_before_setup(self):
        self.assertEqual(runtime.refresh(self.root, {}, None, True), {"refreshed": False, "configured": False})
        self.assertFalse((self.root / "current").exists())

    def test_refresh_after_restart_keeps_the_owner_mode(self):
        first = self.renew(self.manifest_path)
        self.assertTrue(first["refreshed"])
        with ActionControl(self.root / "control") as control:
            control.configure(mode="full")
        self.live.update(signature="second", compositor=[11, 21])
        second = self.renew()
        self.assertTrue(second["refreshed"])
        self.assertNotEqual(first["preparation"], second["preparation"])
        self.assertEqual(Path(os.path.realpath(self.root / "current")), Path(second["preparation"]))
        self.assertEqual(json.loads((Path(second["preparation"]) / "host.json").read_text())["signature"], "second")
        with ActionControl(self.root / "control") as control:
            self.assertEqual(control.inspect()["settings"]["mode"], "full")
        environment = (self.root / "broker-native.env").read_text()
        self.assertIn(str(self.root / "current" / "host.json"), environment)
        self.assertIn(str(self.root / "control"), environment)
        self.assertEqual(self.loaded, [first["preparation"], second["preparation"]])

    def test_current_plan_is_left_alone(self):
        first = self.renew(self.manifest_path)
        again = self.renew()
        self.assertEqual(again["refreshed"], False)
        self.assertEqual(again["preparation"], first["preparation"])
        self.assertEqual(len(self.loaded), 1)

    def test_changed_compositor_abi_demands_a_rebuild(self):
        self.renew(self.manifest_path)
        self.live.update(signature="second", abi_hash="newer")
        with self.assertRaisesRegex(ValueError, "rebuild the native plugin"):
            self.renew()
        self.assertEqual(len(self.loaded), 1)

    def test_old_preparations_are_pruned_but_the_build_survives(self):
        for index in range(4):
            self.live.update(signature="s%d" % index, compositor=[30 + index, 40])
            self.renew(self.manifest_path if index == 0 else None)
        self.assertEqual(len(list(self.root.glob("prep-*"))), runtime.KEPT)
        self.assertTrue((self.root / "plugin-build" / "plugin.so").is_file())
        self.assertTrue((self.root / "current" / "host.json").is_file())


if __name__ == "__main__":
    unittest.main()
