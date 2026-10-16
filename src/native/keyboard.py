"""One admitted keyboard action: prepare focus, then attempt input once."""
import json
import itertools
import threading
import re
import time
import uuid

from .host import HostError, deadline_timeout

_PRODUCER = uuid.uuid4().hex
_SEQUENCE = itertools.count(1)
_SEQUENCE_LOCK = threading.Lock()

KEYBOARD_ACTIONS = frozenset({"ghost-key", "ghost-type", "ghost-texthex"})
TARGET = re.compile(r"0x[0-9a-f]{1,16}@[0-9a-f]{1,16}@(?:lease-[0-9a-fA-F]{32}|orbit-native-[0-9a-f]{32}\.scope)")


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate keyboard preparation field")
        result[key] = value
    return result


def prepared_input(request, exchange, deadline):
    command, separator, rest = request.partition(" ")
    handle, payload_separator, payload = rest.partition(" ")
    if command not in KEYBOARD_ACTIONS or not separator or not TARGET.fullmatch(handle):
        raise HostError("Keyboard input requires an exact guarded target")
    if command == "ghost-key":
        if not payload_separator or not payload or len(payload) > 256 or any(c.isspace() for c in payload):
            raise HostError("Keyboard input requires one key combination")
        commit_command = "ghost-key-prepared"
    else:
        if command == "ghost-type":
            payload = payload.encode("utf-8").hex()
        if len(payload) > 131072 or len(payload) % 2 or re.search(r"[^0-9a-fA-F]", payload):
            raise HostError("Invalid prepared hexadecimal text")
        commit_command = "ghost-texthex-prepared"
    with _SEQUENCE_LOCK:
        sequence = next(_SEQUENCE)
    if sequence > 18446744073709551615:
        raise HostError("Native keyboard operation sequence exhausted")
    token = _PRODUCER + format(sequence, "016x")
    prepare = f"ghost-keyboard-prepare {handle} {token}"
    attempted = False
    serial = None
    try:
        while True:
            deadline_timeout(deadline)
            response = exchange(prepare, deadline)
            try:
                value = json.loads(response, object_pairs_hook=unique_fields)
            except (ValueError, TypeError) as error:
                raise HostError(response or "Invalid keyboard preparation reply") from error
            if (not isinstance(value, dict) or set(value) != {"schema", "status", "token", "serial"}
                    or type(value["schema"]) is not int or value["schema"] != 1
                    or value["status"] not in ("pending", "ready") or value["token"] != token
                    or type(value["serial"]) is not int or not 0 < value["serial"] <= 4294967295
                    or (serial is not None and value["serial"] != serial)):
                raise HostError("Keyboard preparation identity changed")
            serial = value["serial"]
            if value["status"] == "ready":
                break
            time.sleep(min(0.01, deadline_timeout(deadline)))
        deadline_timeout(deadline)
        attempted = True
        return exchange(f"{commit_command} {handle} {token} {payload}", deadline)
    finally:
        # An ambiguous commit is never resent. Pending preparation has a server
        # expiry even if the original absolute deadline leaves no cleanup time.
        if not attempted and time.monotonic() < deadline:
            try:
                exchange(f"ghost-keyboard-cancel {handle} {token}", deadline)
            except Exception:
                pass
