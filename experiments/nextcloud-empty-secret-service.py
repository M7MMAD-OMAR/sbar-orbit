#!/usr/bin/python3
"""Empty Secret Service on an existing owned bus. No host keyring access."""
import json
import os
import re
import signal
import sys
import threading
from pathlib import Path

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

NODE = """<node><interface name='org.freedesktop.Secret.Service'>
<method name='OpenSession'><arg type='s' direction='in'/><arg type='v' direction='in'/><arg type='v' direction='out'/><arg type='o' direction='out'/></method>
<method name='SearchItems'><arg type='a{ss}' direction='in'/><arg type='ao' direction='out'/><arg type='ao' direction='out'/></method>
<method name='ReadAlias'><arg type='s' direction='in'/><arg type='o' direction='out'/></method>
<property name='Collections' type='ao' access='read'/>
</interface><interface name='org.freedesktop.Secret.Session'><method name='Close'/></interface></node>"""


def main():
    address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    if not re.fullmatch(r"unix:path=/tmp/orbit-native-[^/]+/bus", address):
        raise SystemExit("Requires an owned Orbit private bus")
    destination = Path(sys.argv[1])
    if not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+/secret-service-summary.json", str(destination)):
        raise SystemExit("Requires a disposable summary path")
    summary = {"openSessions": 0, "encryptedSessionsRejected": 0, "searches": 0,
               "searchAttributeNames": [], "readAliases": 0, "secretsReturned": 0}

    def save():
        # Only counts and public schema field names are retained. Never values.
        with open(destination, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(summary, stream)

    def call(_connection, _sender, _path, interface, method, parameters, invocation):
        if interface == "org.freedesktop.Secret.Service":
            if method == "OpenSession":
                summary["openSessions"] += 1
                if parameters.unpack()[0] != "plain":
                    summary["encryptedSessionsRejected"] += 1
                    invocation.return_dbus_error("org.freedesktop.DBus.Error.NotSupported", "Only plain transfer is offered")
                else:
                    invocation.return_value(GLib.Variant("(vo)", (GLib.Variant("s", ""), "/org/freedesktop/secrets/session/empty")))
            elif method == "SearchItems":
                summary["searches"] += 1
                # Restrict names too, a caller could encode a value in a field name.
                allowed = {"application", "key", "type", "user", "server", "xdg:schema"}
                names = sorted(name if name in allowed else "other" for name in parameters.unpack()[0])
                if names not in summary["searchAttributeNames"]:
                    summary["searchAttributeNames"].append(names)
                invocation.return_value(GLib.Variant("(aoao)", ([], [])))
            elif method == "ReadAlias":
                summary["readAliases"] += 1
                invocation.return_value(GLib.Variant("(o)", ("/",)))
            else:
                invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "Unsupported empty-service operation")
        elif interface == "org.freedesktop.Secret.Session" and method == "Close":
            invocation.return_value(None)
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "Unsupported empty-service operation")
        save()

    def get(_connection, _sender, _path, interface, name):
        if interface == "org.freedesktop.Secret.Service" and name == "Collections":
            return GLib.Variant("ao", [])
        return None

    connection = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    info = Gio.DBusNodeInfo.new_for_xml(NODE)
    register = getattr(connection, "register_object_with_closures2", None) or connection.register_object
    for path in ("/org/freedesktop/secrets", "/org/freedesktop/secrets/session/empty"):
        for interface in info.interfaces:
            register(path, interface, call, get, None)
    reply = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
        GLib.Variant("(su)", ("org.freedesktop.secrets", 4)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 2000, None)
    if reply.unpack()[0] != 1:
        raise SystemExit("Private secret-service name is already owned")
    loop = GLib.MainLoop()
    signal.signal(signal.SIGTERM, lambda *_: loop.quit())
    signal.signal(signal.SIGINT, lambda *_: loop.quit())

    def watch_parent():
        sys.stdin.read()
        GLib.idle_add(loop.quit)

    threading.Thread(target=watch_parent, daemon=True).start()
    save()
    print(json.dumps({"ready": True, "items": 0}), flush=True)
    loop.run()
    save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
