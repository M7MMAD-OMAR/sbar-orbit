"""Private lab path regression checks without a compositor or owner display."""
import os
from pathlib import Path
import shutil
import socket
import tempfile
import unittest

from lab import guard


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.lab = Path(tempfile.mkdtemp(prefix="gl-", dir="/var/tmp"))
        self.run = self.lab / "run"
        self.run.mkdir(mode=0o700)
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.bind(str(self.run / "wayland-0"))
        self.env = {"XDG_RUNTIME_DIR": str(self.run),
                    "WAYLAND_DISPLAY": "wayland-0",
                    "DBUS_SESSION_BUS_ADDRESS": f"unix:path={self.run}/bus"}

    def tearDown(self):
        self.socket.close()
        shutil.rmtree(self.lab)

    def test_disk_lab_is_accepted(self):
        guard(self.env)

    def test_cross_lab_bus_is_refused(self):
        with self.assertRaises(SystemExit):
            guard(dict(self.env, DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/gl-other/run/bus"))

    def test_socket_symlink_is_refused(self):
        (self.run / "linked").symlink_to("wayland-0")
        with self.assertRaises(SystemExit):
            guard(dict(self.env, WAYLAND_DISPLAY="linked"))

    def test_absolute_display_is_refused(self):
        with self.assertRaises(SystemExit):
            guard(dict(self.env, WAYLAND_DISPLAY=str(self.run / "wayland-0")))

    def test_public_runtime_is_refused(self):
        self.run.chmod(0o755)
        with self.assertRaises(SystemExit):
            guard(self.env)

    def test_owner_display_variable_is_refused(self):
        with self.assertRaises(SystemExit):
            guard(dict(self.env, DISPLAY=""))


if __name__ == "__main__":
    unittest.main()
