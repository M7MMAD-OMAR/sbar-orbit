"""Real owned HOME-child filesystem fixtures. No desktop, cgroup or helper processes."""
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import read_usage_store as subject


class UsageStoreTests(unittest.TestCase):
    def setUp(self):
        # Never chmod or write existing HOME components. Fail if their trust is unsafe.
        self.temp = tempfile.TemporaryDirectory(prefix=".orbit-usage-fixture-", dir=Path.home())
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "state"
        self.root.mkdir(mode=0o700)
        self.first, self.second = object(), object()
        self.key, self.other_key = "a" * 64, "b" * 64
        self.entries = ((self.first, self.key), (self.second, self.other_key))
        self.stores = []
        self.owner_fds = set()
        self.addCleanup(self.close_owner_fds)
        self.addCleanup(self.close_stores)
        self.real_open, self.real_fsync = os.open, os.fsync
        self.real_rename, self.real_unlink, self.real_close = os.rename, os.unlink, os.close

    def close_stores(self):
        for store in reversed(self.stores):
            try:
                store.close()
            except subject.ReadUsageStoreError:
                pass

    def owner_fd(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        self.owner_fds.add(fd)
        return fd

    def close_owner(self, fd):
        os.close(fd)
        self.owner_fds.remove(fd)

    def close_owner_fds(self):
        for fd in tuple(self.owner_fds):
            self.close_owner(fd)

    def store(self, **kwargs):
        extra = {"expected_root_fd": kwargs["expected_root_fd"]} if "expected_root_fd" in kwargs else {}
        result = subject.ReadUsageStore(str(kwargs.get("root", self.root)), kwargs.get("entries", self.entries), **extra)
        self.stores.append(result)
        return result

    def value(self, epoch=1, enabled=True, instance="c" * 64):
        return {"instance": instance, "epoch": epoch, "enabled": enabled}

    def path(self, suffix=".json", key=None):
        return self.root / ((key or self.key) + suffix)

    def code(self, code, action):
        with self.assertRaises(subject.ReadUsageStoreError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), "Private read usage storage refused")
        self.assertIsNone(caught.exception.__context__)

    def fd_path(self, fd):
        return Path(os.readlink(f"/proc/self/fd/{fd}"))

    def test_absent_record_is_disabled_reconciliation_not_initial_on(self):
        store = self.store()
        result = store.read_evidence(self.first)
        self.assertEqual(result, {"enabled": False, "reconciliationRequired": True, "acknowledgement": "unknown", "state": "absent"})
        with self.assertRaises(TypeError):
            result["enabled"] = True
        self.assertEqual(set(os.listdir(self.root)), {subject.ReadUsageStore.LOCK})

    def test_real_commit_bytes_mode_and_restart_never_restore_on(self):
        store = self.store()
        store.commit(self.first, self.value())
        raw = self.path().read_bytes()
        self.assertEqual(raw, subject._encoded(self.value()))
        self.assertLessEqual(len(raw), 256)
        self.assertEqual(stat.S_IMODE(self.path().stat().st_mode), 0o600)
        self.assertFalse(self.path(".pending").exists())
        self.assertFalse(self.path(".writing").exists())
        store.close()
        restored = self.store().read_evidence(self.first)
        self.assertEqual(restored["state"], "recorded-on")
        self.assertIs(restored["enabled"], False)

    def test_actual_fsync_and_rename_order_keeps_marker_until_durable_record(self):
        store = self.store()
        calls = []
        def sync(fd):
            calls.append(("sync", self.fd_path(fd).name))
            return self.real_fsync(fd)
        def rename(source, destination, *, src_dir_fd=None, dst_dir_fd=None):
            self.assertEqual(source, self.key + ".writing")
            self.assertEqual(destination, self.key + ".json")
            self.assertEqual(src_dir_fd, dst_dir_fd)
            self.assertEqual(self.fd_path(src_dir_fd), self.root)
            self.assertTrue(self.path(".pending").exists())
            self.assertIn(("sync", self.key + ".pending"), calls)
            self.assertIn(("sync", self.key + ".writing"), calls)
            calls.append(("rename", destination))
            return self.real_rename(source, destination, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        def unlink(name, *, dir_fd=None):
            self.assertEqual(name, self.key + ".pending")
            self.assertEqual(calls[-1], ("sync", self.root.name))
            self.assertTrue(self.path().exists())
            calls.append(("unlink", name))
            return self.real_unlink(name, dir_fd=dir_fd)
        with patch.object(os, "fsync", side_effect=sync), patch.object(os, "rename", side_effect=rename), patch.object(os, "unlink", side_effect=unlink):
            store.commit(self.first, self.value())
        self.assertLess(calls.index(("rename", self.key + ".json")), calls.index(("unlink", self.key + ".pending")))
        self.assertEqual(calls[-1], ("sync", self.root.name))

    def test_root_flock_is_exclusive_and_released_without_replacing_inode(self):
        store = self.store()
        lock = self.root / subject.ReadUsageStore.LOCK
        identity = (lock.stat().st_dev, lock.stat().st_ino)
        self.code("BUSY", self.store)
        store.close()
        other = self.store()
        self.assertEqual((lock.stat().st_dev, lock.stat().st_ino), identity)
        other.commit(self.first, self.value(enabled=False))
        self.assertEqual(other.read_evidence(self.first)["state"], "recorded-off")

    def test_mapping_keys_capacity_and_object_identity_are_strict(self):
        for entries in ([self.entries[0]], (), ((self.first, "../escape"),), ((self.first, self.key), (self.first, self.other_key)),
                        ((self.first, self.key), (self.second, self.key)), tuple((object(), str(index) * 64) for index in range(5))):
            self.code("INVALID", lambda: self.store(entries=entries))
        store = self.store()
        self.code("DENIED", lambda: store.commit(object(), self.value()))
        self.code("DENIED", lambda: store.read_evidence(object()))

    def test_records_reject_invalid_schema_types_and_noncanonical_corruption(self):
        for value in ({"instance": "label", "epoch": 1, "enabled": True}, self.value(epoch=True), self.value(epoch=0),
                      self.value(epoch=9007199254740992), self.value(enabled=1), {**self.value(), "extra": "secret"}):
            store = self.store()
            self.code("INVALID", lambda: store.commit(self.first, value))
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
            store.close()
        store = self.store()
        self.path().write_bytes(b'{"schema":1,"instance":"secret-private-error"}\n')
        os.chmod(self.path(), 0o600)
        self.assertEqual(store.read_evidence(self.first)["state"], "unconfirmed")
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))

    def test_same_coordinator_epochs_increase_and_failure_cannot_retry(self):
        store = self.store()
        store.commit(self.first, self.value(epoch=5))
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value(epoch=5, enabled=False)))
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value(epoch=6)))
        self.assertEqual(json.loads(self.path().read_bytes())["epoch"], 5)

    def test_fresh_instance_record_is_not_persistent_antireplay_or_grant_restore(self):
        store = self.store()
        store.commit(self.first, self.value(epoch=10))
        store.close()
        restarted = self.store()
        self.assertIs(restarted.read_evidence(self.first)["enabled"], False)
        restarted.commit(self.first, self.value(epoch=1, instance="d" * 64))
        self.assertIs(restarted.read_evidence(self.first)["enabled"], False)

    def test_symlink_and_hardlink_records_are_refused_without_touching_target(self):
        store = self.store()
        foreign = self.base / "foreign"
        foreign.write_bytes(b"owner-fixture-preserve")
        os.chmod(foreign, 0o600)
        self.path().symlink_to(foreign)
        self.assertEqual(store.read_evidence(self.first)["state"], "unconfirmed")
        self.assertEqual(foreign.read_bytes(), b"owner-fixture-preserve")
        store.close()
        self.path().unlink()
        os.link(foreign, self.path())
        reopened = self.store()
        self.code("UNCONFIRMED", lambda: reopened.commit(self.first, self.value()))
        self.assertEqual(foreign.read_bytes(), b"owner-fixture-preserve")

    def test_root_symlinks_and_untrusted_ancestor_permissions_are_rejected(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.code("UNCONFIRMED", lambda: self.store(root=alias))
        os.chmod(self.base, 0o777)  # Only this fixture's newly owned directory.
        try:
            self.code("UNCONFIRMED", self.store)
        finally:
            os.chmod(self.base, 0o700)

    def test_integrity_failure_poison_is_global_even_after_path_repair(self):
        store = self.store()
        original = self.base / "original"
        self.root.rename(original)
        self.root.mkdir(mode=0o700)
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.root.rmdir()
        original.rename(self.root)
        self.code("UNCONFIRMED", lambda: store.commit(self.second, self.value()))
        self.assertFalse(self.path(key=self.other_key).exists())

    def test_lock_replacement_poison_preserves_foreign_lock_contents(self):
        store = self.store()
        lock = self.root / subject.ReadUsageStore.LOCK
        lock.rename(self.base / "original-lock")
        lock.write_bytes(b"foreign-lock")
        os.chmod(lock, 0o600)
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.code("UNCONFIRMED", lambda: store.read_evidence(self.second))
        self.assertEqual(lock.read_bytes(), b"foreign-lock")

    def test_write_failure_keeps_durable_marker_and_restart_cannot_enable(self):
        store = self.store()
        real_write = os.write
        def write(fd, raw):
            if self.fd_path(fd).name.endswith(".writing"):
                raise OSError("private-secret-write-error")
            return real_write(fd, raw)
        with patch.object(os, "write", side_effect=write):
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.assertTrue(self.path(".pending").exists())
        store.close()
        reopened = self.store()
        self.assertEqual(reopened.read_evidence(self.first)["state"], "unconfirmed")
        self.code("UNCONFIRMED", lambda: reopened.commit(self.first, self.value(epoch=2)))

    def test_rename_then_error_keeps_marker_and_record_is_not_an_acknowledgement(self):
        store = self.store()
        def rename(*args, **kwargs):
            self.real_rename(*args, **kwargs)
            raise OSError("private-secret-rename-error")
        with patch.object(os, "rename", side_effect=rename):
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.assertTrue(self.path().exists())
        self.assertTrue(self.path(".pending").exists())
        store.close()
        result = self.store().read_evidence(self.first)
        self.assertEqual(result["state"], "unconfirmed")
        self.assertIs(result["enabled"], False)

    def test_directory_fsync_failure_after_rename_retains_pending_and_blocks_retry(self):
        store = self.store()
        def sync(fd):
            if self.fd_path(fd) == self.root and self.path().exists():
                raise OSError("owned fixture directory fsync failed")
            return self.real_fsync(fd)
        with patch.object(os, "fsync", side_effect=sync):
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.assertTrue(self.path(".pending").exists())
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value(epoch=2)))

    def test_post_unlink_failure_is_unconfirmed_even_if_record_persisted_and_marker_gone(self):
        store = self.store()
        def unlink(*args, **kwargs):
            self.real_unlink(*args, **kwargs)
            raise OSError("owned fixture unlink acknowledgement lost")
        with patch.object(os, "unlink", side_effect=unlink):
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.assertFalse(self.path(".pending").exists())
        store.close()
        result = self.store().read_evidence(self.first)
        self.assertEqual(result["state"], "recorded-on")
        self.assertIs(result["enabled"], False)

    def test_final_name_symlink_swap_before_rename_never_writes_foreign_object(self):
        store = self.store()
        target = self.base / "foreign-target"
        target.write_bytes(b"preserve")
        def sync(fd):
            result = self.real_fsync(fd)
            if self.fd_path(fd).name.endswith(".writing"):
                self.path().symlink_to(target)
            return result
        with patch.object(os, "fsync", side_effect=sync):
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.assertEqual(target.read_bytes(), b"preserve")
        self.assertTrue(self.path(".pending").exists())

    def test_cleanup_attempts_every_owned_fd_independently_and_redacts_errors(self):
        store = self.store()
        owned = [store._lock, *reversed(store._pins)]
        called = []
        def close(fd):
            called.append(fd)
            self.real_close(fd)
            if fd == owned[0]:
                raise OSError("private-secret-close-error")
        with patch.object(os, "close", side_effect=close):
            self.code("UNCONFIRMED", store.close)
        self.assertEqual(called, owned)
        self.code("CLOSED", lambda: store.commit(self.first, self.value()))

    def test_reentrant_and_inherited_calls_cannot_start_another_write(self):
        store = self.store()
        entered = False
        def sync(fd):
            nonlocal entered
            if not entered:
                entered = True
                self.code("BUSY", lambda: store.commit(self.second, self.value()))
            return self.real_fsync(fd)
        with patch.object(os, "fsync", side_effect=sync):
            store.commit(self.first, self.value())
        with patch.object(os, "getpid", return_value=os.getpid() + 1):
            self.code("UNCONFIRMED", lambda: store.commit(self.second, self.value()))
        self.assertFalse(self.path(key=self.other_key).exists())


    def test_root_fspath_callbacks_are_not_invoked_and_unknown_ack_is_explicit(self):
        calls = []
        class Root:
            def __fspath__(_self):
                calls.append(1)
                return str(self.root)
        self.code("INVALID", lambda: subject.ReadUsageStore(Root(), self.entries))
        self.assertEqual(calls, [])
        store = self.store()
        store.commit(self.first, self.value())
        self.assertEqual(store.read_evidence(self.first)["acknowledgement"], "unknown")


    def test_malformed_owned_commit_poison_blocks_later_higher_epoch_without_disk_change(self):
        store = self.store()
        store.commit(self.first, self.value(epoch=1, enabled=False))
        before = self.path().read_bytes()
        malformed = self.value(epoch=2)
        malformed["enabled"] = "private-malformed-secret"
        self.code("INVALID", lambda: store.commit(self.first, malformed))
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value(epoch=3)))
        self.assertEqual(self.path().read_bytes(), before)
        self.assertFalse(self.path(".pending").exists())
        self.assertFalse(self.path(".writing").exists())
        # Record validation poisoning is per mapped conversation, not a reason
        # to lose another approved identity's independently serialized state.
        store.commit(self.second, self.value(enabled=False))
        self.assertEqual(store.read_evidence(self.second)["state"], "recorded-off")

    def test_unknown_conversation_is_denied_before_malformed_value_and_cannot_poison_known(self):
        store = self.store()
        self.code("DENIED", lambda: store.commit(object(), {"private": "secret"}))
        store.commit(self.first, self.value(enabled=False))
        self.assertEqual(store.read_evidence(self.first)["state"], "recorded-off")


    def test_expected_root_pin_matches_before_mutation_and_keeps_caller_owned_fd(self):
        owner = self.owner_fd(self.root)
        expected = subject._identity(owner)
        store = self.store(expected_root_fd=owner)
        self.assertNotEqual(store._expected_fd, owner)
        self.assertEqual(subject._identity(store._expected_fd), expected)
        self.assertTrue(fcntl.fcntl(store._expected_fd, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)
        store.commit(self.first, self.value(enabled=False))
        store.close()
        self.assertEqual(subject._identity(owner), expected)
        self.assertEqual(json.loads(self.path().read_bytes())["enabled"], False)

    def test_borrowed_root_fd_can_close_and_reuse_without_rebinding_owned_pin(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        pinned = subject._identity(store._expected_fd)
        self.close_owner(owner)
        foreign = self.base / "foreign-root"
        foreign.mkdir(mode=0o700)
        reused = self.owner_fd(foreign)
        self.assertEqual(subject._identity(store._expected_fd), pinned)
        store.commit(self.first, self.value())
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertIs(store.read_evidence(self.first)["enabled"], False)
        self.assertNotEqual(subject._identity(reused), pinned)

    def test_mismatched_expected_root_rejects_before_namespace_lock_or_fsync(self):
        other = self.base / "other-root"
        other.mkdir(mode=0o700)
        owner = self.owner_fd(other)
        with patch.object(subject.ReadUsageStore, "_namespace", side_effect=AssertionError("no namespace before FD match")) as namespace, patch.object(os, "fsync") as sync:
            self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=owner))
        namespace.assert_not_called()
        sync.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(list(other.iterdir()), [])
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))

    def test_expected_fd_invalid_types_never_coerce_or_mutate(self):
        calls = []
        class Descriptor:
            def __index__(_self):
                calls.append(1)
                return 0
        for value in (True, False, -1, 0, 1, 2, 1.5, "3", 2147483648, Descriptor()):
            self.code("INVALID", lambda: self.store(expected_root_fd=value))
        self.assertEqual(calls, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_closed_or_non_directory_expected_fd_cannot_create_lock(self):
        fd = self.owner_fd(self.root)
        self.close_owner(fd)
        self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=fd))
        regular = self.base / "regular-fixture"
        regular.write_bytes(b"unchanged")
        file_fd = self.owner_fd(regular)
        self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=file_fd))
        self.assertEqual(regular.read_bytes(), b"unchanged")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_path_replaced_before_constructor_cannot_mutate_new_or_original_root(self):
        owner = self.owner_fd(self.root)
        old = self.base / "old-root"
        self.root.rename(old)
        self.root.mkdir(mode=0o700)
        self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=owner))
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(list(old.iterdir()), [])
        self.assertEqual(subject._identity(owner), (old.stat().st_dev, old.stat().st_ino))

    def test_matching_fd_does_not_allow_a_symlink_in_the_supplied_root_path(self):
        owner = self.owner_fd(self.root)
        alias = self.base / "root-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.code("UNCONFIRMED", lambda: self.store(root=alias, expected_root_fd=owner))
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))

    def test_owned_expected_pin_replacement_poison_is_global_and_never_rebinds(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        other = self.base / "foreign-root"
        other.mkdir(mode=0o700)
        foreign = self.owner_fd(other)
        pin = store._expected_fd
        os.dup2(foreign, pin, inheritable=False)  # Replace only the store's own test FD.
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        self.code("UNCONFIRMED", lambda: store.commit(self.second, self.value()))
        self.assertEqual(list(other.iterdir()), [])
        self.assertFalse(self.path().exists())
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))
        self.assertTrue(stat.S_ISDIR(os.fstat(foreign).st_mode))

    def test_expected_pin_permission_change_rejects_before_any_record_write(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        os.chmod(self.root, 0o755)  # Only this fixture-owned root, never HOME.
        try:
            self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        finally:
            os.chmod(self.root, 0o700)
        self.code("UNCONFIRMED", lambda: store.commit(self.second, self.value()))
        self.assertFalse(self.path().exists())

    def test_expected_pin_cleanup_failure_closes_other_owned_fds_not_callers(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        pin = store._expected_fd
        owned = [store._lock, pin, *reversed(store._pins)]
        calls = []
        def close(fd):
            calls.append(fd)
            self.real_close(fd)
            if fd == pin:
                raise OSError("owned fixture expected pin close failed")
        with patch.object(os, "close", side_effect=close):
            self.code("UNCONFIRMED", store.close)
        self.assertEqual(calls, owned)
        self.assertNotIn(owner, calls)
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))


    def test_root_rename_during_constructor_scan_is_detected_before_lock_mutation(self):
        owner = self.owner_fd(self.root)
        original = self.base / "original-root"
        real_namespace = subject.ReadUsageStore._namespace
        changed = False
        def scan(store):
            nonlocal changed
            real_namespace(store)
            if not changed:
                changed = True
                self.root.rename(original)
                self.root.mkdir(mode=0o700)
        with patch.object(subject.ReadUsageStore, "_namespace", scan), patch.object(os, "fsync") as sync:
            self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=owner))
        sync.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(list(original.iterdir()), [])
        self.assertEqual(subject._identity(owner), (original.stat().st_dev, original.stat().st_ino))


    def test_caller_owned_fd_numeric_reuse_cannot_rebind_store_expected_pin(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        original_identity = subject._identity(store._expected_fd)
        foreign = self.base / "foreign-reused-root"
        foreign.mkdir(mode=0o700)
        foreign_fd = self.owner_fd(foreign)
        # Replace only a descriptor this fixture still exclusively owns, not a
        # free number that another subsystem could have acquired after close.
        os.dup2(foreign_fd, owner, inheritable=False)
        self.assertEqual(subject._identity(owner), subject._identity(foreign_fd))
        self.assertNotEqual(subject._identity(owner), original_identity)
        store.commit(self.first, self.value(enabled=False))
        self.assertEqual(subject._identity(store._expected_fd), original_identity)
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertEqual(json.loads(self.path().read_bytes())["enabled"], False)

    def test_rename_after_prelock_guard_confines_lock_to_original_and_refuses(self):
        owner = self.owner_fd(self.root)
        original = self.base / "post-guard-original"
        real_guard = subject.ReadUsageStore._root_guard
        changed = False
        def guard(store):
            nonlocal changed
            real_guard(store)
            if not changed:
                changed = True
                self.root.rename(original)
                self.root.mkdir(mode=0o700)
        with patch.object(subject.ReadUsageStore, "_root_guard", guard):
            self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=owner))
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual({entry.name for entry in original.iterdir()}, {subject.ReadUsageStore.LOCK})
        self.assertEqual(subject._identity(owner), (original.stat().st_dev, original.stat().st_ino))
        self.assertFalse((original / (self.key + ".json")).exists())

    def test_expected_fd_survives_busy_and_unknown_namespace_constructor_cleanup(self):
        owner = self.owner_fd(self.root)
        store = self.store(expected_root_fd=owner)
        store.commit(self.first, self.value(enabled=False))
        before = self.path().read_bytes()
        fd_count = len(os.listdir("/proc/self/fd"))
        self.code("BUSY", lambda: self.store(expected_root_fd=owner))
        self.assertEqual(len(os.listdir("/proc/self/fd")), fd_count)
        self.assertEqual(self.path().read_bytes(), before)
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))
        store.close()
        unknown = self.root / "unknown-owner-fixture"
        unknown.write_bytes(b"preserve")
        fd_count = len(os.listdir("/proc/self/fd"))
        self.code("UNCONFIRMED", lambda: self.store(expected_root_fd=owner))
        self.assertEqual(len(os.listdir("/proc/self/fd")), fd_count)
        self.assertEqual(unknown.read_bytes(), b"preserve")
        self.assertEqual(self.path().read_bytes(), before)
        self.assertTrue(stat.S_ISDIR(os.fstat(owner).st_mode))


    def test_session_seal_real_fsync_order_and_permanent_default_constructor_fence(self):
        store = self.store()
        events = []
        def fsync(fd):
            path = self.fd_path(fd)
            if path.name == store.SESSION: events.append("marker")
            if path == self.root: events.append("root")
            return self.real_fsync(fd)
        with patch.object(os, "fsync", side_effect=fsync): store._seal_session()
        self.assertEqual(events, ["marker", "root"])
        marker = self.root / store.SESSION
        identity = (marker.stat().st_dev, marker.stat().st_ino)
        self.assertEqual(marker.read_bytes(), store.SESSION_BYTES)
        store.commit(self.first, self.value())
        store.commit(self.first, self.value(2, False))
        store.close()
        self.assertEqual((marker.stat().st_dev, marker.stat().st_ino), identity)
        self.assertEqual(marker.read_bytes(), store.SESSION_BYTES)
        self.code("UNCONFIRMED", self.store)

    def test_session_seal_rejects_existing_lock_or_previous_data_without_adoption(self):
        first = self.store(); first.close()
        second = self.store()
        self.code("UNCONFIRMED", second._seal_session)
        self.assertFalse((self.root / second.SESSION).exists())

    def test_session_seal_fsync_failures_keep_marker_and_refuse_reopen(self):
        store = self.store()
        def fsync(fd):
            if self.fd_path(fd).name == store.SESSION: raise OSError("Owned marker fsync failure")
            return self.real_fsync(fd)
        with patch.object(os, "fsync", side_effect=fsync): self.code("UNCONFIRMED", store._seal_session)
        self.assertTrue((self.root / store.SESSION).exists())
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        store.close()
        self.code("UNCONFIRMED", self.store)

    def test_session_marker_swap_and_content_change_poison_live_store(self):
        store = self.store(); store._seal_session()
        marker = self.root / store.SESSION
        marker.rename(self.base / "original-session")
        marker.write_bytes(store.SESSION_BYTES); marker.chmod(0o600)
        self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
        store.close()
        self.code("UNCONFIRMED", self.store)

    def test_session_marker_cannot_be_sealed_twice_or_cleared_by_close(self):
        store = self.store(); store._seal_session()
        marker = self.root / store.SESSION
        before = marker.read_bytes()
        self.code("UNCONFIRMED", store._seal_session)
        store.close()
        self.assertEqual(marker.read_bytes(), before)
        self.assertFalse(hasattr(store, "clear_session"))

    def test_live_session_namespace_extra_slot_is_owned_instance_only(self):
        entries = tuple((object(), str(index)*64) for index in range(4))
        store = self.store(entries=entries); store._seal_session()
        for _owner, key in entries:
            for suffix in (".json", ".pending", ".writing"):
                path = self.root / (key + suffix)
                path.write_bytes(b"x"); path.chmod(0o600)
        self.assertEqual(len(list(self.root.iterdir())), 14)
        store._guard()
        store.close()
        self.code("UNCONFIRMED", lambda: self.store(entries=entries))


    def test_session_interrupted_file_or_directory_fsync_never_returns_ready(self):
        for stage in ("file", "directory"):
            for error_type in (InterruptedError, KeyboardInterrupt):
                root = self.base / ("interrupted-" + stage + "-" + error_type.__name__)
                root.mkdir(mode=0o700)
                store = self.store(root=root)
                root_info = root.stat()
                hits = []
                def fsync(fd):
                    self.real_fsync(fd)
                    info = os.fstat(fd)
                    if (stage == "file" and self.fd_path(fd).name == store.SESSION
                            or stage == "directory" and (info.st_dev, info.st_ino) == (root_info.st_dev, root_info.st_ino)):
                        hits.append(stage)
                        raise error_type("Owned session fsync interruption")
                with patch.object(os, "fsync", side_effect=fsync):
                    self.code("UNCONFIRMED", store._seal_session)
                self.assertEqual(hits, [stage], "Targeted fsync interruption was not exercised exactly once")
                marker = root / store.SESSION
                self.assertEqual(marker.read_bytes(), store.SESSION_BYTES)
                self.code("UNCONFIRMED", lambda: store.commit(self.first, self.value()))
                store.close()
                self.code("UNCONFIRMED", lambda: self.store(root=root))

    def test_session_zero_write_keeps_empty_marker_and_never_allows_reopen(self):
        store = self.store()
        calls = []
        native = os.write
        def bounded_write(fd, data):
            if self.fd_path(fd).name == store.SESSION:
                calls.append(len(data)); return 0
            return native(fd, data)
        with patch.object(os, "write", side_effect=bounded_write): self.code("UNCONFIRMED", store._seal_session)
        self.assertEqual(calls, [len(store.SESSION_BYTES)])
        marker = self.root / store.SESSION
        self.assertEqual(marker.read_bytes(), b"")
        self.assertFalse(self.path().exists())
        store.close()
        self.code("UNCONFIRMED", self.store)
        self.assertTrue(marker.exists())

    def test_session_positive_partial_writes_finish_exactly_before_seal_ready(self):
        store = self.store()
        native = os.write
        counts = []
        def write(fd, data):
            if self.fd_path(fd).name == store.SESSION:
                count = native(fd, data[:2]); counts.append(count); return count
            return native(fd, data)
        with patch.object(os, "write", side_effect=write): store._seal_session()
        self.assertGreater(len(counts), 1)
        self.assertEqual(sum(counts), len(store.SESSION_BYTES))
        self.assertEqual((self.root / store.SESSION).read_bytes(), store.SESSION_BYTES)
        store.commit(self.first, self.value())
        self.assertEqual(json.loads(self.path().read_text())["epoch"], 1)

    def test_session_marker_close_uncertainty_preserves_fence_and_closes_other_owned_fds(self):
        store = self.store(); store._seal_session()
        marker_fd, lock_fd = store._session_fd, store._lock
        marker = self.root / store.SESSION
        identity = (marker.stat().st_dev, marker.stat().st_ino)
        def close(fd):
            self.real_close(fd)
            if fd == marker_fd: raise OSError("Owned marker close uncertainty")
        with patch.object(os, "close", side_effect=close): self.code("UNCONFIRMED", store.close)
        for fd in (marker_fd, lock_fd):
            with self.assertRaises(OSError): os.fstat(fd)
        self.assertEqual((marker.stat().st_dev, marker.stat().st_ino), identity)
        self.assertEqual(marker.read_bytes(), store.SESSION_BYTES)
        self.code("UNCONFIRMED", self.store)


if __name__ == "__main__":
    unittest.main()
