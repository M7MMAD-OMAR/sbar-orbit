#!/usr/bin/python3
"""Typed fresh manager reads and failure cleanup, without a real bus."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from gi.repository import Gio, GLib
from src.native.lease import LeaseError, manager_properties


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.unit = "orbit-native-" + "a" * 32 + ".service"
        self.path = "/org/freedesktop/systemd1/unit/" + self.unit.replace("-", "_2d").replace(".", "_2e")
        self.connection = Mock()
        self.values = {"InvocationID": GLib.Variant("ay", [1] * 16),
                       "ActiveState": GLib.Variant("s", "active"),
                       "ControlGroup": GLib.Variant("s", "/budget/" + self.unit)}
        self.connection.call_sync.side_effect = self.reply
        self.factory = Mock(return_value=self.connection)
        self.gio = Mock(Cancellable=Gio.Cancellable, DBusConnectionFlags=Gio.DBusConnectionFlags,
                        DBusCallFlags=Gio.DBusCallFlags)
        self.gio.DBusConnection.new_for_address_sync = self.factory

    def reply(self, destination, path, interface, method, arguments, reply_type, flags, timeout, cancel):
        self.assertEqual(destination, "org.freedesktop.systemd1")
        self.assertEqual(flags, Gio.DBusCallFlags.NO_AUTO_START)
        self.assertEqual(timeout, 3000)
        if method == "GetUnit":
            self.assertEqual(arguments.unpack(), (self.unit,))
            return GLib.Variant("(o)", (self.path,))
        self.assertEqual(path, self.path)
        requested_interface, name = arguments.unpack()
        self.assertEqual(requested_interface, "org.freedesktop.systemd1." +
                         ("Service" if name == "ControlGroup" else "Unit"))
        return GLib.Variant("(v)", (self.values[name],))

    def read(self):
        return manager_properties(self.unit, {"DBUS_SESSION_BUS_ADDRESS": "unix:path=/fixed/bus"}, self.gio, GLib)

    def test_every_read_connects_and_observes_new_invocation(self):
        self.assertEqual(self.read()["InvocationID"], "01" * 16)
        self.values["InvocationID"] = GLib.Variant("ay", [2] * 16)
        self.assertEqual(self.read()["InvocationID"], "02" * 16)
        self.assertEqual(self.factory.call_count, 2)
        self.assertEqual(self.connection.close_sync.call_count, 2)

    def test_wrong_unit_and_typed_properties_are_refused_and_closed(self):
        self.path += "_other"
        with self.assertRaises(LeaseError):
            self.read()
        self.path = self.path.removesuffix("_other")
        for bad in (GLib.Variant("s", "01" * 16), GLib.Variant("ay", [1] * 15)):
            self.values["InvocationID"] = bad
            with self.assertRaises(LeaseError):
                self.read()
        self.assertEqual(self.connection.close_sync.call_count, 3)

    def test_query_and_cleanup_errors_are_both_retained(self):
        self.connection.call_sync.side_effect = RuntimeError("read failed")
        self.connection.close_sync.side_effect = RuntimeError("close failed")
        with self.assertRaises(LeaseError) as raised:
            self.read()
        self.assertEqual(len(raised.exception.__cause__.exceptions), 2)

    def test_cancelled_query_cannot_return_a_valid_result(self):
        original = self.reply
        def cancelled(*arguments):
            arguments[-1].cancel()
            return original(*arguments)
        self.connection.call_sync.side_effect = cancelled
        with self.assertRaises(LeaseError):
            self.read()
        self.connection.close_sync.assert_called_once()


if __name__ == "__main__":
    unittest.main()
