"""Dormant one-shot peer-qualified metadata handshake, not a read grant.

The trusted owner supplies a private listener, authorization lock and callbacks.
The lock must be the same lock protecting enrollment and revocation. Input and
staging run without that lock; the final authorization and ACK hold it. Final
authorization must be nonblocking and non-reentrant. Callbacks only stage/check
and may not perform irreversible effects. The internal reader and peer have
Python-accessible socket attributes, not an isolation boundary. This server
never passes either object to the owner callbacks; those callbacks are trusted.
No production ingress uses this module. SO_PEERCRED identifies the connection
creator, not every writer; same-UID process and FD passing are not isolated.
The peer helper samples pathname identity and cannot detect rename/restore ABA.
A fixed ACK is nonsecret metadata; a partial send cannot be undone, and even a
full send confirms only kernel acceptance, not delivery or future permission.
The final peer check uses filesystem/proc calls under the authority lock, so OS
blocking cannot be bounded by the cooperative deadline or off-latency claims.
"""
import json
import threading

from .read_peer import accept_owned_peer


_REQUEST = {"v": 1, "op": "hello"}


class ReadChannelError(RuntimeError):
    def __init__(self):
        super().__init__("Read channel handshake refused")


def _parse(payload):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result
    try:
        value = json.loads(payload.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError):
        invalid = True
    else:
        invalid = False
    if invalid:
        raise ReadChannelError() from None
    if (type(value) is not dict or set(value) != set(_REQUEST)
            or type(value["v"]) is not int or value["v"] != 1
            or type(value["op"]) is not str or value["op"] != "hello"):
        raise ReadChannelError() from None


def serve_once(listener, *, deadline, cancel=None, authority_lock, authorize, operation):
    """Accept exactly one connection and send a fixed non-authoritative ACK.

    authorize(peer) returns an exact (context, generation) tuple, or None to
    deny. Generation is an owner-created opaque object that must never be reused
    across revoke/reapprove. The initial call runs outside the lock and must be
    a safe nonblocking atomic snapshot. Every mutation uses the supplied lock;
    final authorization runs under it. operation(context) only stages, and its
    result is ignored. No model-supplied labels become authority.
    """
    if (not callable(authorize) or not callable(operation)
            or type(authority_lock) is not type(threading.Lock())):
        raise ReadChannelError() from None
    try:
        with accept_owned_peer(listener, deadline=deadline, cancel=cancel) as peer:
            def stage(identity, reader):
                _parse(reader.read_request())
                grant = authorize(identity)
                if (type(grant) is not tuple or len(grant) != 2
                        or grant[0] is None or grant[1] is None):
                    raise ReadChannelError()
                operation(grant[0])
                return grant

            def final(identity, grant):
                current = authorize(identity)
                return (type(current) is tuple and len(current) == 2
                        and current[0] is grant[0] and current[1] is grant[1])

            peer.exchange_one(stage, final, authority_lock)
    except BaseException:
        failed = True
    else:
        failed = False
    if failed:
        raise ReadChannelError() from None
    return True
