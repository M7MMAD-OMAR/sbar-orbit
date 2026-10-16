"""Real self-process mapping checks. These do not load or activate a plugin."""
import mmap
import io
import os
from pathlib import Path
import sys
import tempfile
import signal
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.plugin_owner import mapped_identity
from src.native.mapping import kernel_file_identity
from src.native.plugin_bundle import fingerprint


class NativeMappingTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix='orbit-mapping-', dir=Path(__file__).parent)
        self.root = Path(self.work.name)
        self.path = self.root / 'plugin.so'
        self.payload = b'fixture bytes, never executed\n' * 128
        self.path.write_bytes(self.payload)
        self.directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.stream = self.path.open('rb')
        self.mapping = mmap.mmap(self.stream.fileno(), 0, access=mmap.ACCESS_READ)
        self.bundle = SimpleNamespace(plan={'compositor': [os.getpid(), 0]},
                                      artifact={'path': str(self.path),
                                                'file_identity': [str(value) for value in fingerprint(self.path.stat())]}, fd=self.directory,
                                      verify=self.verify)

    def verify(self):
        if self.path.read_bytes() != self.payload:
            raise RuntimeError('Fixture file content changed')

    def tearDown(self):
        self.mapping.close()
        self.stream.close()
        os.close(self.directory)
        self.work.cleanup()

    def test_exact_file_mapping_is_accepted_on_the_actual_filesystem(self):
        mapped_identity(self.bundle)
        self.assertEqual(self.path.read_bytes(), self.payload)

    def test_replaced_file_cannot_borrow_an_old_mapping(self):
        replacement = self.root / 'replacement'
        replacement.write_bytes(self.payload)
        os.replace(replacement, self.path)
        with self.assertRaises(RuntimeError):
            mapped_identity(self.bundle)

    def test_an_additional_plugin_mapping_is_rejected(self):
        other = self.root / 'ghostinput-other.so'
        other.write_bytes(self.payload)
        with other.open('rb') as stream:
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ):
                with self.assertRaises(RuntimeError):
                    mapped_identity(self.bundle)

    def test_deleted_and_current_plugin_mappings_cannot_coexist(self):
        self.path.unlink()
        self.path.write_bytes(self.payload)
        self.bundle.artifact['file_identity'] = [str(value) for value in fingerprint(self.path.stat())]
        with self.path.open('rb') as stream:
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ):
                with self.assertRaises(RuntimeError):
                    mapped_identity(self.bundle)

    def test_matching_path_and_inode_do_not_replace_the_kernel_device_check(self):
        device, inode = kernel_file_identity(self.stream.fileno())
        with patch('src.native.plugin_owner.kernel_file_identity', return_value=(device ^ 1, inode)):
            with self.assertRaises(RuntimeError):
                mapped_identity(self.bundle)

    def test_matching_path_and_device_do_not_replace_the_kernel_inode_check(self):
        device, inode = kernel_file_identity(self.stream.fileno())
        with patch('src.native.plugin_owner.kernel_file_identity', return_value=(device, inode + 1)):
            with self.assertRaises(RuntimeError):
                mapped_identity(self.bundle)

    def test_a_real_mapping_must_also_match_the_prepared_descriptor(self):
        other = self.root / 'same-bytes'
        other.write_bytes(self.payload)
        self.bundle.artifact['file_identity'] = [str(value) for value in fingerprint(other.stat())]
        with self.assertRaisesRegex(RuntimeError, 'descriptor differs'):
            mapped_identity(self.bundle)

    def test_substituted_fifo_refuses_without_waiting_for_a_writer(self):
        snapshot = Path('/proc/self/maps').read_bytes()
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        child = os.fork()
        if child == 0:
            signal.alarm(2)
            try:
                with patch('builtins.open', return_value=io.BytesIO(snapshot)):
                    mapped_identity(self.bundle)
            except (RuntimeError, ValueError):
                os._exit(0)
            except BaseException:
                os._exit(3)
            os._exit(2)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)


if __name__ == '__main__':
    unittest.main()
