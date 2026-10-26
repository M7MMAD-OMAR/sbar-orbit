#!/usr/bin/python3
"""Framed transport fixture. Never launches applications or contacts a display."""
import json
import sys
import os
import signal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "exit":
        sys.exit(7)
    response = {"requestId": request["requestId"], "ok": True, "result": {"value": "split \U0001f600"}}
    if request["method"] == "indicator-style":
        from src.native.indicator_style import indicator_style
        response["result"] = {"style": indicator_style(),
                              "environment": sorted(os.environ)}
    if request["method"] in ("wrong-id", "wrong-id-stop"):
        response["requestId"] = "0" * 32
    if request["method"] == "bad-error":
        response = {"requestId": request["requestId"], "ok": False, "error": None}
    if request["method"] == "control-ended":
        response = {"requestId": request["requestId"], "ok": False,
                    "error": {"code": "SESSION_CLOSED", "message": "application lease unavailable"}}
    if request["method"] == "presentation-not-ready":
        response = {"requestId": request["requestId"], "ok": False,
                    "error": {"code": "PRESENTATION_NOT_READY", "message": "private monitor readiness details"}}
    if request["method"] == "owner-busy":
        response = {"requestId": request["requestId"], "ok": False,
                    "error": {"code": "OWNER_BUSY", "message": "private owner surface details"}}
    if request["method"] == "application-busy":
        response = {"requestId": request["requestId"], "ok": False,
                    "error": {"code": "APPLICATION_BUSY", "message": "private other task details"}}
    if request["method"] in ("opening-uncertain", "native-incompatible"):
        response = {"requestId": request["requestId"], "ok": False, "error": {
            "code": "OPENING_UNCERTAIN" if request["method"] == "opening-uncertain" else "NATIVE_INCOMPATIBLE",
            "message": "private details must remain in the worker log"}}
    encoded = (json.dumps(response, ensure_ascii=False) + "\n").encode()
    for byte in encoded:
        sys.stdout.buffer.write(bytes([byte]))
        sys.stdout.buffer.flush()
    if request["method"] == "wrong-id-stop":
        os.kill(os.getpid(), signal.SIGSTOP)
