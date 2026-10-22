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
from .session import SessionError, OpeningDeliveryUncertain
from .window_geometry import window_size, placement, measured_window
from .launch_identity import BUS_NAME, OriginalLaunchScope, registered_client
from .window_placement import place_new_window
from .opening_identity import opening_identity


def validate_open(value):
    if not isinstance(value, dict) or set(value) - {"workspace", "argv", "cwd", "window", "busName"} or not {"workspace", "argv"} <= set(value):
        raise SessionError("Opening requires workspace and argv")
    workspace, argv = value["workspace"], value["argv"]
    if type(workspace) is not int or not 1 <= workspace <= 2147483647:
        raise SessionError("Opening requires a positive workspace number")
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 128
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
    bus_name = value.get("busName")
    if bus_name is not None and (not isinstance(bus_name, str) or not BUS_NAME.fullmatch(bus_name)):
        raise SessionError("Application registration has an invalid bus name")
    return {**({"busName": bus_name} if bus_name else {}), "workspace": workspace, "argv": arguments, "window": window_size(value.get("window")), **({"cwd": cwd} if cwd else {})}


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


def candidate_result(window, value, evidence, *, existing=False, reason=None):
    return {"opened": False, "launchAcknowledged": True, "reusedExisting": existing,
        "identityEvidence": evidence, "attribution": "candidate-only",
        "requestedWorkspace": value["workspace"], "requestedWindow": value["window"],
        "candidate": {"address": window["address"], "stableId": window["stableId"], "pid": window["pid"],
            "workspace": window.get("workspace", {}).get("id"), "title": str(window.get("title", ""))[:160]},
        "placementChanged": False, "applicationLifetime": "owner",
        **({"candidateReason": reason} if reason else {}),
        "handoff": "Inspect this candidate before selecting an exact handoff. Orbit applied no post-map placement and leaves ownership unchanged. Application activation and initial geometry may already have changed."}


def open_application(session, value):
    require_budget()
    value = validate_open(value)
    request = "native-open " + json.dumps(value, sort_keys=True, separators=(",", ":"))
    launch_attempted = False

    def launch():
        nonlocal launch_attempted
        directory = private_directory(session.directory)
        token = uuid.uuid4().hex
        with opening_identity(session.transport, token) as activation:
            existing = registered_client(value.get("busName"))
            unit = "orbit-open-" + token + ".scope"
            scope = OriginalLaunchScope(unit)
            spec = directory / ("open-" + token + ".json")
            receipt = directory / ("opened-" + token + ".json")
            workspaces = json.loads(session.transport._exchange("j/workspaces"))
            monitors = json.loads(session.transport._exchange("j/monitors"))
            fitted = placement(value["workspace"], value["window"], workspaces, monitors)
            clients = json.loads(session.transport._exchange("j/clients"))
            baseline = {(window["address"], window.get("stableId")) for window in clients}
            with spec.open("x") as stream:
                os.chmod(spec, 0o600)
                json.dump({"argv": value["argv"], "scope": unit, "activationToken": token, "receipt": str(receipt), "expires": time.time() + 15, **({"cwd": value["cwd"]} if "cwd" in value else {})}, stream)
            helper = Path(__file__).with_name("owner_open_helper.py")
            command = shlex.join(["/usr/bin/python3", str(helper), str(spec)])
            rules = f"[workspace {value['workspace']} silent; float; size {fitted['width']} {fitted['height']}; center; no_initial_focus on; focus_on_activate off]"
            lua = "eval hl.exec_cmd(" + json.dumps(command, ensure_ascii=False) + ", {workspace=" + json.dumps(str(value["workspace"]) + " silent") + ", no_initial_focus=true, focus_on_activate=false})"
            lua = lua[:-2] + ", float=true, size=" + json.dumps(str(fitted["width"]) + " " + str(fitted["height"])) + ", center=true})"
            launch_attempted = True
            response = session.transport._exchange(lua)
            if response.strip() == "eval is only supported with the lua config manager":
                response = session.transport._exchange("dispatch exec " + rules + " " + command)
            if response.strip() != "ok":
                raise SessionError("Application opening was not acknowledged: " + response.strip()[:160])
            bus_client = existing
            next_bus_lookup = 0
            positioned = set()
            candidate_first_seen = {}
            # Cold original applications can need more than thirty seconds to map.
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if receipt.exists():
                    root = json.loads(receipt.read_text())
                    if (not isinstance(root, list) or len(root) != 2
                            or any(type(number) is not int or number <= 0 for number in root)):
                        raise SessionError("Invalid application launch receipt")
                    if value.get("busName") and bus_client is None and time.monotonic() >= next_bus_lookup:
                        bus_client = registered_client(value["busName"])
                        next_bus_lookup = time.monotonic() + 0.25
                    current_focus = json.loads(session.transport._exchange("j/activewindow"))
                    try:
                        activated = activation.windows()
                    except TimeoutError:
                        # This query is read-only. Never retry the launch or a
                        # placement mutation after an uncertain acknowledgement.
                        time.sleep(0.05)
                        continue
                    current = json.loads(session.transport._exchange("j/clients"))
                    existing_targets = [window for window in current
                        if (window.get("address"), window.get("stableId")) in activated & baseline]
                    if len(existing_targets) > 1:
                        raise SessionError("Activation selected multiple existing windows; inspect candidates")
                    if existing_targets:
                        return candidate_result(existing_targets[0], value, "activation-token", existing=True)
                    evidence = {}
                    matches = []
                    for window in current:
                        if (window.get("address"), window.get("stableId")) in baseline:
                            continue
                        pid = window.get("pid")
                        if belongs_to(pid, root):
                            proof = "launch-ancestry"
                        elif (window.get("address"), window.get("stableId")) in activated:
                            proof = "activation-token"
                        elif bus_client is not None and belongs_to(pid, bus_client.process) and bus_client.verify():
                            proof = "registered-dbus-client"
                        elif scope.contains(pid):
                            proof = "launch-scope"
                        else:
                            continue
                        matches.append(window)
                        evidence[window["address"]] = proof
                    if len(matches) > 1:
                        raise SessionError("Application opened multiple windows; inspect exact candidates before choosing a handoff")
                    if matches:
                        window = matches[0]
                        if (not re.fullmatch(r"0x[0-9a-f]{1,16}", str(window.get("address")))
                                or not re.fullmatch(r"[0-9a-f]{1,16}", str(window.get("stableId")))):
                            raise SessionError("Opened application has no stable compositor window identity")
                        if evidence[window["address"]] == "registered-dbus-client":
                            identity = (window["address"], window["stableId"])
                            now = time.monotonic()
                            first = candidate_first_seen.setdefault(identity, now)
                            if now - first < 1:
                                time.sleep(0.05)
                                continue
                            # A shared activation process can also map owner-created
                            # windows. Process identity is not a launch correlation.
                            return candidate_result(window, value, "registered-dbus-client")
                        identity = (window["address"], window["stableId"])
                        if (current_focus.get("address") == window["address"]
                                and current_focus.get("stableId") == window["stableId"]
                                and current_focus.get("pid") == window["pid"]):
                            if identity in positioned:
                                raise OpeningDeliveryUncertain("Opening delivery is uncertain: owner input reached the candidate after post-map placement. Inspect its current state without relaunching or refocusing")
                            return candidate_result(window, value, evidence[window["address"]], reason="owner-input")
                        if evidence[window["address"]] != "launch-ancestry" and identity not in positioned:
                            place_new_window(session.transport, window, value["workspace"], fitted)
                            positioned.add(identity)
                            time.sleep(0.05)
                            continue
                        if window.get("workspace", {}).get("id") != value["workspace"]:
                            raise SessionError("Application did not open on the requested workspace")
                        # A newly instantiated workspace may be bound to another monitor.
                        # Measure its actual work area rather than the initially focused monitor.
                        actual_fit = placement(value["workspace"], value["window"], json.loads(session.transport._exchange("j/workspaces")), json.loads(session.transport._exchange("j/monitors")))
                        measured = measured_window(window, actual_fit, allow_adjusted=True)
                        if measured is None:
                            time.sleep(0.05)
                            continue
                        adjustment = {} if (abs(measured["width"] - actual_fit["width"]) <= 2 and abs(measured["height"] - actual_fit["height"]) <= 2) else {
                            "windowAdjustment": {"reason": "observed-size-difference", "requested": value["window"],
                                                 "actual": {"width": measured["width"], "height": measured["height"]}}}
                        return {**adjustment, "identityEvidence": evidence[window["address"]], "opened": True, "windowProtocol": "xwayland" if window.get("xwayland") else "wayland", "window": measured, "requestedWindow": value["window"], "workspace": value["workspace"], "address": window["address"],
                                "stableId": window["stableId"], "pid": window["pid"],
                                "title": str(window.get("title", ""))[:160], "applicationLifetime": "owner",
                                "handoff": "explicit native handoff with a compatible prepared plugin"}
                time.sleep(0.05)
            raise OpeningDeliveryUncertain("Opening delivery is uncertain: no launch-bound window acknowledged. Check candidates before retrying; no new window identity was verified")

    try:
        return session.control.execute(request, launch)
    except Exception as error:
        if launch_attempted and not isinstance(error, OpeningDeliveryUncertain):
            raise OpeningDeliveryUncertain("Opening delivery is uncertain: a launch was attempted. Inspect native candidates and reuse the same requestId; do not launch again blindly") from error
        raise
