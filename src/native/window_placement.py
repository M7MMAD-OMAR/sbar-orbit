"""Atomic placement of a new attributed application window, preserving owner focus."""
import json

from .session import SessionError


def place_new_window(transport, window, workspace, fitted):
    # Existing activation servers do not inherit exec rules. Apply
    # placement only to this newly mapped, attributed window, atomically
    # checking compositor stable ID and PID before any dispatch.
    selector = json.dumps("address:" + window["address"])
    guard = ("local w=hl.get_window(" + selector + "); assert(w and w.mapped and w.stable_id=="
             + str(int(window["stableId"], 16)) + " and w.pid==" + str(window["pid"]) + "); ")
    operations = ["set_prop({window=" + selector + ",prop='focus_on_activate',value='false'})",
                  "float({window=" + selector + ",action='set'})",
                  "move({window=" + selector + ",workspace=" + json.dumps(str(workspace)) + ",follow=false})",
                  "resize({window=" + selector + ",x=" + str(fitted["width"]) + ",y=" + str(fitted["height"]) + ",relative=false})",
                  "center({window=" + selector + "})"]
    guard += ("local a=hl.get_active_window(); assert(not (a and a.address==w.address "
              + "and a.stable_id==w.stable_id), 'Opening target is receiving owner input'); ")
    reply = transport._exchange("eval " + guard + "; ".join("hl.dispatch(hl.dsp.window." + operation + ")" for operation in operations))
    if reply.strip() != "ok":
        raise SessionError("New application window placement was not acknowledged")
