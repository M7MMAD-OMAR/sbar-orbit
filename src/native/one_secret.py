#!/usr/bin/python3
"""A secret service that holds exactly one secret.

A browser opening a cloned profile needs the key its cookies were encrypted with, and that key lives
in the person's login keyring. Handing the browser the session bus gives it the keyring, and a
filtering proxy narrows the bus NAME but not which items may be searched: measured on this
workstation, a client on such a proxy enumerated all twenty five items in the login collection to
reach one. That is a keyring wide grant dressed as a narrow one.

This is the narrow one. The broker, which already has the person's session bus, reads a single item
out of the real keyring, starts a private message bus, and serves that one item on it under the same
interface the browser expects. The browser decrypts its profile and can enumerate exactly one secret,
because there is exactly one.

The cost is stated rather than hidden: this process holds one real secret in memory for the life of a
session. It never writes it anywhere, never logs it, and exits when its parent closes the pipe.

Protocol implemented: enough of org.freedesktop.Secret.Service for libsecret's password lookup, which
is OpenSession, SearchItems, GetSecrets, plus the Collections property and one Item. Only the "plain"
transfer algorithm is offered; libsecret negotiates it when no encryption is requested.
"""
import json
import signal
import subprocess
import sys
import threading

import gi
gi.require_version("Secret", "1")
from gi.repository import Gio, GLib, Secret  # noqa: E402

SERVICE = "org.freedesktop.secrets"
SERVICE_PATH = "/org/freedesktop/secrets"
COLLECTION_PATH = SERVICE_PATH + "/collection/orbit"
ITEM_PATH = COLLECTION_PATH + "/1"
SESSION_PATH = SERVICE_PATH + "/session/1"

# The schema Chromium's libsecret backend looks its key up under, and the attribute it matches on.
CHROME_SCHEMA = "chrome_libsecret_os_crypt_password_v2"

NODE = """
<node>
  <interface name='org.freedesktop.Secret.Service'>
    <method name='OpenSession'>
      <arg name='algorithm' type='s' direction='in'/>
      <arg name='input' type='v' direction='in'/>
      <arg name='output' type='v' direction='out'/>
      <arg name='result' type='o' direction='out'/>
    </method>
    <method name='SearchItems'>
      <arg name='attributes' type='a{ss}' direction='in'/>
      <arg name='unlocked' type='ao' direction='out'/>
      <arg name='locked' type='ao' direction='out'/>
    </method>
    <method name='GetSecrets'>
      <arg name='items' type='ao' direction='in'/>
      <arg name='session' type='o' direction='in'/>
      <arg name='secrets' type='a{o(oayays)}' direction='out'/>
    </method>
    <method name='Unlock'>
      <arg name='objects' type='ao' direction='in'/>
      <arg name='unlocked' type='ao' direction='out'/>
      <arg name='prompt' type='o' direction='out'/>
    </method>
    <method name='ReadAlias'>
      <arg name='name' type='s' direction='in'/>
      <arg name='collection' type='o' direction='out'/>
    </method>
    <property name='Collections' type='ao' access='read'/>
  </interface>
  <interface name='org.freedesktop.Secret.Collection'>
    <method name='SearchItems'>
      <arg name='attributes' type='a{ss}' direction='in'/>
      <arg name='results' type='ao' direction='out'/>
    </method>
    <property name='Items' type='ao' access='read'/>
    <property name='Label' type='s' access='read'/>
    <property name='Locked' type='b' access='read'/>
  </interface>
  <interface name='org.freedesktop.Secret.Item'>
    <method name='GetSecret'>
      <arg name='session' type='o' direction='in'/>
      <arg name='secret' type='(oayays)' direction='out'/>
    </method>
    <property name='Attributes' type='a{ss}' access='read'/>
    <property name='Label' type='s' access='read'/>
    <property name='Locked' type='b' access='read'/>
  </interface>
  <interface name='org.freedesktop.Secret.Session'>
    <method name='Close'/>
  </interface>
</node>
"""


def read_one_secret(attributes):
    """The single item, taken from the person's real keyring on their real session bus.

    Looked up by the same schema and attributes the browser will ask for, so what is served is what
    the browser would have found, and nothing else is read.
    """
    schema = Secret.Schema.new(CHROME_SCHEMA, Secret.SchemaFlags.DONT_MATCH_NAME,
                               {key: Secret.SchemaAttributeType.STRING for key in attributes})
    value = Secret.password_lookup_sync(schema, attributes, None)
    if value is None:
        raise SystemExit(f"No keyring item matches {json.dumps(attributes)}")
    return value


class OneSecret:
    def __init__(self, secret, attributes, label):
        self.secret = secret.encode()
        self.attributes = attributes
        self.label = label
        # Counted so the run can report how many times the browser actually asked, which is the
        # difference between a service that works and one that is merely present.
        self.reads = 0

    def call(self, _connection, _sender, path, interface, method, parameters, invocation):
        if interface == "org.freedesktop.Secret.Service":
            if method == "OpenSession":
                algorithm = parameters.unpack()[0]
                if algorithm != "plain":
                    invocation.return_dbus_error("org.freedesktop.DBus.Error.NotSupported",
                                                 "Only the plain transfer algorithm is offered")
                    return
                invocation.return_value(GLib.Variant("(vo)", (GLib.Variant("s", ""), SESSION_PATH)))
                return
            if method == "SearchItems":
                wanted = parameters.unpack()[0]
                found = [ITEM_PATH] if self.matches(wanted) else []
                invocation.return_value(GLib.Variant("(aoao)", (found, [])))
                return
            if method == "GetSecrets":
                items, session = parameters.unpack()
                secrets = {}
                for item in items:
                    if item == ITEM_PATH:
                        self.reads += 1
                        secrets[item] = (session, b"", self.secret, "text/plain")
                invocation.return_value(GLib.Variant("(a{o(oayays)})", (secrets,)))
                return
            if method == "Unlock":
                invocation.return_value(GLib.Variant("(aoo)", (parameters.unpack()[0], "/")))
                return
            if method == "ReadAlias":
                # "default" is the collection libsecret stores into; there is only one here.
                invocation.return_value(GLib.Variant("(o)", (COLLECTION_PATH,)))
                return
        if interface == "org.freedesktop.Secret.Collection" and method == "SearchItems":
            wanted = parameters.unpack()[0]
            invocation.return_value(GLib.Variant("(ao)", ([ITEM_PATH] if self.matches(wanted) else [],)))
            return
        if interface == "org.freedesktop.Secret.Item" and method == "GetSecret":
            self.reads += 1
            session = parameters.unpack()[0]
            invocation.return_value(GLib.Variant("((oayays))", ((session, b"", self.secret, "text/plain"),)))
            return
        if interface == "org.freedesktop.Secret.Session" and method == "Close":
            invocation.return_value(None)
            return
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", f"{interface}.{method} on {path}")

    def matches(self, wanted):
        """An empty search matches, which is how a client enumerates. It still finds one item."""
        return all(self.attributes.get(key) == value for key, value in wanted.items())

    def get(self, _connection, _sender, _path, interface, name):
        if interface == "org.freedesktop.Secret.Service" and name == "Collections":
            return GLib.Variant("ao", [COLLECTION_PATH])
        if interface == "org.freedesktop.Secret.Collection":
            if name == "Items":
                return GLib.Variant("ao", [ITEM_PATH])
            if name == "Label":
                return GLib.Variant("s", "Orbit session")
            if name == "Locked":
                return GLib.Variant("b", False)
        if interface == "org.freedesktop.Secret.Item":
            if name == "Attributes":
                return GLib.Variant("a{ss}", self.attributes)
            if name == "Label":
                return GLib.Variant("s", self.label)
            if name == "Locked":
                return GLib.Variant("b", False)
        return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: one_secret.py '{\"application\": \"chrome\"}'")
    attributes = json.loads(sys.argv[1])
    if not isinstance(attributes, dict) or not attributes:
        raise SystemExit("Attributes must be a non-empty object")
    label = sys.argv[2] if len(sys.argv) > 2 else "Orbit browser key"
    secret = read_one_secret(attributes)

    # A bus of its own. Nothing else is on it, so there is nothing else to reach: the browser cannot
    # talk to systemd and move itself out of Orbit's resource scope, and cannot see the real keyring.
    daemon = subprocess.Popen(
        ["/usr/bin/dbus-daemon", "--session", "--nofork", "--print-address=1",
         "--nopidfile", "--syslog-only"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    address = daemon.stdout.readline().strip()
    if not address:
        raise SystemExit("The private bus did not print an address")

    connection = Gio.DBusConnection.new_for_address_sync(
        address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)
    holder = OneSecret(secret, attributes, label)
    info = Gio.DBusNodeInfo.new_for_xml(NODE)
    # register_object is deprecated in this PyGObject; the closures form is the supported one and
    # takes the same handlers. Falling back keeps the script working on an older binding.
    register = getattr(connection, "register_object_with_closures2", None) or connection.register_object
    for path in (SERVICE_PATH, COLLECTION_PATH, ITEM_PATH, SESSION_PATH):
        for interface in info.interfaces:
            register(path, interface, holder.call, holder.get, None)
    Gio.bus_own_name_on_connection(connection, SERVICE, Gio.BusNameOwnerFlags.NONE, None, None)

    loop = GLib.MainLoop()

    def stop(*_):
        loop.quit()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def watch_parent():
        # The broker holds the pipe. If the broker dies, this exits with the secret it was holding,
        # the same supervision every other owned Orbit process uses.
        sys.stdin.read()
        GLib.idle_add(loop.quit)

    threading.Thread(target=watch_parent, daemon=True).start()
    print(json.dumps({"address": address, "items": 1}), flush=True)
    try:
        loop.run()
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            daemon.kill()
        # Reported on the way out so a run can say whether the browser ever asked.
        sys.stderr.write(json.dumps({"reads": holder.reads}) + "\n")


if __name__ == "__main__":
    main()
