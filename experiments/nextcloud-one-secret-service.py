#!/usr/bin/python3
"""Copy one unlocked account credential into memory on an owned private bus."""
import configparser
import ctypes
import json
import os
import re
import resource
import signal
import stat
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/native"))
from one_secret import Gio, GLib, Secret, OneSecret, NODE, SERVICE_PATH, COLLECTION_PATH, ITEM_PATH, SESSION_PATH


def selected_attributes(path):
    if not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+/nextcloud-config/nextcloud.cfg", str(path)):
        raise ValueError("Requires a disposable account configuration")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid() or identity.st_size > 1048576:
            raise ValueError("Requires a bounded owned regular configuration")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(1048577)
        if len(data) != identity.st_size:
            raise ValueError("Configuration changed during read")
    finally:
        os.close(fd)
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config.read_string(data.decode("utf8"))
    accounts = {}
    for key, value in config["Accounts"].items():
        parts = key.split("\\")
        if len(parts) == 2:
            accounts.setdefault(parts[0], {})[parts[1]] = value
    if len(accounts) != 1:
        raise ValueError("Requires exactly one configured account")
    account_id, account = next(iter(accounts.items()))
    if account.get("authType") != "webflow":
        raise ValueError("Only the observed webflow configuration is supported")
    user, url = account["webflow_user"], account["url"]
    parsed = urlsplit(url)
    if not user or not parsed.hostname or parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Unsupported account selection fields")
    if any(char in user + url + account_id for char in ('\\', '"', '\n', '\r')) or user.startswith("@"):
        raise ValueError("Encoded account selection fields are unsupported")
    url += "" if url.endswith("/") else "/"
    return {"server": "Nextcloud", "user": user + ":" + url + ":" + account_id, "type": "plaintext"}


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
        raise SystemExit("Could not disable process dumps")
    address, configuration, summary_path = sys.argv[1:]
    if not re.fullmatch(r"unix:path=/tmp/orbit-native-[^/]+/bus", address):
        raise SystemExit("Requires an owned Orbit private bus")
    if not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+/secret-service-summary.json", summary_path):
        raise SystemExit("Requires a disposable summary")
    attributes = selected_attributes(configuration)
    original_bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    owned = original_bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner",
        GLib.Variant("(s)", ("org.freedesktop.secrets",)), GLib.VariantType.new("(b)"), Gio.DBusCallFlags.NONE, 2000, None)
    if not owned.unpack()[0]:
        raise SystemExit("Original secret service is not running")
    schema = Secret.Schema.new("org.qt.keychain", Secret.SchemaFlags.DONT_MATCH_NAME,
        {key: Secret.SchemaAttributeType.STRING for key in attributes})
    service = Secret.Service.get_sync(Secret.ServiceFlags.NONE, None)
    items = service.search_sync(schema, attributes, Secret.SearchFlags.NONE, None)
    if len(items) != 1 or items[0].get_locked():
        raise SystemExit("Requires one already unlocked matching credential")
    items[0].load_secret_sync(None)
    value = items[0].get_secret()
    if value is None or not value.get_text() or len(value.get_text().encode()) > 65536:
        raise SystemExit("Selected credential is unavailable or unsupported")
    holder = OneSecret(value.get_text(), attributes, "Orbit private Nextcloud credential")
    summary = {"originalItemsRead": 1, "privateItems": 1, "secretsReturned": 0, "searches": 0, "matchedSearches": 0,
               "mutationsRejected": 0}

    def save():
        with open(summary_path, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            summary["secretsReturned"] = holder.reads
            json.dump(summary, stream)

    def call(connection, sender, path, interface, method, parameters, invocation):
        if method == "SearchItems":
            summary["searches"] += 1
            if holder.matches(parameters.unpack()[0]):
                summary["matchedSearches"] += 1
        if method in {"CreateItem", "Delete", "SetSecret"}:
            summary["mutationsRejected"] += 1
            invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Read-only private credential")
        else:
            holder.call(connection, sender, path, interface, method, parameters, invocation)
        save()

    connection = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    info = Gio.DBusNodeInfo.new_for_xml(NODE)
    register = getattr(connection, "register_object_with_closures2", None) or connection.register_object
    for path in (SERVICE_PATH, COLLECTION_PATH, ITEM_PATH, SESSION_PATH):
        for interface in info.interfaces:
            register(path, interface, call, holder.get, None)
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
    print(json.dumps({"ready": True, "items": 1}), flush=True)
    loop.run()
    save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
