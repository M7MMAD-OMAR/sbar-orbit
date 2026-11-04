"""Deterministic fake-kernel fixtures, not actual cgroup or OS drain qualification."""
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_scope as subject


class FakeChild(subprocess.Popen):
    """Retained Popen identity without launching, waiting for or signaling any process."""
    def __init__(self, pid):
        self.pid = pid
        self.returncode = None
        self._child_created = False
        self.stdout = io.BytesIO()
        self.stderr = io.BytesIO()


class ReaderScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-reader-scope-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "delegated"
        self.root.mkdir(mode=0o700)
        self.private = self.base / "private"
        self.private.mkdir(mode=0o700)
        self.journal = self.private / "debt.jsonl"
        self.initialized = False
        (self.root / "cgroup.events").write_text("populated 0\nfrozen 0\n")
        self.parent_controls = ("cgroup.kill", "cgroup.procs", "memory.max", "memory.swap.max", "pids.max", "cpu.max", "cgroup.subtree_control")
        for name in self.parent_controls:
            (self.root / name).write_text("shared-parent-untouched\n")
        self.owner_pid = os.getpid()
        self.processes = {self.owner_pid: {"pid": self.owner_pid, "start": 100, "parent": 1, "state": "R"}}
        self.calls = []
        self.synced_phases = []
        self.scopes = []
        self.leaf = None
        self.kill_error = False
        self.bad_readback = False
        self.real_mkdir, self.real_rmdir = os.mkdir, os.rmdir
        self.real_write, self.real_read, self.real_fsync = os.write, os.read, os.fsync
        self.patch(subject, "_cgroup2", lambda fd: None)
        self.patch(subject, "_proc_identity", self.identity)
        self.patch(subject, "_boot_id", lambda: "00000000-0000-0000-0000-000000000001")
        self.patch(os, "mkdir", self.mkdir)
        self.patch(os, "rmdir", self.rmdir)
        self.patch(os, "write", self.write)
        self.patch(os, "read", self.read)
        self.patch(os, "fsync", self.fsync)
        self.no_kill = self.patch(os, "kill", side_effect=AssertionError("No fixture PID signals"))
        self.no_killpg = self.patch(os, "killpg", side_effect=AssertionError("No fixture group signals"))
        self.no_spawn = self.patch(subprocess.Popen, "__init__", side_effect=AssertionError("No fixture subprocesses"))
        self.addCleanup(self.close_scopes)

    def patch(self, target, name, value=None, **kwargs):
        operation = patch.object(target, name, value, **kwargs) if value is not None else patch.object(target, name, **kwargs)
        result = operation.start()
        self.addCleanup(operation.stop)
        return result

    def identity(self, pid):
        value = self.processes.get(pid)
        return dict(value) if value is not None else None

    def fdpath(self, fd):
        return Path(os.readlink("/proc/self/fd/" + str(fd)))

    def records(self):
        if not self.journal.exists():
            return []
        return [json.loads(line) for line in self.journal.read_text().splitlines()]

    def mkdir(self, path, mode=0o777, *, dir_fd=None):
        if dir_fd is None or not str(path).startswith("orbit-reader-"):
            return self.real_mkdir(path, mode, dir_fd=dir_fd)
        parent = self.fdpath(dir_fd)
        self.assertEqual(parent, self.root)
        self.assertEqual(self.records()[-1]["phase"], "intent")
        self.assertEqual(self.synced_phases[-1], "intent")
        self.calls.append(("mkdir", str(path)))
        self.real_mkdir(path, mode, dir_fd=dir_fd)
        self.leaf = parent / path
        for name, content in {"cgroup.type": "domain\n", "cgroup.events": "populated 0\nfrozen 0\n", "cgroup.procs": "",
                              "cgroup.kill": "", "memory.max": "max\n", "memory.swap.max": "max\n",
                              "pids.max": "max\n", "cpu.max": "max 100000\n"}.items():
            (self.leaf / name).write_text(content)

    def rmdir(self, path, *, dir_fd=None):
        target = self.fdpath(dir_fd) / path if dir_fd is not None else Path(path)
        if target.name.startswith("orbit-reader-"):
            self.calls.append(("rmdir", str(target)))
            for entry in target.iterdir():
                entry.unlink()
        return self.real_rmdir(path, dir_fd=dir_fd)

    def write(self, fd, data):
        target = self.fdpath(fd)
        self.assertTrue(target.is_relative_to(self.base), "No fixture write outside owned temp root")
        self.calls.append(("write", str(target)))
        if target.parent.name.startswith("orbit-reader-"):
            if target.name == "cgroup.kill" and self.kill_error:
                raise OSError("owned fixture kill denied")
            if target.name == "cgroup.procs":
                record = self.records()[-1]
                self.assertEqual(record["phase"], "admitting")
                self.assertEqual(self.synced_phases[-1], "admitting")
                self.assertIn("pinned", self.synced_phases)
                self.assertIsNotNone(record["leaf_identity"])
                self.assertEqual(record["process"][0], int(data))
                (target.parent / "cgroup.events").write_text("populated 1\nfrozen 0\n")
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
        return self.real_write(fd, data)

    def read(self, fd, size):
        target = self.fdpath(fd)
        self.calls.append(("read", str(target)))
        if self.bad_readback and target.name == "memory.max":
            return b"max\n"
        return self.real_read(fd, size)

    def fsync(self, fd):
        target = self.fdpath(fd)
        self.calls.append(("fsync", str(target)))
        if target == self.journal:
            records = self.records()
            if records:
                self.synced_phases.append(records[-1]["phase"])
        return self.real_fsync(fd)

    def scope(self, **kwargs):
        # Only the fixture's first successful open explicitly initializes its fresh domain.
        # A later missing file never implicitly opts back into initialization.
        kwargs.setdefault("initialize", not self.initialized)
        result = subject.ReaderScope(self.root, self.journal, **kwargs)
        self.initialized = True
        self.scopes.append(result)
        return result

    def close_scopes(self):
        for scope in reversed(self.scopes):
            scope.close()
        self.no_kill.assert_not_called()
        self.no_killpg.assert_not_called()
        self.no_spawn.assert_not_called()
        for name in self.parent_controls:
            self.assertEqual((self.root / name).read_text(), "shared-parent-untouched\n")

    def prepared(self):
        scope = self.scope()
        scope.prepare()
        return scope

    def admitted(self):
        scope = self.prepared()
        child = FakeChild(424242)
        self.processes[child.pid] = {"pid": child.pid, "start": 200, "parent": self.owner_pid, "state": "T"}
        scope.admit(child)
        return scope, child

    def populated(self, value):
        (self.leaf / "cgroup.events").write_text("populated " + str(value) + "\nfrozen 0\n")

    def reaped(self, child):
        child.returncode = 0
        self.processes.pop(child.pid, None)

    def assert_code(self, code, operation):
        with self.assertRaises(subject.ReaderScopeError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def restart(self, scope):
        scope.close()
        self.processes[self.owner_pid]["start"] += 1
        return self.scope()

    def test_limits_defaults_are_frozen_and_separate_from_logical_buffer_budget(self):
        limits = subject.ReaderLimits()
        self.assertEqual((limits.memory_bytes, limits.pids, limits.cpu_quota, limits.cpu_period), (256 * 1024 * 1024, 32, 100000, 100000))
        with self.assertRaises(FrozenInstanceError):
            limits.pids = 100
        self.assertEqual(subject.ReaderLimits(memory_bytes=1, pids=1, cpu_quota=1).cpu_period, 100000)

    def test_limits_reject_invalid_and_wider_values(self):
        for field, maximum in (("memory_bytes", 256 * 1024 * 1024), ("pids", 32), ("cpu_quota", 100000)):
            for value in (0, -1, True, 1.5, "1", maximum + 1):
                with self.subTest(field=field, value=value):
                    self.assert_code("INVALID", lambda: subject.ReaderLimits(**{field: value}))
        for period in (0, 50000, 200000, True):
            self.assert_code("INVALID", lambda: subject.ReaderLimits(cpu_period=period))

    def test_constructor_creates_only_private_idle_journal_no_leaf_or_worker(self):
        scope = self.scope()
        self.assertEqual(scope.status()["phase"], "idle")
        self.assertFalse(scope.status()["hasDebt"])
        self.assertIsNone(self.leaf)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.records()[-1]["phase"], "idle")

    def test_non_cgroup_filesystem_fails_closed(self):
        with patch.object(subject, "_cgroup2", side_effect=subject.ReaderScopeError("UNSUPPORTED", "fixture non-cgroup")):
            self.assert_code("UNSUPPORTED", self.scope)
        self.assertFalse(self.journal.exists())

    def test_symlink_root_or_journal_is_never_followed(self):
        link = self.base / "linked-root"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((subject.ReaderScopeError, OSError)):
            subject.ReaderScope(link, self.journal)
        original = self.private / "original"
        original.write_text("do-not-touch")
        self.journal.symlink_to(original)
        with self.assertRaises((subject.ReaderScopeError, OSError)):
            self.scope()
        self.assertEqual(original.read_text(), "do-not-touch")

    def test_wrong_uid_or_nonprivate_journal_parent_refused(self):
        with patch.object(os, "getuid", return_value=os.getuid() + 1):
            self.assert_code("INVALID", self.scope)
        self.private.chmod(0o755)
        self.assert_code("INVALID", self.scope)

    def test_second_live_guard_is_busy_and_cannot_truncate_journal(self):
        self.scope()
        before = self.journal.read_bytes()
        self.assert_code("BUSY", self.scope)
        self.assertEqual(self.journal.read_bytes(), before)

    def test_prepare_orders_durable_intent_pin_limits_readback_before_admission(self):
        scope = self.prepared()
        self.assertEqual(scope.status()["phase"], "prepared")
        self.assertEqual([record["phase"] for record in self.records()], ["idle", "intent", "pinned", "prepared"])
        expected_limits = {"memory_bytes": 268435456, "pids": 32, "cpu_quota": 100000, "cpu_period": 100000, "swap_bytes": 0}
        self.assertTrue(all(record["limits"] == expected_limits for record in self.records()))
        for name, expected in (("memory.max", "268435456"), ("memory.swap.max", "0"), ("pids.max", "32"), ("cpu.max", "100000 100000")):
            self.assertEqual((self.leaf / name).read_text().strip(), expected)
            write = self.calls.index(("write", str(self.leaf / name)))
            read = self.calls.index(("read", str(self.leaf / name)))
            self.assertLess(write, read)
        self.assertFalse(any(name == str(self.leaf / "cgroup.procs") for kind, name in self.calls if kind == "write"))

    def test_limit_readback_failure_preserves_debt_and_forbids_admission(self):
        scope = self.scope()
        self.bad_readback = True
        self.assert_code("UNSUPPORTED", scope.prepare)
        self.assertTrue(scope.status()["hasDebt"])
        self.assert_code("DEBT", lambda: scope.admit(FakeChild(424242)))
        self.assert_code("DEBT", scope.prepare)

    def test_admit_requires_retained_stopped_direct_child_not_raw_pid(self):
        scope = self.prepared()
        self.assert_code("INVALID", lambda: scope.admit(424242))
        child = FakeChild(424242)
        for state, parent, code in (("R", self.owner_pid, "INVALID"), ("T", self.owner_pid + 1, "INVALID")):
            self.processes[child.pid] = {"pid": child.pid, "start": 200, "parent": parent, "state": state}
            self.assert_code(code, lambda: scope.admit(child))
        child.returncode = 0
        self.assert_code("INVALID", lambda: scope.admit(child))
        self.assertFalse(any(kind == "write" and name.endswith("/cgroup.procs") for kind, name in self.calls))

    def test_birth_replacement_between_stamp_and_admission_never_writes_membership(self):
        scope = self.prepared()
        child = FakeChild(424242)
        first = {"pid": child.pid, "start": 200, "parent": self.owner_pid, "state": "T"}
        second = dict(first, start=201)
        with patch.object(subject, "_proc_identity", side_effect=[first, second]):
            self.assert_code("IDENTITY", lambda: scope.admit(child))
        self.assertEqual(self.records()[-1]["phase"], "admitting")
        self.assertFalse(any(kind == "write" and name.endswith("/cgroup.procs") for kind, name in self.calls))

    def test_root_exit_does_not_prove_descendants_empty(self):
        scope, child = self.admitted()
        self.reaped(child)
        self.assertFalse(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])
        self.assertTrue(self.leaf.exists())

    def test_pipe_eof_does_not_prove_descendants_empty(self):
        scope, child = self.admitted()
        child.stdout.close()
        child.stderr.close()
        self.assertFalse(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])

    def test_empty_scope_without_root_reap_cannot_retire(self):
        scope, child = self.admitted()
        self.populated(0)
        self.assertTrue(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assertIsNone(child.returncode)
        self.assertTrue(scope.status()["hasDebt"])

    def test_wait_returncode_without_original_birth_disappearance_is_not_reap_proof(self):
        scope, child = self.admitted()
        child.returncode = 0
        self.populated(0)
        self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])

    def test_empty_and_separately_reaped_root_produce_distinct_retirement_receipt(self):
        scope, child = self.admitted()
        self.reaped(child)
        self.populated(0)
        receipt = scope.retire()
        self.assertEqual(receipt, {"scopeEmpty": True, "rootReaped": True, "neverAdmitted": False, "recovered": False})
        self.assertFalse(self.leaf.exists())
        self.assertFalse(scope.status()["hasDebt"])
        self.assertEqual(self.records()[-1]["phase"], "retired")

    def test_never_admitted_empty_leaf_never_claims_root_reaped(self):
        scope = self.prepared()
        self.assertEqual(scope.retire(), {"scopeEmpty": True, "rootReaped": False, "neverAdmitted": True, "recovered": False})

    def test_kill_success_is_not_scope_empty_and_never_signals_shared_parent(self):
        scope, child = self.admitted()
        scope.kill()
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "1\n")
        self.assertFalse(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])
        self.assertEqual(self.records()[-1]["phase"], "killing")

    def test_kill_error_retains_unknown_debt(self):
        scope, child = self.admitted()
        self.kill_error = True
        with self.assertRaises((OSError, subject.ReaderScopeError)):
            scope.kill()
        self.assertTrue(scope.status()["hasDebt"])
        self.assert_code("UNKNOWN", scope.retire)

    def test_malformed_or_oversize_events_do_not_clear_debt(self):
        scope = self.prepared()
        for text in ("", "frozen 0\n", "populated 2\n", "populated 0\npopulated 0\n", "populated nope\n", "x" * 65537):
            (self.leaf / "cgroup.events").write_text(text)
            self.assert_code("UNKNOWN", scope.retire)
            self.assertTrue(scope.status()["hasDebt"])

    def test_closed_scope_cannot_clear_debt_or_execute_late_calls(self):
        scope, child = self.admitted()
        before = self.journal.read_bytes()
        scope.close()
        for operation in (scope.kill, scope.retire, scope.prepare, lambda: scope.admit(child)):
            self.assert_code("UNKNOWN", operation)
        self.assertEqual(self.journal.read_bytes(), before)

    def test_replaced_leaf_identity_never_kills_replacement(self):
        scope, child = self.admitted()
        original = self.root / "original-leaf-held"
        self.leaf.rename(original)
        self.leaf.mkdir(mode=0o700)
        (self.leaf / "cgroup.kill").write_text("replacement-untouched")
        self.assert_code("IDENTITY", scope.kill)
        self.assert_code("IDENTITY", scope.retire)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "replacement-untouched")
        self.assertNotEqual(self.records()[-1]["phase"], "retired")

    def test_replaced_resource_root_never_kills_either_domain(self):
        scope, child = self.admitted()
        old = self.base / "original-root-held"
        self.root.rename(old)
        self.root.mkdir(mode=0o700)
        for name in self.parent_controls:
            (self.root / name).write_text("shared-parent-untouched\n")
        self.assert_code("IDENTITY", scope.kill)
        self.assertEqual((old / self.leaf.name / "cgroup.kill").read_text(), "")

    def test_replaced_journal_inode_prevents_signaling(self):
        scope, child = self.admitted()
        old = self.private / "original-journal-held"
        self.journal.rename(old)
        self.journal.write_bytes(old.read_bytes())
        self.journal.chmod(0o600)
        self.assert_code("IDENTITY", scope.kill)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_restart_debt_blocks_reuse_and_live_owner_recovery(self):
        scope, child = self.admitted()
        scope.close()
        replacement = self.scope()
        self.assertTrue(replacement.status()["hasDebt"])
        self.assert_code("DEBT", replacement.prepare)
        self.assert_code("BUSY", replacement.recover)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_recovery_pins_original_leaf_but_never_claims_original_root_reaped(self):
        scope, child = self.admitted()
        replacement = self.restart(scope)
        before = (self.leaf / "cgroup.kill").read_text()
        replacement.recover()
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), before)
        self.populated(0)
        self.assert_code("UNKNOWN", replacement.retire)
        self.reaped(child)
        receipt = replacement.retire()
        self.assertEqual(receipt, {"scopeEmpty": True, "rootReaped": False, "neverAdmitted": False, "recovered": True})
        self.assertFalse(replacement.status()["hasDebt"])

    def test_recovery_missing_or_replaced_leaf_retains_debt_without_signals(self):
        scope, child = self.admitted()
        replacement = self.restart(scope)
        old = self.root / "orphan-leaf-held"
        self.leaf.rename(old)
        with self.assertRaises((OSError, subject.ReaderScopeError)):
            replacement.recover()
        self.assertTrue(replacement.status()["hasDebt"])
        self.assert_code("DEBT", replacement.recover)
        replacement.close()
        replacement = self.scope()
        self.leaf.mkdir(mode=0o700)
        (self.leaf / "cgroup.kill").write_text("replacement-untouched")
        self.assert_code("IDENTITY", replacement.recover)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "replacement-untouched")

    def test_inherited_supervisor_identity_cannot_signal_or_retire(self):
        scope, child = self.admitted()
        with patch.object(os, "getpid", return_value=self.owner_pid + 1):
            self.assert_code("UNKNOWN", scope.kill)
            self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_journal_size_and_torn_or_duplicate_records_are_not_empty_receipts(self):
        scope = self.scope()
        scope.close()
        valid = self.journal.read_bytes()
        for content in (b"", valid[:-1], b"x" * 65537, valid + valid, valid.replace(b'"v":1', b'"v":1,"v":1')):
            self.journal.write_bytes(content)
            self.assert_code("DEBT", self.scope)
        self.journal.write_bytes(valid)
        replacement = self.scope()
        replacement.MAX_JOURNAL_BYTES = len(valid) + 100
        self.assert_code("DEBT", replacement.prepare)
        self.assertEqual(self.journal.read_bytes(), valid)

    def test_pre_mkdir_intent_crash_cannot_be_adopted_or_silently_freed(self):
        scope = self.scope()
        with patch.object(os, "mkdir", side_effect=OSError("fixture mkdir denied")):
            self.assert_code("UNKNOWN", scope.prepare)
        self.assertEqual(self.records()[-1]["phase"], "intent")
        self.assertIsNone(self.records()[-1]["leaf_identity"])
        replacement = self.restart(scope)
        self.assert_code("DEBT", replacement.prepare)
        self.assert_code("UNKNOWN", replacement.recover)
        self.assertTrue(replacement.status()["hasDebt"])

    def test_retired_instance_is_single_operation_and_old_callbacks_cannot_hit_new_leaf(self):
        scope = self.prepared()
        old_kill, old_empty, old_retire = scope.kill, scope.empty, scope.retire
        scope.retire()
        self.assert_code("DEBT", scope.prepare)
        scope.close()
        replacement = self.scope()
        replacement.prepare()
        before = self.journal.read_bytes()
        for callback in (old_kill, old_empty, old_retire):
            self.assert_code("UNKNOWN", callback)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")
        self.assertEqual(replacement.status()["phase"], "prepared")

    def test_pinned_root_fd_replacement_is_not_parent_signal_authority(self):
        scope, child = self.admitted()
        old_fd = scope._root_fd
        scope._root_fd = os.open(self.private, os.O_RDONLY | os.O_DIRECTORY)
        os.close(old_fd)
        self.assert_code("IDENTITY", scope.kill)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_admission_journal_fsync_failure_never_writes_membership(self):
        scope = self.prepared()
        child = FakeChild(424242)
        self.processes[child.pid] = {"pid": child.pid, "start": 200, "parent": self.owner_pid, "state": "T"}
        def fail_sync(fd):
            if self.fdpath(fd) == self.journal:
                raise OSError("fixture durable admission failed")
            return self.real_fsync(fd)
        with patch.object(os, "fsync", side_effect=fail_sync):
            with self.assertRaises((OSError, subject.ReaderScopeError)):
                scope.admit(child)
        self.assertEqual(self.records()[-1]["phase"], "admitting")
        self.assertFalse(any(kind == "write" and name.endswith("/cgroup.procs") for kind, name in self.calls))
        self.assert_code("UNKNOWN", scope.kill)

    def test_deadline_or_unknown_control_error_cannot_clear_durable_debt(self):
        scope, child = self.admitted()
        def timeout(fd, data):
            if self.fdpath(fd).name == "cgroup.kill":
                raise TimeoutError("fixture cleanup deadline")
            return self.write(fd, data)
        with patch.object(os, "write", side_effect=timeout):
            with self.assertRaises((TimeoutError, subject.ReaderScopeError)):
                scope.kill()
        self.assertTrue(scope.status()["hasDebt"])
        self.assert_code("UNKNOWN", scope.retire)
        scope.close()
        replacement = self.scope()
        self.assertTrue(replacement.status()["hasDebt"])
        self.assert_code("DEBT", replacement.prepare)

    def test_unsafe_journal_permissions_and_hardlinks_fail_without_truncation(self):
        scope = self.scope()
        scope.close()
        before = self.journal.read_bytes()
        self.journal.chmod(0o644)
        self.assert_code("IDENTITY", self.scope)
        self.journal.chmod(0o600)
        os.link(self.journal, self.private / "second-link")
        self.assert_code("IDENTITY", self.scope)
        self.assertEqual(self.journal.read_bytes(), before)

    def test_original_root_pid_reuse_is_distinct_from_original_birth_liveness(self):
        scope, child = self.admitted()
        child.returncode = 0
        self.processes[child.pid]["start"] += 1
        self.populated(0)
        receipt = scope.retire()
        self.assertTrue(receipt["scopeEmpty"])
        self.assertTrue(receipt["rootReaped"])
        self.assertFalse(receipt["recovered"])

    def test_default_missing_journal_refuses_without_creating_file_or_leaf(self):
        self.assert_code("DEBT", lambda: self.scope(initialize=False))
        self.assertFalse(self.journal.exists())
        self.assertIsNone(self.leaf)
        self.assertFalse(any(kind == "mkdir" for kind, _ in self.calls))

    def test_initialize_flag_requires_literal_boolean(self):
        for value in (0, 1, "true", None, [], {}):
            self.assert_code("INVALID", lambda: self.scope(initialize=value))
        self.assertFalse(self.journal.exists())

    def test_explicit_initialization_never_overwrites_existing_idle_or_debt(self):
        scope = self.scope(initialize=True)
        before = self.journal.read_bytes()
        with self.assertRaises(subject.ReaderScopeError):
            self.scope(initialize=True)
        self.assertEqual(self.journal.read_bytes(), before)
        scope.prepare()
        before = self.journal.read_bytes()
        scope.close()
        self.assert_code("DEBT", lambda: self.scope(initialize=True))
        self.assertEqual(self.journal.read_bytes(), before)
        replacement = self.scope(initialize=False)
        self.assertTrue(replacement.status()["hasDebt"])

    def test_missing_expected_journal_after_debt_is_not_implicitly_reinitialized(self):
        scope, child = self.admitted()
        scope.close()
        self.journal.unlink()
        self.assert_code("DEBT", self.scope)
        self.assert_code("DEBT", lambda: self.scope(initialize=True))
        self.assertFalse(self.journal.exists())
        self.assertTrue(self.leaf.exists())
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_fresh_initialization_refuses_recursively_populated_root(self):
        (self.root / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        self.assert_code("DEBT", lambda: self.scope(initialize=True))
        self.assertIsNone(self.leaf)
        if self.journal.exists():
            self.assertNotIn(b'"phase":"idle"', self.journal.read_bytes())

    def test_fresh_initialization_refuses_orphan_leaf_even_when_events_say_empty(self):
        orphan = self.root / ("orbit-reader-" + "a" * 32)
        orphan.mkdir(mode=0o700)
        (orphan / "cgroup.kill").write_text("orphan-untouched")
        self.assert_code("DEBT", lambda: self.scope(initialize=True))
        self.assertEqual((orphan / "cgroup.kill").read_text(), "orphan-untouched")

    def test_fresh_initialization_refuses_any_child_domain_not_only_owned_name(self):
        (self.root / "other-owner-domain").mkdir(mode=0o700)
        self.assert_code("DEBT", lambda: self.scope(initialize=True))
        self.assertFalse(any(kind == "write" and name.startswith(str(self.root)) for kind, name in self.calls))

    def test_fresh_initialization_rejects_unavailable_or_malformed_root_population(self):
        (self.root / "cgroup.events").write_text("populated 0\npopulated 1\n")
        with self.assertRaises(subject.ReaderScopeError):
            self.scope(initialize=True)
        self.assertIsNone(self.leaf)

    def test_idle_checkpoint_preserves_inode_lock_flags_and_exclusive_guard(self):
        scope = self.scope()
        before_stat = self.journal.stat()
        before_flags = fcntl.fcntl(scope._journal_fd, fcntl.F_GETFL)
        before_fdflags = fcntl.fcntl(scope._journal_fd, fcntl.F_GETFD)
        scope.checkpoint()
        after_stat = self.journal.stat()
        self.assertEqual((before_stat.st_dev, before_stat.st_ino), (after_stat.st_dev, after_stat.st_ino))
        self.assertEqual(fcntl.fcntl(scope._journal_fd, fcntl.F_GETFL), before_flags)
        self.assertEqual(fcntl.fcntl(scope._journal_fd, fcntl.F_GETFD), before_fdflags)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual((self.records()[0]["phase"], self.records()[0]["sequence"]), ("idle", 0))
        self.assertFalse(scope.status()["hasDebt"])
        self.assert_code("BUSY", self.scope)
        scope.close()
        reopened = self.scope()
        self.assertFalse(reopened.status()["hasDebt"])

    def test_healthy_operations_exceed_64k_equivalent_history_while_checkpoint_stays_bounded(self):
        total_history = 0
        scope = self.scope()
        original_inode = self.journal.stat().st_ino
        for _ in range(64):
            scope.prepare()
            receipt = scope.retire()
            self.assertTrue(receipt["scopeEmpty"])
            total_history += self.journal.stat().st_size
            scope.checkpoint()
            self.assertEqual(self.journal.stat().st_ino, original_inode)
            self.assertLess(self.journal.stat().st_size, 4096)
            self.assertEqual(len(self.records()), 1)
            self.assertFalse(scope.status()["hasDebt"])
            self.assert_code("DEBT", scope.prepare)
            scope.close()
            scope = self.scope(initialize=False)
        self.assertGreater(total_history, 65536)

    def test_checkpoint_never_erases_active_or_unknown_kill_debt(self):
        scope, child = self.admitted()
        before = self.journal.read_bytes()
        self.assert_code("DEBT", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        scope.kill()
        before = self.journal.read_bytes()
        self.assert_code("DEBT", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertTrue(scope.status()["hasDebt"])

    def test_checkpoint_never_erases_intent_without_pinned_leaf_identity(self):
        scope = self.scope()
        with patch.object(os, "mkdir", side_effect=OSError("fixture intent interruption")):
            self.assert_code("UNKNOWN", scope.prepare)
        before = self.journal.read_bytes()
        self.assert_code("DEBT", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)

    def test_checkpoint_never_erases_unfinished_recovery(self):
        scope, child = self.admitted()
        replacement = self.restart(scope)
        replacement.recover()
        before = self.journal.read_bytes()
        self.assert_code("DEBT", replacement.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertTrue(replacement.status()["hasDebt"])

    def test_retired_checkpoint_preserves_single_operation_and_old_callback_refusal(self):
        scope = self.prepared()
        old_kill, old_retire = scope.kill, scope.retire
        scope.retire()
        scope.checkpoint()
        self.assert_code("DEBT", scope.prepare)
        self.assert_code("DEBT", scope.recover)
        scope.close()
        replacement = self.scope()
        replacement.prepare()
        before = self.journal.read_bytes()
        self.assert_code("UNKNOWN", old_kill)
        self.assert_code("UNKNOWN", old_retire)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_checkpoint_requires_root_still_empty_and_without_child_directories(self):
        scope = self.scope()
        before = self.journal.read_bytes()
        (self.root / "cgroup.events").write_text("populated 1\n")
        with self.assertRaises(subject.ReaderScopeError):
            scope.checkpoint()
        self.assertEqual(self.journal.read_bytes(), before)
        (self.root / "cgroup.events").write_text("populated 0\n")
        (self.root / "unrelated-child").mkdir(mode=0o700)
        with self.assertRaises(subject.ReaderScopeError):
            scope.checkpoint()
        self.assertEqual(self.journal.read_bytes(), before)

    def test_checkpoint_completed_truncate_then_storage_failure_reopens_as_debt(self):
        scope = self.scope()
        original = os.ftruncate
        failed = False
        def truncate_then_fail(fd, length):
            nonlocal failed
            result = original(fd, length)
            if not failed and self.fdpath(fd) == self.journal:
                failed = True
                raise OSError("fixture failure after truncate")
            return result
        with patch.object(os, "ftruncate", side_effect=truncate_then_fail):
            self.assert_code("UNKNOWN", scope.checkpoint)
        self.assert_code("UNKNOWN", scope.status)
        scope.close()
        self.assert_code("DEBT", self.scope)

    def test_checkpoint_partial_write_is_torn_not_a_restart_permission(self):
        scope = self.scope()
        original_truncate = os.ftruncate
        truncations = 0
        def fail_cleanup_truncate(fd, length):
            nonlocal truncations
            if self.fdpath(fd) == self.journal:
                truncations += 1
                if truncations > 1:
                    raise OSError("fixture invalidation storage unavailable")
            return original_truncate(fd, length)
        failed = False
        def prefix_then_fail(fd, data):
            nonlocal failed
            if self.fdpath(fd) == self.journal and not failed:
                failed = True
                self.real_write(fd, data[:max(1, len(data) // 2)])
                raise OSError("fixture partial checkpoint write")
            return self.write(fd, data)
        with patch.object(os, "write", side_effect=prefix_then_fail), patch.object(os, "ftruncate", side_effect=fail_cleanup_truncate):
            self.assert_code("UNKNOWN", scope.checkpoint)
        self.assertGreater(len(self.journal.read_bytes()), 0)
        self.assertFalse(self.journal.read_bytes().endswith(b"\n"))
        self.assert_code("UNKNOWN", scope.status)
        scope.close()
        self.assert_code("DEBT", self.scope)

    def test_checkpoint_fsync_failure_invalidates_if_storage_allows_cleanup(self):
        scope = self.scope()
        failed = False
        def fail_once(fd):
            nonlocal failed
            if self.fdpath(fd) == self.journal and not failed:
                failed = True
                raise OSError("fixture checkpoint sync failure")
            return self.fsync(fd)
        with patch.object(os, "fsync", side_effect=fail_once):
            self.assert_code("UNKNOWN", scope.checkpoint)
        self.assert_code("UNKNOWN", scope.status)
        scope.close()
        self.assert_code("DEBT", self.scope)

    def test_checkpoint_powerloss_after_truncate_leaves_no_autoreset_on_reopen(self):
        scope = self.scope()
        original = os.ftruncate
        class SimulatedPowerLoss(BaseException):
            pass
        def crash_after_truncate(fd, length):
            original(fd, length)
            if self.fdpath(fd) == self.journal:
                raise SimulatedPowerLoss()
        with patch.object(os, "ftruncate", side_effect=crash_after_truncate):
            with self.assertRaises(SimulatedPowerLoss):
                scope.checkpoint()
        scope.close()
        self.assert_code("DEBT", self.scope)

    def test_checkpoint_closed_inherited_and_replaced_journal_guards(self):
        scope = self.scope()
        before = self.journal.read_bytes()
        with patch.object(os, "getpid", return_value=self.owner_pid + 1):
            self.assert_code("UNKNOWN", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        original = self.private / "checkpoint-original-journal"
        self.journal.rename(original)
        self.journal.write_bytes(before)
        self.journal.chmod(0o600)
        self.assert_code("IDENTITY", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        scope.close()
        self.assert_code("UNKNOWN", scope.checkpoint)

    def test_full_journal_with_unresolved_work_cannot_be_checkpointed_or_evicted(self):
        scope, child = self.admitted()
        before = self.journal.read_bytes()
        scope.MAX_JOURNAL_BYTES = len(before)
        self.assert_code("DEBT", scope.kill)
        self.assert_code("DEBT", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertTrue(scope.status()["hasDebt"])
        self.assertEqual((self.leaf / "cgroup.kill").read_text(), "")

    def test_checkpoint_replaced_resource_root_does_not_truncate_journal(self):
        scope = self.scope()
        before = self.journal.read_bytes()
        self.root.rename(self.base / "original-checkpoint-root")
        self.root.mkdir(mode=0o700)
        (self.root / "cgroup.events").write_text("populated 0\n")
        for name in self.parent_controls:
            (self.root / name).write_text("shared-parent-untouched\n")
        self.assert_code("IDENTITY", scope.checkpoint)
        self.assertEqual(self.journal.read_bytes(), before)


    def spawn_reserved(self, *, state="R"):
        scope = self.prepared()
        scope.reserve_spawn()
        child = FakeChild(424242)
        self.processes[child.pid] = {"pid": child.pid, "start": 200, "parent": self.owner_pid, "state": state}
        return scope, child

    def test_spawn_intent_is_durable_v2_without_rewriting_old_v1_records(self):
        scope = self.prepared()
        original = self.journal.read_bytes()
        self.assertTrue(all(record["v"] == 1 for record in self.records()))
        scope.reserve_spawn()
        self.assertTrue(self.journal.read_bytes().startswith(original))
        last = self.records()[-1]
        self.assertEqual((last["v"], last["phase"], last["spawn_pending"], last["process"]),
                         (2, "spawn_intent", True, None))
        self.assertEqual(self.synced_phases[-1], "spawn_intent")
        self.assertTrue(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assertTrue(scope.status()["hasDebt"])

    def test_spawn_reservation_is_once_and_not_a_public_no_child_receipt(self):
        scope, _child = self.spawn_reserved()
        self.assert_code("DEBT", scope.reserve_spawn)
        self.assertFalse(hasattr(scope, "spawn_failed"))
        self.assert_code("UNKNOWN", scope.retire)
        self.assert_code("DEBT", scope.checkpoint)
        self.assertIsNone(self.records()[-1]["process"])

    def test_owner_death_before_spawn_keeps_uncertain_intent_permanently(self):
        scope = self.prepared()
        scope.reserve_spawn()  # A crash cannot prove whether Popen was entered.
        reopened = self.restart(scope)
        self.assert_code("UNKNOWN", reopened.recover)
        self.assert_code("DEBT", reopened.prepare)
        self.assert_code("DEBT", reopened.checkpoint)
        reopened.close()
        again = self.scope()
        self.assert_code("UNKNOWN", again.recover)
        self.assertTrue(self.records()[-1]["spawn_pending"])
        self.assertTrue(self.leaf.exists())

    def test_possible_child_created_before_bind_remains_debt_after_owner_loss(self):
        scope, child = self.spawn_reserved()
        self.assertIn(child.pid, self.processes)
        reopened = self.restart(scope)
        self.assert_code("UNKNOWN", reopened.recover)
        self.assertTrue(self.records()[-1]["spawn_pending"])
        self.assertIsNone(self.records()[-1]["process"])
        self.assertFalse(any(event == ("write", str(self.leaf / "cgroup.procs")) for event in self.calls))

    def test_empty_kill_after_unbound_spawn_preserves_pending_marker_on_restart(self):
        scope, _child = self.spawn_reserved()
        scope.kill()
        self.assertEqual(self.records()[-1]["phase"], "killing")
        self.assertTrue(self.records()[-1]["spawn_pending"])
        self.assertTrue(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.assert_code("DEBT", scope.reserve_spawn)
        reopened = self.restart(scope)
        self.assert_code("UNKNOWN", reopened.recover)
        self.assertTrue(self.leaf.exists())

    def test_running_child_binds_before_stop_and_cannot_retire_until_separate_reap(self):
        scope, child = self.spawn_reserved(state="R")
        scope.bind_child(child)
        last = self.records()[-1]
        self.assertEqual((last["phase"], last["spawn_pending"], last["process"]),
                         ("spawn_bound", False, [child.pid, 200]))
        self.assertEqual(self.synced_phases[-1], "spawn_bound")
        self.assertTrue(scope.empty())
        self.assert_code("UNKNOWN", scope.retire)
        self.reaped(child)
        self.assertEqual(scope.retire(), {"scopeEmpty": True, "rootReaped": True,
                                         "neverAdmitted": False, "recovered": False})

    def test_bound_running_child_still_needs_stop_before_membership_admission(self):
        scope, child = self.spawn_reserved(state="R")
        scope.bind_child(child)
        self.assert_code("INVALID", lambda: scope.admit(child))
        self.processes[child.pid]["state"] = "T"
        scope.admit(child)
        self.assertEqual(self.records()[-1]["phase"], "admitted")
        self.assertFalse(self.records()[-1]["spawn_pending"])
        self.assertEqual(self.synced_phases[-1], "admitted")

    def test_bound_child_cannot_be_substituted_by_another_popen_with_same_pid(self):
        scope, child = self.spawn_reserved(state="T")
        scope.bind_child(child)
        impostor = FakeChild(child.pid)
        self.assert_code("IDENTITY", lambda: scope.admit(impostor))
        self.assertEqual(self.records()[-1]["phase"], "spawn_bound")
        self.assertEqual((self.leaf / "cgroup.procs").read_text(), "")

    def test_bound_birth_replacement_refuses_admission_before_membership_write(self):
        scope, child = self.spawn_reserved(state="T")
        scope.bind_child(child)
        self.processes[child.pid]["start"] += 1
        self.assert_code("IDENTITY", lambda: scope.admit(child))
        self.assertEqual((self.leaf / "cgroup.procs").read_text(), "")
        self.assertEqual(self.records()[-1]["process"], [child.pid, 200])

    def test_bind_rejects_raw_pid_reaped_or_foreign_process_without_clearing_intent(self):
        scope, child = self.spawn_reserved()
        self.assert_code("INVALID", lambda: scope.bind_child(child.pid))
        child.returncode = 0
        self.assert_code("INVALID", lambda: scope.bind_child(child))
        child.returncode = None
        self.processes[child.pid]["parent"] = self.owner_pid + 1
        self.assert_code("INVALID", lambda: scope.bind_child(child))
        self.assertTrue(self.records()[-1]["spawn_pending"])
        self.assert_code("UNKNOWN", scope.retire)

    def test_bind_birth_race_never_turns_unknown_spawn_into_resolved_ownership(self):
        scope, child = self.spawn_reserved()
        first = dict(self.processes[child.pid])
        second = {**first, "start": first["start"] + 1}
        with patch.object(subject, "_proc_identity", side_effect=[first, second]):
            self.assert_code("IDENTITY", lambda: scope.bind_child(child))
        self.assertTrue(self.records()[-1]["spawn_pending"])
        self.assertIsNone(self.records()[-1]["process"])

    def test_binding_journal_failure_poison_holds_debt_and_never_migrates_child(self):
        scope, child = self.spawn_reserved()
        def fail_binding_fsync(fd):
            if self.fdpath(fd) == self.journal and self.records()[-1]["phase"] == "spawn_bound":
                raise OSError("owned fixture binding fsync failure")
            return self.fsync(fd)
        with patch.object(os, "fsync", side_effect=fail_binding_fsync):
            self.assert_code("UNKNOWN", lambda: scope.bind_child(child))
        self.assert_code("UNKNOWN", scope.kill)
        self.assert_code("UNKNOWN", scope.retire)
        self.assertEqual((self.leaf / "cgroup.procs").read_text(), "")

    def test_bound_admission_write_uncertainty_requires_both_root_and_scope_cleanup(self):
        scope, child = self.spawn_reserved(state="T")
        scope.bind_child(child)
        def write_then_fail(fd, data):
            written = self.write(fd, data)
            if self.fdpath(fd).name == "cgroup.procs":
                raise OSError("owned fixture ambiguous migration")
            return written
        with patch.object(os, "write", side_effect=write_then_fail):
            self.assert_code("UNKNOWN", lambda: scope.admit(child))
        self.assertEqual(self.records()[-1]["phase"], "admitting")
        self.assertFalse(self.records()[-1]["spawn_pending"])
        scope.kill()
        self.reaped(child)
        self.assert_code("UNKNOWN", scope.retire)
        self.populated(0)
        self.assertTrue(scope.retire()["rootReaped"])

    def test_bound_but_unmigrated_child_recovery_never_claims_original_parent_reap(self):
        scope, child = self.spawn_reserved()
        scope.bind_child(child)
        reopened = self.restart(scope)
        reopened.recover()
        self.assertTrue(reopened.empty())
        self.assert_code("UNKNOWN", reopened.retire)
        self.processes.pop(child.pid)
        self.assertEqual(reopened.retire(), {"scopeEmpty": True, "rootReaped": False,
                                            "neverAdmitted": False, "recovered": True})

    def test_forged_pending_marker_clear_recovery_retire_or_schema_downgrade_refuses(self):
        scope, _child = self.spawn_reserved()
        original = self.journal.read_bytes()
        last = dict(self.records()[-1])
        scope.close()
        for phase, pending, version in (("killing", False, 2), ("recovery", True, 2),
                                        ("recovery", False, 2), ("retired", False, 2),
                                        ("killing", False, 1)):
            with self.subTest(phase=phase, pending=pending, version=version):
                forged = {**last, "sequence": last["sequence"] + 1,
                          "phase": phase, "spawn_pending": pending, "v": version}
                if phase == "recovery":
                    forged["recovered"] = True
                if version == 1:
                    forged.pop("spawn_pending")
                self.journal.write_bytes(original + (json.dumps(forged) + "\n").encode())
                self.assert_code("DEBT", lambda: self.scope())
        self.journal.write_bytes(original)

    def test_legacy_no_spawn_scope_remains_v1_and_known_no_child_can_retire(self):
        scope = self.prepared()
        self.assertTrue(all(record["v"] == 1 and "spawn_pending" not in record for record in self.records()))
        self.assertEqual(scope.retire(), {"scopeEmpty": True, "rootReaped": False,
                                         "neverAdmitted": True, "recovered": False})


    def test_v2_retired_generations_reopen_without_downgrade_and_checkpoint_is_fresh_v1(self):
        callbacks = []
        for generation in range(3):
            scope, child = self.spawn_reserved(state="T")
            self.assertTrue(self.records()[-1]["spawn_pending"])
            scope.bind_child(child)
            scope.admit(child)
            self.reaped(child)
            self.populated(0)
            self.assertTrue(scope.retire()["rootReaped"])
            self.assertEqual(self.records()[-1]["v"], 2)
            self.assertFalse(self.records()[-1]["spawn_pending"])
            callbacks.append(scope.kill)
            scope.close()
        versions = [record["v"] for record in self.records()]
        first_v2 = versions.index(2)
        self.assertTrue(all(version == 1 for version in versions[:first_v2]))
        self.assertTrue(all(version == 2 for version in versions[first_v2:]))
        checkpoint = self.scope()
        checkpoint.checkpoint()
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]["v"], 1)
        self.assertEqual(self.records()[0]["phase"], "idle")
        checkpoint.close()
        active = self.prepared()
        active.reserve_spawn()
        self.assertEqual(self.records()[-1]["v"], 2)
        for callback in callbacks:
            self.assert_code("UNKNOWN", callback)
        self.assertTrue(active.status()["hasDebt"])


    def test_every_legal_append_transition_rejects_v2_downgrade_or_removed_marker(self):
        scope, child = self.spawn_reserved()
        scope.bind_child(child)
        template = dict(self.records()[-1])
        edges = {"intent": {"idle", "retired"}, "pinned": {"intent"}, "prepared": {"pinned"},
                 "spawn_intent": {"prepared"}, "spawn_bound": {"spawn_intent"},
                 "admitting": {"prepared", "spawn_bound"}, "admitted": {"admitting"},
                 "killing": {"pinned", "prepared", "spawn_intent", "spawn_bound", "admitting", "admitted"},
                 "recovery": {"pinned", "prepared", "spawn_bound", "admitting", "admitted", "killing", "recovery"},
                 "retired": {"pinned", "prepared", "spawn_bound", "admitting", "admitted", "killing", "recovery"}}
        checked = 0
        for phase, predecessors in edges.items():
            for predecessor in predecessors:
                previous = {**template, "phase": predecessor}
                for version, remove_marker in ((1, True), (1, False), (2, True)):
                    with self.subTest(previous=predecessor, phase=phase,
                                      version=version, remove_marker=remove_marker):
                        record = {**previous, "sequence": previous["sequence"] + 1,
                                  "phase": phase, "v": version}
                        if remove_marker:
                            record.pop("spawn_pending")
                        self.assert_code("DEBT", lambda: subject.ReaderScope._validate_transition(previous, record))
                        checked += 1
        self.assertEqual(checked, sum(len(states) for states in edges.values()) * 3)
        self.assertGreater(checked, 60)


if __name__ == "__main__":
    unittest.main()
