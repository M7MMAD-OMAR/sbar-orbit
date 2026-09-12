#!/usr/bin/python3
"""The native messaging host for the Sbar Orbit mint extension.

WRITTEN, NOT LOADED, NOT VERIFIED. This program has never been started by a browser, because gates
G12, G13 and G14 need the extension loaded in a real browser and this project's rules keep agents
out of the person's own browser entirely.

Why it exists at all: an MV3 extension cannot answer requests on a unix socket. That is the refuter
result recorded in docs/separate-workspace-review.md, and it is the whole reason for this file. The
extension speaks native messaging over stdio, this program speaks the broker's RPC over its unix
socket, and nothing else crosses between them.

What it deliberately does not do:
  It never asks the extension for anything. Messages travel one way, from the browser outward.
  It never reads a browser profile, a cookie store or a keyring. The only state it ever sees is the
  grant the extension chose to hand it.
  It never writes a grant to disk. A short lived credential that lands in a file has stopped being
  short lived.

The shebang is /usr/bin/python3 rather than a bare python3 on purpose: a bare python3 on this
workstation is a virtualenv, and a browser launching a host through one is a silent failure.
"""

import json
import os
import socket
import struct
import sys

# Chrome's own ceiling on a message from a host to an extension is one megabyte. Applying the same
# number in the other direction is this program's choice, not a platform fact.
MAX_FRAME_BYTES = 1024 * 1024

# Four bytes, NATIVE byte order. "=I" is the native-order, standard-size struct code. A big endian
# constant here would parse nothing and would report nothing, which is the worst kind of wrong.
LENGTH = struct.Struct("=I")

PROTOCOL_VERSION = 1


def read_frame(stream):
    """One whole message, or None at end of stream."""
    header = stream.read(LENGTH.size)
    if not header or len(header) < LENGTH.size:
        return None
    (length,) = LENGTH.unpack(header)
    if length > MAX_FRAME_BYTES:
        raise ValueError("FRAME_TOO_LARGE")
    body = stream.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def write_frame(stream, value):
    body = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise ValueError("FRAME_TOO_LARGE")
    stream.write(LENGTH.pack(len(body)))
    stream.write(body)
    stream.flush()


def broker_socket_path():
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        return None
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


def call_broker(path, method, params):
    """The broker speaks HTTP over a unix socket, so this speaks exactly that much HTTP.

    No library, because a host program launched by a browser should pull in nothing it does not
    need, and because the request is one POST with a known body.
    """
    body = json.dumps({"method": method, "params": params}).encode("utf-8")
    request = (
        b"POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
        + b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\nConnection: close\r\n\r\n" + body
    )
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(30)
        client.connect(path)
        client.sendall(request)
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    raw = b"".join(chunks)
    separator = raw.find(b"\r\n\r\n")
    if separator < 0:
        raise ValueError("BROKER_UNREADABLE")
    return json.loads(raw[separator + 4:].decode("utf-8", "replace") or "null")


def refusal(message_id, code, detail):
    return {"v": PROTOCOL_VERSION, "id": message_id, "ok": False, "refusal": code, "detail": detail}


def handle(message):
    if not isinstance(message, dict):
        return refusal("unknown", "MALFORMED_ENVELOPE", "Message is not an object")
    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 128:
        return refusal("unknown", "MALFORMED_ENVELOPE", "Missing or unusable id")
    if message.get("v") != PROTOCOL_VERSION:
        return refusal(message_id, "UNSUPPORTED_VERSION", "Expected version %d" % PROTOCOL_VERSION)
    # A refusal the extension already made travels to the broker unchanged, so the broker learns
    # why nothing was minted rather than only that nothing arrived.
    path = broker_socket_path()
    if not path or not os.path.exists(path):
        return refusal(message_id, "HOST_ABSENT", "No Orbit broker socket to hand the grant to")
    try:
        answer = call_broker(path, "session.mint", message)
    except Exception:
        # Deliberately not the exception text: it can carry the socket path and, on some failures,
        # a fragment of the body, and the body is the person's live cookies.
        return refusal(message_id, "HOST_ABSENT", "The Orbit broker did not answer")
    if isinstance(answer, dict) and answer.get("ok") is True:
        # The acknowledgement is shaped like a grant with no cookies in it, so the extension parses
        # it with the same code it parses everything else and no credential travels back.
        sent = message.get("grant") if isinstance(message.get("grant"), dict) else {}
        return {"v": PROTOCOL_VERSION, "id": message_id, "ok": True,
                "grant": {"origin": sent.get("origin", ""),
                          "issuedAt": sent.get("issuedAt", 0),
                          "expiresAt": sent.get("expiresAt", 0),
                          "cookies": []}}
    code = "MALFORMED_ENVELOPE"
    if isinstance(answer, dict):
        error = answer.get("error")
        if isinstance(error, dict) and error.get("code") == "INVALID_REQUEST":
            # The broker side of this method is not built yet. Saying so is the honest answer.
            code = "NO_PENDING_REQUEST"
    return refusal(message_id, code, "The broker did not accept the grant")


def main():
    # Binary stdio, or Windows would translate a 0x0a in the length prefix and the framing would
    # silently drift. Not measured on Windows; the buffers are used directly for the same reason.
    source = sys.stdin.buffer
    sink = sys.stdout.buffer
    while True:
        try:
            message = read_frame(source)
        except (ValueError, json.JSONDecodeError):
            write_frame(sink, refusal("unknown", "MALFORMED_ENVELOPE", "Unreadable frame"))
            return 1
        if message is None:
            return 0
        write_frame(sink, handle(message))


if __name__ == "__main__":
    sys.exit(main())
