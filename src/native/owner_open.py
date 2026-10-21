"""Open a real owner application, preserving its normal profile and lifetime."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import time
import uuid

from .application import private_directory
from .budget import require_budget
from .lease import process_identity
from .session import SessionError
from .window_geometry import window_size, placement, measured_window


def validate_open(value):
    if not isinstance(value, dict) or set(value) - {"workspace", "argv", "cwd", "window"} or not {"workspace", "argv"} <= set(value):
        raise SessionError("Opening requires workspace and argv")
    workspace, argv = value["workspace"], value["argv"]
    if type(workspace) is not int or not 1 <= workspace <= 2147483647:
        raise SessionError("Opening requires a positive workspace number")
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 64
            or any(not isinstance(arg, str) or len(arg.encode()) > 4096
                   or any(char in arg for char in ("\0", "\n", "\r")) for arg in argv)
            or not argv[0] or sum(len(arg.encode()) for arg in argv) > 16384):
        raise SessionError("Opening requires bounded single-line application arguments")
    executable = shutil.which(argv[0], path="/usr/bin:/bin")
    if executable is None:
        raise SessionError("Application executable was not found")
    # which may preserve a relative path. The compositor helper has another cwd.
    executable = str(Path(executable).absolute())
    arguments = [executable, *argv[1:]]
    cwd = value.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir()):
        raise SessionError("Application working directory is unavailable")
    return {"workspace": workspace, "argv": arguments, "window": window_size(value.get("window")), **({"cwd": cwd} if cwd else {})}


def belongs_to(pid, root):
    """Bind a returned window to the actual launch, rather than its workspace."""
    if type(pid) is not int or process_identity(root[0]) != tuple(root):
        return False
    for _ in range(64):
        if pid == root[0]:
            return process_identity(pid) == tuple(root)
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            pid = int(fields[1])
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            return False
        if pid <= 1:
            return False
    return False


def open_application(session, value):
    require_budget()
    value = validate_open(value)
    request = "native-open " + json.dumps(value, sort_keys=True, separators=(",", ":"))

    def launch():
        directory = private_directory(session.directory)
        token = uuid.uuid4().hex
        spec = directory / ("open-" + token + ".json")
        receipt = directory / ("opened-" + token + ".json")
        fitted = placement(value["workspace"], value["window"], json.loads(session.transport._exchange("j/workspaces")), json.loads(session.transport._exchange("j/monitors")))
        baseline = {window["address"] for window in json.loads(session.transport._exchange("j/clients"))}
        with spec.open("x") as stream:
            os.chmod(spec, 0o600)
            json.dump({"argv": value["argv"], "receipt": str(receipt), "expires": time.time() + 15, **({"cwd": value["cwd"]} if "cwd" in value else {})}, stream)
        helper = Path(__file__).with_name("owner_open_helper.py")
        command = shlex.join(["/usr/bin/python3", str(helper), str(spec)])
        rules = f"[workspace {value['workspace']} silent; float; size {fitted['width']} {fitted['height']}; center; no_initial_focus on; focus_on_activate off]"
        lua = "eval hl.exec_cmd(" + json.dumps(command, ensure_ascii=False) + ", {workspace=" + json.dumps(str(value["workspace"]) + " silent") + ", no_initial_focus=true, focus_on_activate=false})"
        lua = lua[:-2] + ", float=true, size=" + json.dumps(str(fitted["width"]) + " " + str(fitted["height"])) + ", center=true})"
        response = session.transport._exchange(lua)
        if response.strip() == "eval is only supported with the lua config manager":
            response = session.transport._exchange("dispatch exec " + rules + " " + command)
        if response.strip() != "ok":
            raise SessionError("Application opening was not acknowledged: " + response.strip()[:160])
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if receipt.exists():
                root = json.loads(receipt.read_text())
                if (not isinstance(root, list) or len(root) != 2
                        or any(type(number) is not int or number <= 0 for number in root)):
                    raise SessionError("Invalid application launch receipt")
                matches = [window for window in json.loads(session.transport._exchange("j/clients"))
                           if window.get("address") not in baseline and belongs_to(window.get("pid"), root)]
                if len(matches) > 1:
                    raise SessionError("Application opened multiple windows; inspect candidates, owner handoff remains unavailable")
                if matches:
                    window = matches[0]
                    if window.get("workspace", {}).get("id") != value["workspace"]:
                        raise SessionError("Application did not open on the requested workspace")
                    if (window.get("xwayland") or not re.fullmatch(r"0x[0-9a-f]{1,16}", str(window.get("address")))
                            or not re.fullmatch(r"[0-9a-f]{1,16}", str(window.get("stableId")))):
                        raise SessionError("Opened application has no supported Wayland handoff identity")
                    measured = measured_window(window, fitted)
                    if measured is None:
                        time.sleep(0.05)
                        continue
                    return {"opened": True, "window": measured, "requestedWindow": value["window"], "workspace": value["workspace"], "address": window["address"],
                            "stableId": window["stableId"], "pid": window["pid"],
                            "title": str(window.get("title", ""))[:160], "applicationLifetime": "owner",
                            "handoff": "held pending compositor crash release evidence"}
            time.sleep(0.05)
        raise SessionError("Opening delivery is uncertain: no launch-bound window acknowledged. Check candidates before retrying; single-instance forwarding is not verified")

    return session.control.execute(request, launch)
