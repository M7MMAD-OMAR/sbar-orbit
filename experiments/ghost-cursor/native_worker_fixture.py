#!/usr/bin/python3
"""Framed transport fixture. Never launches applications or contacts a display."""
import json
import sys
import os
import signal

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "exit":
        sys.exit(7)
    response = {"requestId": request["requestId"], "ok": True, "result": {"value": "split \U0001f600"}}
    if request["method"] in ("wrong-id", "wrong-id-stop"):
        response["requestId"] = "0" * 32
    if request["method"] == "bad-error":
        response = {"requestId": request["requestId"], "ok": False, "error": None}
    encoded = (json.dumps(response, ensure_ascii=False) + "\n").encode()
    for byte in encoded:
        sys.stdout.buffer.write(bytes([byte]))
        sys.stdout.buffer.flush()
    if request["method"] == "wrong-id-stop":
        os.kill(os.getpid(), signal.SIGSTOP)
