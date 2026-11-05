"""Read-only, exact-window evidence for registered opening outcomes."""
import json
import math
import re

from .lease import process_identity
from .session import SessionError


class ConstraintSampleChanged(Exception):
    """The exact target still exists, but its sampled geometry changed."""


def existing_processes(windows, registered=None):
    """Retain generations observed before dispatch, never infer them afterward."""
    result = {}
    for window in windows:
        pid = window.get("pid")
        if type(pid) is int and pid > 0:
            try:
                identity = process_identity(pid)
            except (OSError, ValueError, IndexError):
                continue
            if identity is not None:
                result[pid] = identity
    if registered is not None and registered.verify():
        result[registered.process[0]] = registered.process
    return result


def forwarding_proven(window, root, before, activated):
    """A request-correlated surface in an unchanged prelaunch process after launcher exit."""
    identity = (window.get("address"), window.get("stableId"))
    pid = window.get("pid")
    expected = before.get(pid)
    if identity not in activated or expected is None or pid == root[0]:
        return False
    try:
        return (process_identity(pid) == expected and process_identity(root[0]) != tuple(root)
                and process_identity(pid) == expected)
    except (OSError, ValueError, IndexError):
        return False


def _dimensions(value, *, allow_zero=False):
    if not isinstance(value, list) or len(value) != 2:
        return None
    if any(type(number) not in (int, float) or not math.isfinite(number)
           or number < 0 or (not allow_zero and number == 0) or number > 100000 for number in value):
        return None
    return {"width": value[0], "height": value[1]}


def native_constraints(transport, window):
    """Return optional same-sample native minima. Old plugins remain supported."""
    address, stable, pid = window.get("address"), window.get("stableId"), window.get("pid")
    if (not re.fullmatch(r"0x[0-9a-f]{1,16}", str(address))
            or not re.fullmatch(r"[0-9a-f]{1,16}", str(stable)) or type(pid) is not int or pid <= 0):
        return None
    try:
        raw = transport._exchange(f"ghost-window-constraints {address} {stable} {pid}")
        if not isinstance(raw, str) or len(raw.encode()) > 4096:
            return None
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {"schema", "address", "stableId", "pid", "size", "minimum", "source"}
                or type(value["schema"]) is not int or value["schema"] != 1
                or type(value["pid"]) is not int
                or (value["address"], value["stableId"], value["pid"]) != (address, stable, pid)
                or value["source"] != "xdg-toplevel-current"):
            return None
        current, minimum = _dimensions(value["size"]), _dimensions(value["minimum"], allow_zero=True)
        sampled = _dimensions(window.get("size"))
        if current is None or minimum is None or sampled is None:
            return None
        if current != sampled:
            raise ConstraintSampleChanged()
        return {"minimum": minimum, "source": value["source"]}
    except (OSError, TimeoutError, ValueError, TypeError, OverflowError, SessionError):
        return None


def minimum_outcome(actual, requested, constraints):
    """Only attribute an exact current native clamp, not arbitrary size differences."""
    unknown = {"minimumSizeEnforced": "unknown", "differenceCause": "unknown"}
    if actual is None or requested is None or constraints is None:
        return unknown
    minimum = constraints["minimum"]
    constrained = any(requested[key] < minimum[key] - 2 for key in ("width", "height"))
    if not constrained:
        enforced = False
    elif all(abs(actual[key] - max(requested[key], minimum[key])) <= 2 for key in ("width", "height")):
        enforced = True
    else:
        enforced = "unknown"
    return {"minimumSizeEnforced": enforced, "nativeMinimum": dict(minimum),
            "constraintSource": constraints["source"],
            "differenceCause": "native-minimum-size" if enforced is True else "unknown"}
