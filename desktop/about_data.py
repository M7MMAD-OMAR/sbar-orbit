"""What the About page knows, and the two things it can do, without a toolkit.

Every fact comes from a command Orbit already owns, so this module is a reader and a caller, never a
second opinion. The seam is one function, `run(argv, timeout) -> (returncode, stdout)`; tests pass a fake
and the page passes `default_run`. Nothing here imports GTK.

Sources, one per fact:
  version          package.json beside this checkout or installed package
  plugin source    sha256 of experiments/ghost-cursor/plugin/ghostinput.cpp in this installation, the same
                   file `src/native/plugin_compatibility.py` hashes at handoff
  loaded plugin    `sbar-orbit native-plugin status DIR`, which asks the compositor (`ghost-build-info`)
  expected ABI     `abi_hash` in the host plan `current/host.json`
  broker, sessions `sbar-orbit doctor` and `sbar-orbit status`
  uptime           systemd MainPID, then `ps -o etimes=`
  updates          `sbar-orbit update status|check|stage|activate`, which hold the idle lease, the
                   serialized activation and the health check from docs/updates.md

Safety: `update_now` never calls `activate` while a session is open and `stop_idle` stops only sessions
that are not working. Neither forces anything, and a broker with active work is never restarted.
"""
import hashlib
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_SOURCE = os.path.join("experiments", "ghost-cursor", "plugin", "ghostinput.cpp")
SERVICE = "sbar-orbit.service"


def launcher(root=ROOT):
    return os.path.join(root, "bin", "sbar-orbit")


def default_run(argv, timeout=30):
    """(returncode, stdout) or (-1, "") when the command could not run at all."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return -1, ""
    return done.returncode, done.stdout


def parse(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def orbit_json(run, args, timeout=30, root=ROOT):
    """The launcher's JSON answer, unwrapped from the `{"ok": true, "result": ...}` envelope when present.
    None when it could not answer, so a caller shows 'unknown' instead of a wrong value."""
    code, out = run([launcher(root), *args], timeout)
    value = parse(out)
    if isinstance(value, dict) and "ok" in value and "result" in value:
        return value["result"] if value["ok"] else None
    return value


def data_home(env=None):
    env = os.environ if env is None else env
    return os.path.join(env.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share"), "sbar-orbit")


def installed_version(root=ROOT):
    try:
        with open(os.path.join(root, "package.json"), encoding="utf8") as handle:
            return json.load(handle).get("version")
    except (OSError, ValueError):
        return None


def sha256_of(path):
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def prepared_directory(home):
    """The preparation directory the broker binds, from the env file the broker unit reads."""
    try:
        with open(os.path.join(home, "native", "broker-native.env"), encoding="utf8") as handle:
            for line in handle:
                key, _, value = line.strip().partition("=")
                if key == "ORBIT_NATIVE_PLAN":
                    return os.path.dirname(os.path.realpath(value.strip('"')))
    except OSError:
        pass
    return None


def short(digest):
    return digest[:12] if isinstance(digest, str) else None


def plugin_status(run, root=ROOT, home=None):
    """Whether the plugin the compositor loaded is the one handoff would accept.

    state is one of match, not_prepared, not_loaded, abi_mismatch, source_mismatch, unknown. The order of
    the checks is the order `require_native_plugin` uses: ABI first, then source."""
    home = home or data_home()
    installed = sha256_of(os.path.join(root, PLUGIN_SOURCE))
    directory = prepared_directory(home)
    base = {"state": "unknown", "installedSource": short(installed), "loadedSource": None,
            "abi": None, "expectedAbi": None, "directory": directory}
    if directory is None:
        return {**base, "state": "not_prepared"}
    try:
        with open(os.path.join(directory, "host.json"), encoding="utf8") as handle:
            plan = parse(handle.read())
    except OSError:
        plan = None
    expected = plan.get("abi_hash") if isinstance(plan, dict) else None
    base["expectedAbi"] = expected
    status = orbit_json(run, ["native-plugin", "status", directory], 30, root)
    if not isinstance(status, dict):
        return base
    if not status.get("loaded"):
        return {**base, "state": "not_loaded"}
    build = status.get("build") if isinstance(status.get("build"), dict) else {}
    loaded, abi = build.get("source_sha256"), build.get("abi_hash")
    base.update(loadedSource=short(loaded), abi=abi)
    if not isinstance(loaded, str) or not isinstance(abi, str) or not isinstance(expected, str) or installed is None:
        return base
    if abi != expected:
        return {**base, "state": "abi_mismatch"}
    if loaded != installed:
        return {**base, "state": "source_mismatch"}
    return {**base, "state": "match"}


def broker_uptime(run):
    """Seconds the broker unit has run, or None. Not read from the broker: it does not report one."""
    code, out = run(["systemctl", "--user", "show", SERVICE, "-p", "MainPID", "-p", "ActiveState"], 10)
    fields = dict(line.partition("=")[::2] for line in out.splitlines())
    pid = fields.get("MainPID", "0")
    if code != 0 or fields.get("ActiveState") != "active" or not pid.isdigit() or int(pid) == 0:
        return None
    code, out = run(["ps", "-o", "etimes=", "-p", pid], 10)
    return int(out.strip()) if code == 0 and out.strip().isdigit() else None


def session_rows(listing):
    """Open sessions (anything not closed counts, as `activateVersion` counts them) in a small shape."""
    rows = []
    for session in listing if isinstance(listing, list) else []:
        if not isinstance(session, dict) or session.get("state") == "closed":
            continue
        activity = session.get("activity") if isinstance(session.get("activity"), dict) else {}
        handoff = session.get("handoff") if isinstance(session.get("handoff"), dict) else {}
        windows = handoff.get("windows") if isinstance(handoff.get("windows"), list) else []
        title = next((w.get("title") for w in windows if isinstance(w, dict) and w.get("title")), "")
        rows.append({"id": session.get("sessionId"), "state": session.get("state"),
                     "agent": session.get("agentName") or "", "task": session.get("taskName") or "",
                     "working": activity.get("state") == "working", "window": title,
                     "workspace": handoff.get("workspace")})
    return rows


def open_sessions(run, root=ROOT):
    """None when the broker did not answer."""
    listing = orbit_json(run, ["session", "list"], 20, root)
    return None if listing is None else session_rows(listing)


def collect(run=default_run, root=ROOT, home=None):
    """Everything the page draws, in one dict. Slow (a few commands); call it off the main thread."""
    doctor = orbit_json(run, ["doctor"], 30, root)
    status = orbit_json(run, ["status"], 20, root)
    update = orbit_json(run, ["update", "status"], 30, root)
    reachable = isinstance(doctor, dict)
    sessions = session_rows(status.get("sessions")) if isinstance(status, dict) else []
    units = doctor.get("units") if reachable and isinstance(doctor.get("units"), dict) else {}
    healthy = reachable and units.get("drifted", []) == [] and units.get("missing", []) == [] and units.get("current", True)
    return {
        "version": installed_version(root),
        "brokerVersion": doctor.get("version") if reachable else None,
        "broker": {"reachable": reachable, "healthy": bool(healthy), "uptimeSeconds": broker_uptime(run) if reachable else None,
                   "units": units},
        "sessions": sessions,
        "activeSessions": sum(1 for row in sessions if row["working"]),
        "plugin": plugin_status(run, root, home),
        "update": update_summary(update),
    }


def update_summary(update):
    if not isinstance(update, dict):
        return {"managed": False, "reason": None, "pending": [], "prepared": [], "current": None}
    return {"managed": bool(update.get("managed")), "reason": update.get("reason"), "pending": update.get("pending") or [],
            "prepared": update.get("prepared") or [], "current": update.get("current"),
            "automatic": bool(update.get("automatic"))}


def check_for_update(run=default_run, root=ROOT):
    """Ask the registry (the feed `update check` reads, no owner data sent) and say what it found.

    state: available, current, unknown. `latest` is the newest published, `eligible` the one that has
    matured past the hold the update policy applies."""
    found = orbit_json(run, ["update", "check"], 60, root)
    if not isinstance(found, dict):
        return {"state": "unknown", "latest": None, "eligible": None, "reason": "The registry did not answer"}
    eligible = found.get("eligible") if isinstance(found.get("eligible"), dict) else None
    version = eligible.get("version") if eligible else None
    latest = found.get("latest")
    waiting = bool(latest) and not version and latest != found.get("current")
    return {"state": "available" if version else "current", "latest": latest, "eligible": version,
            "reason": found.get("reason") or "", "waiting": waiting}


def update_now(run=default_run, root=ROOT):
    """Prepare the eligible version and activate it at a safe moment.

    Returns {state, ...} with state one of
      unmanaged  this install is not under managed versions (a source checkout updates with git)
      current    nothing newer
      blocked    sessions are open; `blockers` lists them and nothing was restarted
      updated    activated, `version` is the new one
      failed     preparation, activation or health check failed, `reason` says why
    Never forces: activation itself refuses while a session is open, and this checks first."""
    status = orbit_json(run, ["update", "status"], 30, root)
    if not isinstance(status, dict):
        return {"state": "failed", "reason": "Orbit could not read its update state"}
    if not status.get("managed"):
        return {"state": "unmanaged", "reason": status.get("reason") or ""}
    found = check_for_update(run, root)
    version = found.get("eligible")
    if found["state"] == "unknown":
        return {"state": "failed", "reason": found["reason"]}
    if not version:
        pending = status.get("pending") or []
        if not pending:
            return {"state": "current", "reason": found.get("reason") or ""}
        version = pending[-1]
    else:
        code, out = run([launcher(root), "update", "stage"], 900)
        prepared = parse(out)
        if code != 0 or not isinstance(prepared, dict) or not prepared.get("prepared"):
            reason = prepared.get("reason") if isinstance(prepared, dict) else None
            return {"state": "failed", "reason": reason or "Preparing the new version failed"}
    blockers = open_sessions(run, root)
    if blockers:
        return {"state": "blocked", "version": version, "blockers": blockers}
    code, out = run([launcher(root), "update", "activate", version], 180)
    outcome = parse(out)
    if not isinstance(outcome, dict):
        return {"state": "failed", "reason": "Activation gave no answer"}
    if outcome.get("activated"):
        return {"state": "updated", "version": outcome.get("version") or version, "previous": outcome.get("previous")}
    if outcome.get("openSessions"):
        return {"state": "blocked", "version": version, "blockers": open_sessions(run, root) or []}
    return {"state": "failed", "reason": outcome.get("reason") or "Activation was refused",
            "rolledBack": bool(outcome.get("rolledBack"))}


def stop_idle(blockers, run=default_run, root=ROOT):
    """Stop the sessions that are not working. A working session is left alone, whatever the caller
    asks: stopping it is the owner's decision from its own card, not a side effect of updating.
    Returns (stopped, left) as lists of session ids."""
    stopped, left = [], []
    for row in blockers:
        if row.get("working") or not row.get("id"):
            left.append(row.get("id"))
            continue
        code, _ = run([launcher(root), "session", "stop", row["id"]], 60)
        (stopped if code == 0 else left).append(row["id"])
    return stopped, left
