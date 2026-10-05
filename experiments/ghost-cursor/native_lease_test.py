#!/usr/bin/python3
"""Synthetic identity edge cases; live units are checked in the lab probe."""
from pathlib import Path
import sys
import os
import subprocess
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.lease import LeaseError, NativeLease, unit_properties
from src.native.session import NativeSession
from native_lease_probe import cleanup_units


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.unit = "orbit-native-" + "a" * 32 + ".service"
        self.group = "/budget/sbarorbit.slice/" + self.unit
        self.properties = {"InvocationID": "b" * 32, "ControlGroup": self.group, "ActiveState": "active"}
        self.directory = Path("/sys/fs/cgroup") / self.group.removeprefix("/")
        self.patches = [patch("src.native.lease.unit_properties", return_value=self.properties),
                        patch("src.native.lease.budget_path", return_value="/budget/sbarorbit.slice"),
                        patch("src.native.lease.cgroup_directory", return_value=(self.directory, (1, 2)))]
        self.mocks = [item.start() for item in self.patches]
        for item in self.patches:
            self.addCleanup(item.stop)
        self.lease = NativeLease(self.unit)

    def test_changed_invocation_and_directory_fail(self):
        self.mocks[0].return_value = {**self.properties, "InvocationID": "c" * 32}
        with self.assertRaisesRegex(LeaseError, "invocation changed"):
            self.lease.verify()
        self.mocks[0].return_value = self.properties
        self.mocks[2].return_value = (self.directory, (1, 3))
        with self.assertRaisesRegex(LeaseError, "directory changed"):
            self.lease.verify()

    def test_shared_slice_and_sibling_units_cannot_be_adopted(self):
        for group in ("/budget/sbarorbit.slice", self.group + "/nested", self.group + "-other"):
            self.mocks[0].return_value = {**self.properties, "ControlGroup": group}
            with self.assertRaisesRegex(LeaseError, "exact shared-budget child"):
                NativeLease(self.unit)

    def test_membership_requires_exact_process_and_path_boundary(self):
        with patch("src.native.lease.process_identity", return_value=(123, 456)), patch.object(Path, "read_text") as read:
            read.return_value = "0::" + self.group + "\n"
            self.assertTrue(self.lease.contains((123, 456)))
            self.assertFalse(self.lease.contains((123, 455)))
            read.return_value = "0::" + self.group + "/subgroup\n"
            self.assertTrue(self.lease.contains((123, 456)))
            read.return_value = "0::" + self.group + "-sibling\n"
            self.assertFalse(self.lease.contains((123, 456)))

    def test_malformed_process_identities_fail(self):
        for process in (None, 123, (True, 1), (1, 0), [1, 2], (1, 2, 3)):
            self.assertFalse(self.lease.contains(process))

    def test_restart_during_membership_check_fails(self):
        self.mocks[0].side_effect = [self.properties, {**self.properties, "InvocationID": "c" * 32}]
        with self.assertRaises(LeaseError):
            self.lease.contains(None)

    def test_same_unit_caller_is_a_legitimate_member(self):
        process = (os.getpid(), 123)
        with patch("src.native.lease.process_identity", return_value=process), patch.object(Path, "read_text", return_value="0::" + self.group + "\n"):
            self.assertTrue(self.lease.contains(process))

    def test_cleanup_attempts_remaining_units_after_stop_failure(self):
        failure = subprocess.CalledProcessError(1, ["systemctl"])
        with patch("native_lease_probe.manager_environment", return_value={}), patch("native_lease_probe.subprocess.run", side_effect=[failure, None]) as run:
            self.assertEqual(cleanup_units(["first", "second"]), [failure])
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args_list[0].args[0][-1], "second")
            self.assertEqual(run.call_args_list[1].args[0][-1], "first")

    def test_invalid_unit_names_fail_before_manager_connection(self):
        self.patches[0].stop()
        with patch("src.native.lease.manager_environment", side_effect=AssertionError("must not connect")):
            for unit in ("sbarorbit.slice", "other.service", "../other.service", None):
                with self.assertRaises(LeaseError):
                    unit_properties(unit)

    def owned_window_query(self, target_check=None):
        app_id = "d" * 32
        session = object.__new__(NativeSession)
        session.apps = {app_id: SimpleNamespace(lease=self.lease, unit=self.unit, closed=False)}
        session.windows = {}
        client = {"pid": 123, "workspace": {"name": "special:ghost"},
                  "address": "0x123", "stableId": "a", "size": [800, 600]}
        def exchange(command):
            if command == "j/clients":
                return json.dumps([client])
            if target_check:
                target_check()
            return "ok"
        session.transport = SimpleNamespace(_exchange=exchange)
        with patch("src.native.lease.process_identity", return_value=(123, 456)), \
                patch("src.native.session.process_identity", return_value=(123, 456)), \
                patch.object(Path, "iterdir", return_value=[]), \
                patch.object(Path, "read_text", autospec=True,
                             side_effect=lambda path: "123\n" if path.name == "cgroup.procs" else "0::" + self.group + "\n"):
            return session._owned_windows(app_id)

    def test_owned_window_query_uses_one_fresh_membership_observation(self):
        self.mocks[0].reset_mock()
        windows = self.owned_window_query()
        self.assertEqual(len(windows), 1)
        self.assertEqual(self.mocks[0].call_count, 2,
                         "One window query needs fresh manager reads before and after its whole observation")

    def test_owned_window_query_refuses_restart_during_target_check(self):
        def restart():
            self.mocks[0].return_value = {**self.properties, "InvocationID": "c" * 32}
        with self.assertRaisesRegex(LeaseError, "invocation changed"):
            self.owned_window_query(restart)

    def test_owned_window_query_preserves_operation_and_revalidation_errors(self):
        def fail_and_restart():
            self.mocks[0].return_value = {**self.properties, "InvocationID": "c" * 32}
            raise RuntimeError("target query failed")
        with self.assertRaises(BaseExceptionGroup) as caught:
            self.owned_window_query(fail_and_restart)
        self.assertEqual([str(error) for error in caught.exception.exceptions],
                         ["target query failed", "Native unit invocation changed"])


if __name__ == "__main__":
    unittest.main()
