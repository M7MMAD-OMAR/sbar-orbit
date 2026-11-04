"""Mocked bootstrap syscalls only: no actual signals, sockets, exec or provider."""
import contextlib
import errno
import io
import os
from pathlib import Path
import signal
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_bootstrap as subject


class ExecReached(BaseException):
    pass


class StoppedForAdmission(BaseException):
    pass


class ReaderBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.exec_calls = []
        self.runtime = "/owned-runtime"
        self.display = self.runtime + "/wayland-0"
        self.owner_uid = 1000
        self.directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000, st_dev=1, st_ino=2)
        self.socket = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=1000, st_dev=1, st_ino=3)
        self.provider = (9, 10, 0, stat.S_IFREG | 0o755, 100, 200, 300)
        self.real_provider_identity = subject._provider_identity
        self.patch(sys, "platform", "linux")
        self.environment = {"XDG_RUNTIME_DIR": self.runtime, "WAYLAND_DISPLAY": self.display,
                            "LD_PRELOAD": "private-injection", "PYTHONPATH": "private-module-path",
                            "PATH": "/private/bin", "LANG": "private-language", "ORBIT_SECRET": "private-request-secret"}
        operation = patch.dict(os.environ, self.environment, clear=True)
        operation.start()
        self.addCleanup(operation.stop)
        self.patch(os, "getuid", return_value=self.owner_uid)
        self.patch(os, "getpid", return_value=999)
        self.parent = self.patch(os, "getppid", return_value=111)
        self.patch(os.path, "realpath", side_effect=lambda path: path)
        self.lstat = self.patch(os, "lstat", side_effect=self.lookup)
        self.prctl = Mock(side_effect=self.arm_parent_death)
        self.libc = self.patch(subject.ctypes, "CDLL", return_value=SimpleNamespace(prctl=self.prctl))
        self.provider_check = self.patch(subject, "_provider_identity", side_effect=self.provider_identity)
        self.unmask = self.patch(signal, "pthread_sigmask", side_effect=lambda *args: self.events.append(("unmask", args)))
        self.handler = self.patch(signal, "signal", side_effect=lambda *args: self.events.append(("handler", args)))
        self.alarm = self.patch(signal, "alarm", side_effect=lambda value: self.events.append(("alarm", value)))
        self.stop = self.patch(os, "kill", side_effect=self.stopped)
        self.execve = self.patch(os, "execve", side_effect=self.executed)

    def patch(self, target, name, value=None, **kwargs):
        operation = patch.object(target, name, value, **kwargs) if value is not None else patch.object(target, name, **kwargs)
        result = operation.start()
        self.addCleanup(operation.stop)
        return result

    def lookup(self, path):
        if path == self.runtime:
            return self.directory
        if path == self.display:
            return self.socket
        raise OSError("private-path-secret")

    def arm_parent_death(self, *args):
        self.events.append(("pdeath", args))
        return 0

    def provider_identity(self):
        self.events.append(("provider-identity", self.provider))
        return self.provider

    def stopped(self, pid, sig):
        self.assertEqual((pid, sig), (999, signal.SIGSTOP))
        self.assertEqual(self.exec_calls, [])
        self.events.append(("stop", (pid, sig)))
        # Returning here simulates a separate trusted parent resuming after admission.

    def executed(self, path, args, environment):
        self.events.append(("exec", path))
        self.exec_calls.append((path, args, environment))
        raise ExecReached()

    def run_success(self, arguments=None):
        with self.assertRaises(ExecReached):
            subject.main(["111", "a1b2"] if arguments is None else arguments)
        self.assertEqual(len(self.exec_calls), 1)
        return self.exec_calls[0]

    def assert_refused(self, arguments):
        self.assertEqual(subject.main(arguments), 70)
        self.execve.assert_not_called()

    def test_fixed_exec_argv_and_environment_do_not_inherit_injection(self):
        path, args, environment = self.run_success()
        self.assertEqual(path, "/usr/bin/grim")
        self.assertEqual(args, ["/usr/bin/grim", "-T", "a1b2", "-"])
        self.assertEqual(environment, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": self.runtime, "WAYLAND_DISPLAY": self.display})
        self.assertNotIn("private", str(environment))

    def test_pdeath_guard_and_alarm_are_armed_before_self_stop_and_exec(self):
        self.run_success()
        names = [name for name, _ in self.events]
        self.assertLess(names.index("pdeath"), names.index("unmask"))
        self.assertLess(names.index("unmask"), names.index("alarm"))
        self.assertLess(names.index("alarm"), names.index("stop"))
        self.assertLess(names.index("stop"), names.index("exec"))
        self.prctl.assert_called_once_with(1, signal.SIGKILL, 0, 0, 0)
        self.unmask.assert_called_once_with(signal.SIG_UNBLOCK, {signal.SIGALRM, signal.SIGKILL, signal.SIGSTOP})
        self.handler.assert_called_once_with(signal.SIGALRM, signal.SIG_DFL)
        self.alarm.assert_called_once_with(5)
        self.stop.assert_called_once_with(999, signal.SIGSTOP)

    def test_bootstrap_cannot_reach_provider_exec_while_waiting_for_parent_admission(self):
        self.stop.side_effect = StoppedForAdmission()
        with self.assertRaises(StoppedForAdmission):
            subject.main(["111", "a1b2"])
        self.execve.assert_not_called()
        self.provider_check.assert_called_once()
        self.prctl.assert_called_once()

    def test_nonlinux_refuses_before_parent_or_provider_calls(self):
        with patch.object(sys, "platform", "darwin"):
            self.assert_refused(["111", "a1b2"])
        self.parent.assert_not_called()
        self.libc.assert_not_called()
        self.stop.assert_not_called()

    def test_exact_arg_count_and_string_types_no_generic_command(self):
        for arguments in ([], ["111"], ["111", "a1b2", "/bin/sh"], "111 a1b2", {"parent": "111"}, [111, "a1b2"], ["111", True]):
            self.assert_refused(arguments)
        self.stop.assert_not_called()
        self.libc.assert_not_called()

    def test_parent_argument_is_strict_positive_bounded_decimal(self):
        for parent in ("0", "1", "0111", "-111", "+111", " 111", "111\n", "2147483648", "99999999999"):
            self.assert_refused([parent, "a1b2"])
        self.stop.assert_not_called()

    def test_selector_accepts_only_stable_lowercase_hex_not_address_or_commands(self):
        for stable in ("", "0xabc", "ABC", "a" * 17, "abc;sh", "--help", "abc\n", "/tmp/socket", "private-secret"):
            self.assert_refused(["111", stable])
        self.stop.assert_not_called()

    def test_tuple_and_sys_argv_paths_keep_fixed_target(self):
        self.run_success(("111", "0000a"))
        self.assertEqual(self.exec_calls[0][1][2], "0000a")
        self.exec_calls.clear()
        self.execve.reset_mock()
        with patch.object(sys, "argv", ["reader_bootstrap.py", "111", "f"]):
            with self.assertRaises(ExecReached):
                subject.main()
        self.assertEqual(self.exec_calls[0][1], ["/usr/bin/grim", "-T", "f", "-"])

    def test_wrong_parent_before_arming_never_stops_or_executes(self):
        self.parent.return_value = 222
        self.assert_refused(["111", "a1b2"])
        self.prctl.assert_not_called()
        self.stop.assert_not_called()

    def test_parent_death_race_after_arming_never_stops_or_executes(self):
        self.parent.side_effect = [111, 222]
        self.assert_refused(["111", "a1b2"])
        self.prctl.assert_called_once()
        self.stop.assert_not_called()

    def test_parent_replacement_after_resume_never_executes(self):
        self.parent.side_effect = [111, 111, 222]
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_called_once()

    def test_prctl_error_or_failure_return_refuses_before_stop(self):
        self.prctl.side_effect = None
        self.prctl.return_value = -1
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()
        self.prctl.side_effect = OSError("private-prctl-secret")
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_environment_identity_is_rechecked_after_resume(self):
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": self.runtime, "WAYLAND_DISPLAY": self.display}
        with patch.object(subject, "_environment", side_effect=[(environment, (1, 2, 1, 3)), (environment, (1, 2, 1, 4))]):
            self.assert_refused(["111", "a1b2"])
        self.stop.assert_called_once()

    def test_provider_identity_is_rechecked_immediately_before_exec(self):
        self.provider_check.side_effect = [self.provider, self.provider[:-1] + (301,)]
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_called_once()
        self.assertEqual(self.provider_check.call_count, 2)

    def test_runtime_directory_requires_canonical_absolute_private_owned_directory(self):
        for runtime in ("relative", "/", self.runtime + "/", self.runtime + "/../alias", self.runtime + "\0"):
            # Use a plain mapping so the NUL reaches validation without an OS environ write.
            with patch.object(os, "environ", {**dict(os.environ), "XDG_RUNTIME_DIR": runtime}):
                self.assert_refused(["111", "a1b2"])
        for mode, uid in ((stat.S_IFDIR | 0o755, 1000), (stat.S_IFDIR | 0o700, 1001), (stat.S_IFREG | 0o600, 1000)):
            self.directory.st_mode, self.directory.st_uid = mode, uid
            self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_runtime_symlink_or_alias_is_not_followed(self):
        with patch.object(os.path, "realpath", side_effect=lambda path: "/elsewhere" if path == self.runtime else path):
            self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_display_must_be_absolute_canonical_direct_child_socket(self):
        for display in ("wayland-0", "/other-runtime/wayland-0", self.runtime + "/child/wayland-0", self.runtime + "/../wayland-0", self.runtime + "/.", self.runtime + "/bad name"):
            with patch.dict(os.environ, {"WAYLAND_DISPLAY": display}):
                self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_display_symlink_wrong_uid_or_regular_file_refuses(self):
        with patch.object(os.path, "realpath", side_effect=lambda path: "/other/socket" if path == self.display else path):
            self.assert_refused(["111", "a1b2"])
        for mode, uid in ((stat.S_IFREG | 0o600, 1000), (stat.S_IFSOCK | 0o600, 1001)):
            self.socket.st_mode, self.socket.st_uid = mode, uid
            self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_unmask_or_alarm_setup_failure_never_stops_or_executes(self):
        self.unmask.side_effect = OSError("private-unmask-secret")
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()
        self.unmask.side_effect = None
        self.alarm.side_effect = OSError("private-alarm-secret")
        self.assert_refused(["111", "a1b2"])
        self.stop.assert_not_called()

    def test_stop_or_exec_error_is_fixed_failure_with_no_secret_output(self):
        out, err = io.StringIO(), io.StringIO()
        self.stop.side_effect = OSError("private-stop-secret")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assert_refused(["111", "a1b2"])
        self.stop.side_effect = self.stopped
        self.execve.side_effect = OSError("private-exec-secret")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(subject.main(["111", "a1b2"]), 70)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "")

    def test_mock_exec_return_cannot_advertise_success(self):
        self.execve.side_effect = None
        self.execve.return_value = None
        self.assertEqual(subject.main(["111", "a1b2"]), 70)
        self.execve.assert_called_once()

    def provider_info(self, **changes):
        values = dict(st_dev=9, st_ino=10, st_uid=0, st_mode=stat.S_IFREG | 0o755,
                      st_size=100, st_mtime_ns=200, st_ctime_ns=300)
        values.update(changes)
        return SimpleNamespace(**values)

    def check_real_provider(self, info=None, named=None, capability_error=None, capability_value=None):
        info = self.provider_info() if info is None else info
        named = info if named is None else named
        absent = OSError(errno.ENODATA, "No file capabilities")
        with patch.object(os, "open", return_value=123) as opened, patch.object(os, "fstat", return_value=info), \
                patch.object(os, "stat", return_value=named), patch.object(os, "close") as closed, \
                patch.object(os, "getxattr", side_effect=absent if capability_error is None and capability_value is None else capability_error,
                             return_value=capability_value):
            try:
                return self.real_provider_identity()
            finally:
                opened.assert_called_once_with("/usr/bin/grim", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                closed.assert_called_once_with(123)

    def test_nonprivileged_root_owned_fixed_renderer_is_accepted_without_execution(self):
        self.assertEqual(self.check_real_provider(), self.provider)
        self.assertEqual(self.check_real_provider(capability_error=OSError(errno.ENOTSUP, "No xattr support")), self.provider)
        self.execve.assert_not_called()
        self.stop.assert_not_called()

    def test_renderer_rejects_setid_writable_nonroot_nonregular_and_nonexecutable_files(self):
        for info in (self.provider_info(st_uid=1000), self.provider_info(st_mode=stat.S_IFREG | 0o4755),
                     self.provider_info(st_mode=stat.S_IFREG | 0o2755), self.provider_info(st_mode=stat.S_IFREG | 0o775),
                     self.provider_info(st_mode=stat.S_IFREG | 0o757), self.provider_info(st_mode=stat.S_IFREG | 0o644),
                     self.provider_info(st_mode=stat.S_IFDIR | 0o755)):
            with self.assertRaises(ValueError):
                self.check_real_provider(info=info)

    def test_renderer_fd_name_replacement_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check_real_provider(named=self.provider_info(st_ino=11))

    def test_renderer_file_capabilities_or_unknown_xattr_errors_are_rejected(self):
        for value in (b"", b"private-capability"):
            with self.assertRaises(ValueError):
                self.check_real_provider(capability_value=value)
        for code in (errno.EPERM, errno.EIO):
            with self.assertRaises(OSError):
                self.check_real_provider(capability_error=OSError(code, "private-xattr-secret"))

    def test_renderer_symlink_or_alias_is_rejected_before_open(self):
        with patch.object(os.path, "realpath", return_value="/other/grim"), patch.object(os, "open") as opened:
            with self.assertRaises(ValueError):
                self.real_provider_identity()
            opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
