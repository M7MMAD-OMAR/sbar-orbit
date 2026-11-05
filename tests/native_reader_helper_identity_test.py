"""Private owned filesystem fixtures, no helper execution or system installation."""
import errno
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_helper_identity as subject


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orbit-helper-id-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.parent = self.root / "usr/libexec/sbar-orbit"
        self.parent.mkdir(parents=True, mode=0o700)
        for p in (self.root, self.root / "usr", self.root / "usr/libexec", self.parent):
            p.chmod(0o700)
        self.path = self.parent / "reader-helper"
        self.data = b"\x7fELF" + b"fixture-owned-binary-content"
        self.path.write_bytes(self.data)
        self.path.chmod(0o700)
        self.digest = hashlib.sha256(self.data).digest()
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.addCleanup(os.close, self.root_fd)
        self.pins = []
        self.addCleanup(self.close_pins)

    def close_pins(self):
        for pin in self.pins:
            pin.close()

    def pin(self, digest=None):
        pin = subject._walk(self.root_fd, os.getuid(), self.digest if digest is None else digest)
        self.pins.append(pin)
        return pin

    def test_owned_fixture_pins_and_revalidates(self):
        pin = self.pin()
        self.assertIsNone(pin.revalidate())
        self.assertFalse(os.get_inheritable(pin._fd))
        self.assertFalse(any(os.get_inheritable(fd) for fd in pin._directories))
        self.assertFalse(hasattr(pin, "fileno"))

    def test_wrong_digest_refused(self):
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin(bytes(32))

    def test_invalid_digest_type_refused(self):
        for digest in (None, b"x", bytearray(32), "a" * 64):
            with self.assertRaises(subject.ReaderHelperIdentityError):
                subject.open_reader_helper(expected_sha256=digest)

    def test_non_elf_refused(self):
        self.path.write_bytes(b"not an ELF fixture")
        with self.assertRaises(subject.ReaderHelperIdentityError):
            self.pin(hashlib.sha256(self.path.read_bytes()).digest())

    def test_final_symlink_refused(self):
        self.path.unlink()
        self.path.symlink_to("/usr/bin/true")
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_directory_symlink_refused(self):
        self.path.unlink()
        self.parent.rmdir()
        self.parent.symlink_to(self.root)
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_hardlink_refused(self):
        os.link(self.path, self.parent / "other")
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_file_modes_refused(self):
        for mode in (0o720, 0o702, 0o4700, 0o2700, 0o1700, 0o600):
            with self.subTest(mode=mode):
                self.path.chmod(mode)
                with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_writable_ancestor_refused(self):
        self.parent.chmod(0o770)
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_special_bits_on_ancestor_refused(self):
        for mode in (0o4700, 0o2700, 0o1700):
            with self.subTest(mode=mode):
                self.parent.chmod(mode)
                with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()
        self.parent.chmod(0o700)

    def test_root_writable_ancestor_refused(self):
        self.root.chmod(0o777)
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()
        self.root.chmod(0o700)

    def test_directory_metadata_change_during_hash_refused(self):
        original = subject._digest
        def mutate(fd, size):
            result = original(fd, size)
            (self.parent / "marker").write_bytes(b"x")
            return result
        with patch.object(subject, "_digest", side_effect=mutate):
            with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_file_replacement_invalidates_pin(self):
        pin = self.pin()
        self.path.rename(self.parent / "old")
        self.path.write_bytes(self.data)
        self.path.chmod(0o700)
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()

    def test_file_content_change_invalidates_pin(self):
        pin = self.pin()
        self.path.write_bytes(b"\x7fELF" + b"modified owned binary contents")
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()

    def test_ancestor_replacement_invalidates_pin(self):
        pin = self.pin()
        self.parent.rename(self.parent.with_name("old"))
        self.parent.mkdir(mode=0o700)
        self.path.write_bytes(self.data)
        self.path.chmod(0o700)
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()

    def test_removed_path_invalidates_pin(self):
        pin = self.pin()
        self.path.unlink()
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()

    def test_non_cloexec_pinned_descriptor_invalidates(self):
        pin = self.pin()
        os.set_inheritable(pin._fd, True)
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()

    def test_close_idempotent_and_disables_revalidation(self):
        pin = self.pin()
        pin.close()
        pin.close()
        with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()
        os.fstat(self.root_fd)

    def test_close_failure_is_sticky_and_no_retry(self):
        pin = self.pin()
        self.pins.remove(pin)
        original = os.close
        calls = []
        def close(fd):
            calls.append(fd)
            original(fd)
            if len(calls) == 1: raise OSError("private close")
        with patch.object(subject.os, "close", side_effect=close):
            with self.assertRaises(subject.ReaderHelperIdentityError): pin.close()
            count = len(calls)
            with self.assertRaises(subject.ReaderHelperIdentityError): pin.close()
            self.assertEqual(len(calls), count)
        self.assertEqual(count, 5)

    def test_close_serializes_with_revalidation(self):
        pin = self.pin()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        original = subject._digest
        def blocked(fd, size):
            entered.set()
            if not release.wait(1): raise RuntimeError("fixture timeout")
            return original(fd, size)
        errors = []
        def validate():
            try: pin.revalidate()
            except BaseException as error: errors.append(error)
        def close():
            try: pin.close(); closed.set()
            except BaseException as error: errors.append(error)
        with patch.object(subject, "_digest", side_effect=blocked):
            a = threading.Thread(target=validate); a.start()
            self.assertTrue(entered.wait(1))
            b = threading.Thread(target=close); b.start()
            self.assertFalse(closed.wait(0.05))
            release.set(); a.join(2); b.join(2)
        self.assertFalse(a.is_alive())
        self.assertFalse(b.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(closed.is_set())

    def test_capability_xattr_refused(self):
        original = os.getxattr
        def xattr(fd, name):
            if name == "security.capability": return b"present"
            return original(fd, name)
        with patch.object(subject.os, "getxattr", side_effect=xattr):
            with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_acl_xattr_refused(self):
        original = os.getxattr
        def xattr(fd, name):
            if name == "system.posix_acl_access": return b"acl"
            return original(fd, name)
        with patch.object(subject.os, "getxattr", side_effect=xattr):
            with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_xattr_unsupported_refused(self):
        with patch.object(subject.os, "getxattr", side_effect=OSError(errno.ENOTSUP, "private")):
            with self.assertRaises(subject.ReaderHelperIdentityError) as caught: self.pin()
        self.assertNotIn("private", str(caught.exception))
        self.assertIsNone(caught.exception.__context__)

    def test_short_reads_are_bounded_and_supported(self):
        original = os.pread
        def short(fd, size, offset):
            return original(fd, min(size, 2), offset)
        with patch.object(subject.os, "pread", side_effect=short):
            self.pin().revalidate()

    def test_partial_read_refused(self):
        with patch.object(subject.os, "pread", return_value=b""):
            with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_file_size_limit_refused(self):
        with self.path.open("wb") as stream:
            stream.write(b"\x7fELF")
            stream.truncate(subject._MAX_BYTES + 1)
        with self.assertRaises(subject.ReaderHelperIdentityError): self.pin()

    def test_replaced_fd_is_not_accepted_as_original(self):
        pin = self.pin()
        victim = self.root / "other"
        victim.write_bytes(b"different")
        replacement = os.open(victim, os.O_RDONLY | os.O_CLOEXEC)
        os.dup2(replacement, pin._fd, inheritable=False)
        os.close(replacement)
        try:
            with self.assertRaises(subject.ReaderHelperIdentityError): pin.revalidate()
        finally:
            # This fixture intentionally violates private FD ownership; restore
            # a known owned descriptor before its serialized close.
            self.pins.remove(pin)
            pin.close()

    def test_public_fixed_path_refuses_missing_install(self):
        with patch.object(subject.os, "open", side_effect=FileNotFoundError("private missing")):
            with self.assertRaises(subject.ReaderHelperIdentityError) as caught:
                subject.open_reader_helper(expected_sha256=self.digest)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn("private", str(caught.exception))

    def test_public_dispatch_uses_root_owned_fixed_path_and_digest(self):
        sentinel = object()
        with patch.object(subject.os, "open", return_value=83) as opened, \
             patch.object(subject.os, "close") as closed, \
             patch.object(subject, "_walk", return_value=sentinel) as walk:
            self.assertIs(subject.open_reader_helper(expected_sha256=self.digest), sentinel)
        self.assertEqual(opened.call_args.args[0], "/")
        self.assertEqual(subject._PATH, ("usr", "libexec", "sbar-orbit", "reader-helper"))
        walk.assert_called_once_with(83, 0, self.digest)
        closed.assert_called_once_with(83)

    def test_nested_and_file_acls_refuse_at_the_actual_object(self):
        original = os.getxattr
        for target, attr in ((self.parent, "system.posix_acl_access"),
                             (self.parent, "system.posix_acl_default"),
                             (self.path, "system.posix_acl_access")):
            with self.subTest(target=target, attr=attr):
                wanted = target.stat()
                hit = []
                def xattr(fd, name):
                    current = os.fstat(fd)
                    if name == attr and (current.st_dev, current.st_ino) == (wanted.st_dev, wanted.st_ino):
                        hit.append(True)
                        return b"acl"
                    return original(fd, name)
                with patch.object(subject.os, "getxattr", side_effect=xattr):
                    with self.assertRaises(subject.ReaderHelperIdentityError):
                        self.pin()
                self.assertTrue(hit)

    def test_public_root_close_failure_closes_returned_pin(self):
        class Pin:
            closed = False
            def close(self): self.closed = True
        pin = Pin()
        with patch.object(subject.os, "open", return_value=83), \
             patch.object(subject.os, "close", side_effect=OSError("private")), \
             patch.object(subject, "_walk", return_value=pin):
            with self.assertRaises(subject.ReaderHelperIdentityError):
                subject.open_reader_helper(expected_sha256=self.digest)
        self.assertTrue(pin.closed)

    def test_public_api_rejects_path_argument(self):
        with self.assertRaises(TypeError):
            subject.open_reader_helper(expected_sha256=self.digest, path=str(self.path))


if __name__ == "__main__":
    unittest.main()
