"""Correlate a normal startup activation token with its actual Wayland surface."""
from contextlib import contextmanager
import json
import re

from .session import SessionError


class OpeningIdentity:
    supported = True

    def __init__(self, transport, token):
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
            raise SessionError("Invalid opening token identity")
        self.transport, self.token = transport, token

    def request(self, operation):
        return self.transport._exchange(f"ghost-opening {operation} {self.token}").strip()

    def windows(self):
        value = json.loads(self.request("info"))
        if (not isinstance(value, dict) or value.get("schema") != 1 or value.get("token") != self.token
                or type(value.get("ambiguous")) is not bool or not isinstance(value.get("windows"), list)
                or len(value["windows"]) > 64):
            raise SessionError("Invalid opening activation identity response")
        if value["ambiguous"]:
            raise SessionError("Opening token activated different surfaces; inspect candidates without relaunching")
        result = set()
        for window in value["windows"]:
            if (not isinstance(window, dict)
                    or not re.fullmatch(r"0x[0-9a-f]{1,16}", str(window.get("address")))
                    or not re.fullmatch(r"[0-9a-f]{1,16}", str(window.get("stableId")))):
                raise SessionError("Invalid activation-bound window identity")
            result.add((window["address"], window["stableId"]))
        return result

    def close(self):
        if self.request("forget") != "ok":
            raise SessionError("Opening token cleanup was not acknowledged")


@contextmanager
def opening_identity(transport, token):
    identity = OpeningIdentity(transport, token)
    reply = identity.request("register")
    if reply == "unknown request":
        # Opening without an input plugin can still prove ancestry or scope.
        # Missing observation capability is not a reason to invent a new app.
        class UnsupportedActivation:
            supported = False
            def windows(self): return set()
        yield UnsupportedActivation()
        return
    if reply != "ok":
        raise SessionError("Native opening token registration was not acknowledged")
    try:
        yield identity
    except BaseException as primary:
        try:
            identity.close()
        except BaseException as cleanup:
            raise BaseExceptionGroup("Opening and token cleanup failed", [primary, cleanup])
        raise
    else:
        identity.close()
