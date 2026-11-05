"""Open a real owner application, preserving its normal profile and lifetime."""
import json
import math
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
from .window_placement import PlacementUnavailable, place_new_window
from .opening_identity import opening_identity
from .opening_evidence import ConstraintSampleChanged, existing_processes, forwarding_proven, native_constraints, minimum_outcome


def validate_open(value):
    if not isinstance(value, dict) or set(value) - {"workspace", "argv", "cwd", "window", "busName", "requireEmpty"} or not {"workspace", "argv"} <= set(value):
        raise SessionError("Opening requires workspace and argv")
    if "requireEmpty" in value and type(value["requireEmpty"]) is not bool:
        raise SessionError("Invalid empty workspace guard")
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
    return {**({"requireEmpty": True} if value.get("requireEmpty") else {}), **({"busName": bus_name} if bus_name else {}), "workspace": workspace, "argv": arguments, "window": window_size(value.get("window")), **({"cwd": cwd} if cwd else {})}


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


def _outcome_number(value):
    try:
        return type(value) in (int, float) and value > 0 and math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        return False


def _outcome_size(value):
    """Copy only measured numeric dimensions, never infer a missing or invalid size."""
    if not isinstance(value, dict) or any(not _outcome_number(value.get(key)) for key in ("width", "height")):
        return None
    return {key: value[key] for key in ("width", "height")}


def opening_outcome(window, requested, *, launcher_root=None, ancestry_proven=False,
                    placement_request=None, sampled_at_ms=None, forwarded=False, constraints=None):
    """Describe one already sampled window, not application constraints or future stability.

    ancestry_proven is supplied only by the successful belongs_to branch at attribution.
    The receipt root may exec a launcher or systemd-run; it is not an executable identity.
    Token attribution and scope membership do not establish forwarding or process ancestry.
    """
    root_valid = (isinstance(launcher_root, (list, tuple)) and len(launcher_root) == 2
                  and all(type(value) is int and value > 0 for value in launcher_root))
    window_pid = window.get("pid")
    pid_valid = type(window_pid) is int and window_pid > 0
    proven = ancestry_proven is True and root_valid and pid_valid
    forwarded = forwarded is True and root_valid and pid_valid and not proven
    relation = ("same" if window_pid == launcher_root[0] else "descendant") if proven else "pre-existing" if forwarded else "unknown"
    size = window.get("size")
    actual = _outcome_size({"width": size[0], "height": size[1]}) if isinstance(size, list) and len(size) == 2 else None
    requested = _outcome_size(requested)
    difference = ({key: actual[key] - requested[key] for key in ("width", "height")}
                  if actual is not None and requested is not None else None)
    comparison = ("matched" if all(abs(value) <= 2 for value in difference.values()) else "mismatched") if difference is not None else "unknown"
    timestamp = sampled_at_ms if type(sampled_at_ms) is int and sampled_at_ms >= 0 else None
    return {
        "process": {"launchProcessPid": launcher_root[0] if root_valid else None,
                    "launchProcessKind": "registration-launch-scope-helper", "windowPid": window_pid if pid_valid else None,
                    "relation": relation, "evidence": "live-launch-ancestry-at-attribution" if proven else "activation-token-and-prelaunch-process" if forwarded else "unknown",
                    "forwarded": True if forwarded else False if proven else "unknown"},
        "geometry": {"requested": requested, "placementRequest": _outcome_size(placement_request),
                     "actual": actual, "comparison": comparison, "difference": difference, "tolerancePx": 2,
                     "sampledAtMs": timestamp, "clock": "local-wall-at-compositor-reply",
                     "source": "compositor-window-list", "stability": "not-established",
                     **minimum_outcome(actual, _outcome_size(placement_request), constraints), "futureGeometry": "unknown"},
    }


def candidate_result(window, value, evidence, *, existing=False, reason=None, launcher_root=None,
                     ancestry_proven=False, placement_request=None, sampled_at_ms=None, forwarded=False):
    return {"openingOutcome": opening_outcome(window, value["window"], launcher_root=launcher_root,
                ancestry_proven=ancestry_proven, placement_request=placement_request, sampled_at_ms=sampled_at_ms,
                forwarded=forwarded),
        "opened": False, "openingStatus": "forwarded" if forwarded else "uncertain", "launchAcknowledged": True, "reusedExisting": existing,
        "identityEvidence": evidence, "attribution": "candidate-only",
        "requestedWorkspace": value["workspace"], "requestedWindow": value["window"],
        "candidate": {"address": window["address"], "stableId": window["stableId"], "pid": window["pid"],
            "workspace": window.get("workspace", {}).get("id"), "title": str(window.get("title", ""))[:160]},
        "candidates": [{"address": window["address"], "stableId": window["stableId"], "pid": window["pid"],
            "workspace": window.get("workspace", {}).get("id")}],
        "placementChanged": False, "applicationLifetime": "owner",
        **({"candidateReason": reason} if reason else {}),
        "handoff": "Inspect this candidate before selecting an exact handoff. Orbit applied no post-map placement and leaves ownership unchanged. Application activation and initial geometry may already have changed."}


def uncertain_candidates(windows, value, reason):
    """Do not choose or place one of several attributed windows."""
    candidates = []
    for window in windows[:64]:
        if (not re.fullmatch(r"0x[0-9a-f]{1,16}", str(window.get("address")))
                or not re.fullmatch(r"[0-9a-f]{1,16}", str(window.get("stableId")))
                or type(window.get("pid")) is not int or window["pid"] <= 0):
            raise OpeningDeliveryUncertain("Opening delivery is uncertain: attributed candidates lack stable identities")
        candidates.append({"address": window["address"], "stableId": window["stableId"], "pid": window["pid"],
                           "workspace": window.get("workspace", {}).get("id")})
    return {"opened": False, "openingStatus": "uncertain", "launchAcknowledged": True,
            "requestedWorkspace": value["workspace"], "requestedWindow": value["window"],
            "candidateReason": reason, "candidates": candidates, "candidatesTruncated": len(windows) > 64,
            "placementChanged": False, "applicationLifetime": "owner",
            "handoff": "Inspect the candidates before selecting an exact handoff; do not relaunch blindly."}


# A window that maps from a launch takes seat focus by itself. Treat that as map time focus, and
# place it, only while the compositor shows no owner pointer movement since the request and the
# window was first seen moments ago. A keyboard has no compositor record, so the grace is bounded.
MAP_FOCUS_GRACE = 0.5
POINTER_MOVED = 2


def cursor_position(session):
    """The compositor pointer position, or None when it cannot be read (then no map time claim)."""
    try:
        value = json.loads(session.transport._exchange("j/cursorpos"))
        return float(value["x"]), float(value["y"])
    except (TimeoutError, ValueError, KeyError, TypeError, SessionError):
        return None


def owner_pointer_moved(before, after):
    if before is None or after is None:
        return True
    return abs(before[0] - after[0]) >= POINTER_MOVED or abs(before[1] - after[1]) >= POINTER_MOVED


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
            preexisting = existing_processes(clients, existing)
            baseline_cursor = cursor_position(session)
            with spec.open("x") as stream:
                os.chmod(spec, 0o600)
                json.dump({"argv": value["argv"], "scope": unit, "activationToken": token, "receipt": str(receipt), "expires": time.time() + 15, **({"cwd": value["cwd"]} if "cwd" in value else {})}, stream)
            helper = Path(__file__).with_name("owner_open_helper.py")
            command = shlex.join(["/usr/bin/python3", str(helper), str(spec)])
            rules = f"[workspace {value['workspace']} silent; float; size {fitted['width']} {fitted['height']}; center; no_initial_focus on; focus_on_activate off]"
            lua = "eval hl.exec_cmd(" + json.dumps(command, ensure_ascii=False) + ", {workspace=" + json.dumps(str(value["workspace"]) + " silent") + ", no_initial_focus=true, focus_on_activate=false})"
            lua = lua[:-2] + ", float=true, size=" + json.dumps(str(fitted["width"]) + " " + str(fitted["height"])) + ", center=true})"
            if value.get("requireEmpty"):
                from .workspace_inventory import workspace_inventory
                inventory = workspace_inventory(session.transport)
                if value["workspace"] in inventory["occupied"] or value["workspace"] in inventory["shown"]:
                    raise SessionError("Selected workspace is occupied or displayed; no application was launched")
            launch_attempted = True
            response = session.transport._exchange(lua)
            if response.strip() == "eval is only supported with the lua config manager":
                if value.get("requireEmpty"):
                    inventory = workspace_inventory(session.transport)
                    if value["workspace"] in inventory["occupied"] or value["workspace"] in inventory["shown"]:
                        raise OpeningDeliveryUncertain("Selected workspace became unavailable before fallback; inspect without relaunching")
                response = session.transport._exchange("dispatch exec " + rules + " " + command)
            if response.strip() != "ok":
                raise SessionError("Application opening was not acknowledged: " + response.strip()[:160])
            bus_client = existing
            next_bus_lookup = 0
            positioned = set()
            map_focus_placed = set()
            map_first_seen = {}
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
                    current_reply = session.transport._exchange("j/clients")
                    sampled_at_ms = time.time_ns() // 1_000_000
                    current = json.loads(current_reply)
                    existing_targets = [window for window in current
                        if (window.get("address"), window.get("stableId")) in activated & baseline]
                    if len(existing_targets) > 1:
                        return uncertain_candidates(existing_targets, value, "multiple-existing-activation-targets")
                    if existing_targets:
                        return candidate_result(existing_targets[0], value, "activation-token", existing=True,
                                                launcher_root=root, placement_request=fitted, sampled_at_ms=sampled_at_ms)
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
                        return uncertain_candidates(matches, value, "multiple-attributed-windows")
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
                            return candidate_result(window, value, "registered-dbus-client", launcher_root=root,
                                                    placement_request=fitted, sampled_at_ms=sampled_at_ms)
                        identity = (window["address"], window["stableId"])
                        first_seen = map_first_seen.setdefault(identity, time.perf_counter())
                        focused = (current_focus.get("address") == window["address"]
                                   and current_focus.get("stableId") == window["stableId"]
                                   and current_focus.get("pid") == window["pid"])
                        map_focus = (focused and identity not in positioned
                                     and time.perf_counter() - first_seen <= MAP_FOCUS_GRACE
                                     and not owner_pointer_moved(baseline_cursor, cursor_position(session)))
                        if focused and identity in map_focus_placed and not owner_pointer_moved(baseline_cursor, cursor_position(session)):
                            focused = False
                        if focused and not map_focus:
                            if identity in positioned:
                                raise OpeningDeliveryUncertain("Opening delivery is uncertain: owner input reached the candidate after post-map placement. Inspect its current state without relaunching or refocusing")
                            return candidate_result(window, value, evidence[window["address"]], reason="owner-input",
                                                    launcher_root=root, ancestry_proven=evidence[window["address"]] == "launch-ancestry",
                                                    placement_request=fitted, sampled_at_ms=sampled_at_ms)
                        forwarded = forwarding_proven(window, root, preexisting, activated)
                        if (not forwarded and evidence[window["address"]] == "activation-token"
                                and window.get("pid") in preexisting and time.perf_counter() - first_seen < 1):
                            # Sample normal single-instance launcher exit without
                            # replaying launch or placement after a lost reply.
                            time.sleep(0.05)
                            continue
                        if evidence[window["address"]] != "launch-ancestry" and identity not in positioned:
                            if value.get("requireEmpty"):
                                destination = workspace_inventory(session.transport, exclude=(window["address"], window["stableId"], window["pid"]))
                                if value["workspace"] in destination["occupied"] or value["workspace"] in destination["shown"]:
                                    return candidate_result(window, value, evidence[window["address"]],
                                        reason="workspace-busy", launcher_root=root, placement_request=fitted, sampled_at_ms=sampled_at_ms)
                            try:
                                place_new_window(session.transport, window, value["workspace"], fitted, allow_active=map_focus)
                            except PlacementUnavailable:
                                return candidate_result(window, value, evidence[window["address"]],
                                    reason="placement-unavailable", launcher_root=root,
                                    placement_request=fitted, sampled_at_ms=sampled_at_ms, forwarded=forwarded)
                            positioned.add(identity)
                            if map_focus:
                                map_focus_placed.add(identity)
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
                        try:
                            constraints = native_constraints(session.transport, window)
                        except ConstraintSampleChanged:
                            # The query proves the same window resized after the
                            # client-list sample. Reobserve within this launch's
                            # original deadline, without replaying any mutation.
                            time.sleep(0.05)
                            continue
                        return {**adjustment, "openingStatus": "forwarded" if forwarded else "opened",
                                "openingOutcome": opening_outcome(window, value["window"], launcher_root=root,
                                    ancestry_proven=evidence[window["address"]] == "launch-ancestry",
                                    placement_request=fitted, sampled_at_ms=sampled_at_ms,
                                    forwarded=forwarded, constraints=constraints),
                                "identityEvidence": evidence[window["address"]], "opened": True, "windowProtocol": "xwayland" if window.get("xwayland") else "wayland", "window": measured, "requestedWindow": value["window"], "workspace": value["workspace"], "address": window["address"],
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
