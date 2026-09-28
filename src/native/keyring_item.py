#!/usr/bin/python3
"""Check that one Chromium Safe Storage item is already unlocked."""

import re
import sys

import gi

gi.require_version("Secret", "1")
from gi.repository import Secret  # noqa: E402


def available(application: str) -> bool:
    service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
    for collection in service.get_collections():
        if collection.get_locked():
            continue
        collection.load_items_sync(None)
        for item in collection.get_items():
            attributes = item.get_attributes()
            if (attributes.get("application") == application
                    and attributes.get("xdg:schema") == "chrome_libsecret_os_crypt_password_v2"
                    and not item.get_locked()):
                return True
    return False


if __name__ == "__main__":
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", sys.argv[1]):
        raise SystemExit("usage: keyring_item.py APPLICATION")
    try:
        ready = available(sys.argv[1])
    except Exception:
        ready = False
    raise SystemExit(0 if ready else 2)
