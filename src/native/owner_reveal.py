"""Explicit owner-click navigation only. Never called by capture or background input."""
import json
import re

from .session import SessionError


def reveal_window(session, value):
    if (type(value) is not dict or set(value) != {"appId", "windowId"}
            or type(value["appId"]) is not str or type(value["windowId"]) is not str
            or session.closed or session.lease_id is None):
        raise SessionError("Owner navigation requires a retained session window")
    target = session._target(value["appId"], value["windowId"], passive=True)
    address, stable = target["address"], target["key"][1]
    if (type(address) is not str or re.fullmatch(r"0x[0-9a-f]{1,16}", address) is None
            or type(stable) is not str or re.fullmatch(r"[0-9a-f]{1,16}", stable) is None):
        raise SessionError("Owner navigation target is unavailable")
    clients = json.loads(session.transport._exchange("j/clients"))
    if type(clients) is not list or len(clients) > 4096:
        raise SessionError("Owner navigation inventory is unavailable")
    matches = [client for client in clients if type(client) is dict
               and client.get("address") == address and client.get("stableId") == stable]
    if len(matches) != 1:
        raise SessionError("Owner navigation target closed or was replaced")
    client = matches[0]
    pid = client.get("pid")
    workspace = client.get("workspace", {}).get("id") if type(client.get("workspace")) is dict else None
    if type(pid) is not int or pid <= 0 or type(workspace) is not int or not 1 <= workspace <= 2147483647:
        raise SessionError("Owner navigation target identity is unavailable")
    selector = json.dumps("address:" + address)
    # The identity guard and focus action execute together in the compositor.
    # No address-only query-then-dispatch fallback. The compositor focus action
    # may move the pointer as part of this deliberate owner navigation.
    command = ("eval local w=hl.get_window(" + selector + "); assert(w and w.mapped and w.stable_id=="
               + json.dumps(stable) + " and w.pid==" + str(pid) + "); "
               + "local r=hl.dispatch(hl.dsp.focus({window=" + selector + "})); assert(r and r.ok==true, 'Owner navigation refused')")
    reply = session.transport._exchange(command)
    if reply.strip() != "ok":
        raise SessionError("Owner navigation was not confirmed; compatible Lua window focus is required")
    active = json.loads(session.transport._exchange("j/activewindow"))
    if (type(active) is not dict or active.get("address") != address
            or active.get("stableId") != stable or active.get("pid") != pid):
        raise SessionError("Owner navigation was not confirmed; inspect the selected session before another click")
    current_workspace = active.get("workspace", {}).get("id") if type(active.get("workspace")) is dict else None
    if type(current_workspace) is not int or not 1 <= current_workspace <= 2147483647:
        raise SessionError("Owner navigation workspace acknowledgement is unavailable")
    return {"revealed": True, "workspace": current_workspace, "windowId": value["windowId"]}
