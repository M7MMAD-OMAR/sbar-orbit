"""Private numeric compositor inventory only, not an atomic reservation or launch receipt.

Both queries are read-only. No plugin, window filtering, workspace switching or native input.
"""
import json

from .session import SessionError


_MAX = 2147483647


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate inventory field")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("Nonstandard inventory constant")


def _read(transport, command):
    raw = transport._exchange(command)
    if type(raw) is not str:
        raise ValueError("Invalid inventory reply")
    return json.loads(raw, object_pairs_hook=_unique, parse_constant=_constant)


def workspace_inventory(transport, *, exclude=None):
    """Return all occupied/shown numbered IDs, with no owner metadata or mutation.

    Clients on special workspaces (zero/negative IDs) are not numbered occupancy.
    A shown monitor without a known positive numbered workspace makes inventory unknown.
    The two samples can race owner activity; this is not an exclusive workspace claim.
    """
    try:
        if exclude is not None and (type(exclude) is not tuple or len(exclude) != 3
                or type(exclude[0]) is not str or type(exclude[1]) is not str or type(exclude[2]) is not int):
            raise ValueError("Invalid private candidate exclusion")
        clients = _read(transport, "j/clients")
        if type(clients) is not list or len(clients) > 16384:
            raise ValueError("Invalid clients")
        occupied = set()
        for client in clients:
            if type(client) is not dict or type(client.get("workspace")) is not dict:
                raise ValueError("Invalid client workspace")
            number = client["workspace"].get("id")
            if type(number) is not int or number > _MAX:
                raise ValueError("Invalid client workspace ID")
            # Only an exact already-attributed new candidate may be excluded
            # for a post-map destination check; every other window still counts.
            identity = (client.get("address"), client.get("stableId"), client.get("pid"))
            if number > 0 and (exclude is None or identity != exclude):
                occupied.add(number)
        monitors = _read(transport, "j/monitors")
        if type(monitors) is not list or not 1 <= len(monitors) <= 64:
            raise ValueError("Invalid monitors")
        shown = set()
        for monitor in monitors:
            if type(monitor) is not dict or type(monitor.get("activeWorkspace")) is not dict:
                raise ValueError("Invalid shown workspace")
            number = monitor["activeWorkspace"].get("id")
            if type(number) is not int or not 1 <= number <= _MAX:
                raise ValueError("Invalid shown workspace ID")
            shown.add(number)
        return {"occupied": sorted(occupied), "shown": sorted(shown)}
    except Exception:
        raise SessionError("Workspace inventory is unavailable") from None
