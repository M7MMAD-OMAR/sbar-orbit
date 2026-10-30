#!/usr/bin/python3
"""The readiness check names every disagreement between compositor, plan, plugin build and loaded plugin."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.native import diagnose
from src.native.host import inspect_host
from src.native.plugin_compatibility import PLUGIN_SOURCE


class FakeCompositor:
    """One process serving a Hyprland IPC socket and a Wayland socket, like the real compositor."""
    def __init__(self, runtime, signature, display, version):
        self.version, self.stop, self.threads, self.listeners = version, threading.Event(), [], []
        (runtime / "hypr" / signature).mkdir(parents=True, mode=0o700)
        for index, path in enumerate((runtime / display, runtime / "hypr" / signature / ".socket.sock")):
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(path))
            listener.listen()
            listener.settimeout(0.1)
            self.listeners.append(listener)
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
                try:
                    request = conn.recv(1024)
                    if index and request:
                        conn.sendall(json.dumps(self.version).encode())
                except OSError:
                    pass

    def close(self):
        self.stop.set()
        for listener in self.listeners:
            listener.close()
        for thread in self.threads:
            thread.join(2)


def version(tag, commit):
    return {"abiHash": commit + "_" + tag, "commit": commit, "version": tag}


class DiagnoseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-diagnose-")
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / "run"
        self.runtime.mkdir(mode=0o700)
        self.root = Path(self.temp.name) / "state"
        self.root.mkdir(mode=0o700)
        self.fakes = []
        self.addCleanup(lambda: [fake.close() for fake in self.fakes])
        self.empty = {"XDG_RUNTIME_DIR": str(self.runtime)}

    def compositor(self, signature="live", display="wayland-9", tag="0.57.0", commit="b" * 40):
        fake = FakeCompositor(self.runtime, signature, display, version(tag, commit))
        self.fakes.append(fake)
        return fake

    def prepare(self, tag, commit, env, source_current=True):
        """Write a plan the way native-prepare does, for whatever the fake compositor said at that time."""
        plan = inspect_host(env)
        preparation = self.root / "prep-1"
        preparation.mkdir(exist_ok=True)
        (preparation / "host.json").write_text(json.dumps(plan))
        link = self.root / "current"
        if not link.is_symlink():
            link.symlink_to(preparation.name)
        source = hashlib.sha256(PLUGIN_SOURCE.read_bytes()).hexdigest() if source_current else "0" * 64
        (self.root / "plugin-build.json").write_text(json.dumps({
            "schema": 1, "source_sha256": source, "abi_hash": plan["abi_hash"], "commit": plan["commit"], "version": plan["version"]}))
        return plan

    def codes(self, report):
        return [item["code"] for item in report["problems"]]

    def run_diagnose(self, environ=None, installed="0.57.0", loaded=True):
        with patch.object(diagnose, "plugin_loaded", return_value=loaded):
            return diagnose.diagnose(self.root, environ or self.empty, installed=lambda: installed)

    def test_missing_service_environment_is_resolved_from_the_runtime_directory(self):
        self.compositor()
        report = self.run_diagnose()
        self.assertTrue(report["environment"]["resolved"])
        self.assertEqual(report["environment"]["source"], "runtime-scan")
        self.assertEqual(report["environment"]["values"]["WAYLAND_DISPLAY"], "wayland-9")
        self.assertEqual(report["environment"]["values"]["XDG_CURRENT_DESKTOP"], "Hyprland")
        self.assertIn("ENVIRONMENT_STALE", self.codes(report))
        self.assertFalse(next(item for item in report["problems"] if item["code"] == "ENVIRONMENT_STALE")["blocking"])

    def test_two_live_instances_are_refused_not_guessed(self):
        self.compositor("one", "wayland-8")
        self.compositor("two", "wayland-9")
        report = self.run_diagnose()
        self.assertIn("AMBIGUOUS_COMPOSITOR", self.codes(report))
        self.assertFalse(report["environment"]["resolved"])

    def test_no_compositor_says_so(self):
        report = self.run_diagnose()
        self.assertIn("NO_COMPOSITOR", self.codes(report))
        self.assertFalse(report["ready"])

    def test_everything_agreeing_is_ready(self):
        self.compositor()
        env = diagnose.resolve_environment(self.empty)["values"]
        self.prepare("0.57.0", "b" * 40, env)
        report = self.run_diagnose()
        self.assertTrue(report["ready"], report["problems"])
        self.assertEqual([item for item in report["problems"] if item["blocking"]], [])

    def test_upgraded_compositor_names_both_versions_and_the_rebuild(self):
        # Prepared and built for 0.56.2, then the compositor was restarted into 0.57.0.
        old = self.compositor("old", "wayland-8", "0.56.2", "a" * 40)
        env_old = diagnose.resolve_environment(self.empty)["values"]
        self.prepare("0.56.2", "a" * 40, env_old)
        old.close()
        self.fakes.remove(old)
        for path in list((self.runtime / "hypr" / "old").iterdir()) + [self.runtime / "wayland-8"]:
            path.unlink()
        (self.runtime / "hypr" / "old").rmdir()
        self.compositor()
        report = self.run_diagnose()
        codes = self.codes(report)
        self.assertIn("PLUGIN_ABI_MISMATCH", codes)
        self.assertIn("PLAN_STALE", codes)
        text = " ".join(item["message"] + " " + item["fix"] for item in report["problems"])
        self.assertIn("0.56.2", text)
        self.assertIn("0.57.0", text)
        self.assertIn("native-refresh --plugin-manifest", text)
        self.assertFalse(report["ready"])
        self.assertFalse(report["selfRepairable"])

    def test_restart_into_the_same_build_is_repairable_by_native_refresh(self):
        first = self.compositor("first", "wayland-8")
        self.prepare("0.57.0", "b" * 40, diagnose.resolve_environment(self.empty)["values"])
        first.close()
        self.fakes.remove(first)
        for path in list((self.runtime / "hypr" / "first").iterdir()) + [self.runtime / "wayland-8"]:
            path.unlink()
        (self.runtime / "hypr" / "first").rmdir()
        self.compositor("second", "wayland-9")
        report = self.run_diagnose()
        self.assertIn("PLAN_STALE", self.codes(report))
        self.assertNotIn("PLUGIN_ABI_MISMATCH", self.codes(report))
        self.assertTrue(report["selfRepairable"])

    def test_installed_package_newer_than_the_running_compositor(self):
        self.compositor()
        self.prepare("0.57.0", "b" * 40, diagnose.resolve_environment(self.empty)["values"])
        report = self.run_diagnose(installed="0.58.0")
        self.assertIn("COMPOSITOR_NOT_RESTARTED", self.codes(report))
        self.assertIn("Log out", next(item for item in report["problems"] if item["code"] == "COMPOSITOR_NOT_RESTARTED")["fix"])
        self.assertFalse(report["ready"])

    def test_plugin_not_loaded_is_a_named_problem(self):
        self.compositor()
        self.prepare("0.57.0", "b" * 40, diagnose.resolve_environment(self.empty)["values"])
        report = self.run_diagnose(loaded=False)
        self.assertIn("PLUGIN_NOT_LOADED", self.codes(report))
        self.assertFalse(report["ready"])

    def test_changed_plugin_source_is_a_named_problem(self):
        self.compositor()
        self.prepare("0.57.0", "b" * 40, diagnose.resolve_environment(self.empty)["values"], source_current=False)
        self.assertIn("PLUGIN_SOURCE_CHANGED", self.codes(self.run_diagnose()))

    def test_check_mode_prints_plain_sentences_and_fails(self):
        self.compositor()
        self.prepare("0.57.0", "b" * 40, diagnose.resolve_environment(self.empty)["values"])
        report = self.run_diagnose(loaded=False)
        lines = diagnose.explain(report)
        self.assertTrue(any(line.startswith("BLOCKING PLUGIN_NOT_LOADED") for line in lines))
        self.assertTrue(any(line.startswith("  Fix: ") for line in lines))


if __name__ == "__main__":
    unittest.main()
