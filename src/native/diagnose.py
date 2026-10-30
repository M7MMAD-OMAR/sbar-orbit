#!/usr/bin/python3
"""Read-only agreement check between the live compositor, the prepared plan, the plugin build and the loaded plugin.

Every disagreement becomes a named problem with the command that fixes it, so a stale plan, an
upgraded but not restarted compositor or an unloaded plugin never reaches an agent as a bare
"Request failed". Nothing here mutates the compositor, the plan or the broker.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.host import HostError, component, inspect_host, metadata, peer, read_plan
from src.native.plugin_compatibility import PLUGIN_SOURCE

# Problems that stop native control until someone acts. Anything else is informational.
BLOCKING = {"NO_COMPOSITOR", "AMBIGUOUS_COMPOSITOR", "COMPOSITOR_NOT_RESTARTED", "NOT_CONFIGURED", "PLAN_STALE",
            "PLUGIN_BUILD_MISSING", "PLUGIN_ABI_MISMATCH", "PLUGIN_SOURCE_CHANGED", "PLUGIN_NOT_LOADED", "PLUGIN_STATUS_FAILED"}
# Problems `native-refresh` repairs by itself, because the recorded build still matches the live compositor.
SELF_REPAIRING = {"PLAN_STALE", "PLUGIN_NOT_LOADED"}
ENVIRONMENT_NAMES = ("WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_CURRENT_DESKTOP", "XDG_RUNTIME_DIR")


def problem(code, message, fix):
    return {"code": code, "blocking": code in BLOCKING, "message": message, "fix": fix}


def runtime_directory(environ):
    text = environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    path = Path(text)
    if not path.is_absolute() or not path.is_dir():
        return None
    return Path(os.path.realpath(path))


def socket_peer(path):
    """The pid and start identity of whatever answers on a Unix socket, or None when nothing live does."""
    try:
        metadata(path)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect(str(path))
            return peer(connection)
    except (OSError, HostError):
        return None


def live_instances(runtime):
    """Signature to compositor identity for every Hyprland instance whose IPC socket answers."""
    found = {}
    base = runtime / "hypr"
    try:
        names = sorted(entry.name for entry in base.iterdir() if entry.is_dir())
    except OSError:
        return found
    for name in names:
        try:
            component(name)
        except HostError:
            continue
        identity = socket_peer(base / name / ".socket.sock")
        if identity is not None:
            found[name] = identity
    return found


def display_for(runtime, compositor, preferred):
    """The Wayland socket served by the same process as the compositor IPC socket."""
    names = ([preferred] if preferred else []) + sorted(entry.name for entry in runtime.glob("wayland-*") if not entry.name.endswith(".lock"))
    for name in names:
        try:
            component(name)
        except HostError:
            continue
        if socket_peer(runtime / name) == compositor:
            return name
    return None


def resolve_environment(environ):
    """Find the live compositor even when the process environment is missing or stale.

    A systemd user service can start before the compositor exports its variables, and a long
    lived service keeps whatever it saw at start. The runtime directory is the ground truth.
    """
    runtime = runtime_directory(environ)
    result = {"resolved": False, "source": "none", "runtime": str(runtime) if runtime else None,
              "values": {}, "missing_from_process": [name for name in ENVIRONMENT_NAMES[:3] if not environ.get(name)],
              "instances": [], "problems": []}
    if runtime is None:
        result["problems"].append(problem("NO_COMPOSITOR", "No user runtime directory (XDG_RUNTIME_DIR) was found, so no compositor can be located.",
                                          "Run Orbit from the logged in desktop user's systemd user manager."))
        return result
    live = live_instances(runtime)
    result["instances"] = sorted(live)
    wanted = environ.get("HYPRLAND_INSTANCE_SIGNATURE")
    if wanted in live:
        signature, source = wanted, "process"
    elif len(live) == 1:
        signature, source = next(iter(live)), "runtime-scan"
    elif not live:
        result["problems"].append(problem("NO_COMPOSITOR", "No running Hyprland instance answers under " + str(runtime / "hypr") + ".",
                                          "Start the Hyprland session, then run sbar-orbit doctor again."))
        return result
    else:
        result["problems"].append(problem("AMBIGUOUS_COMPOSITOR", "Several Hyprland instances answer (" + ", ".join(sorted(live)) + "), so Orbit will not guess.",
                                          "Leave exactly one Hyprland session running, or export HYPRLAND_INSTANCE_SIGNATURE for the one to control."))
        return result
    display = display_for(runtime, live[signature], environ.get("WAYLAND_DISPLAY"))
    if display is None:
        result["problems"].append(problem("NO_COMPOSITOR", "No Wayland socket in " + str(runtime) + " belongs to the Hyprland process of instance " + signature + ".",
                                          "Restart the Hyprland session."))
        return result
    result.update(resolved=True, source=source)
    result["values"] = {"XDG_RUNTIME_DIR": str(runtime), "HYPRLAND_INSTANCE_SIGNATURE": signature, "WAYLAND_DISPLAY": display,
                        "XDG_CURRENT_DESKTOP": environ.get("XDG_CURRENT_DESKTOP") or "Hyprland"}
    if result["missing_from_process"] or wanted != signature or environ.get("WAYLAND_DISPLAY") != display:
        result["problems"].append(problem(
            "ENVIRONMENT_STALE", "The broker process does not carry the live compositor environment (missing or stale: "
            + (", ".join(result["missing_from_process"]) or "HYPRLAND_INSTANCE_SIGNATURE/WAYLAND_DISPLAY differ from the live instance")
            + "). Orbit resolved it from " + str(runtime) + " instead.",
            "Informational. To make the service environment match the session, run: systemctl --user import-environment "
            "WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP; systemctl --user restart sbar-orbit.service"))
    return result


def installed_version():
    """The version of the Hyprland binary on disk, which an upgrade changes while the running one stays."""
    for candidate in ("/usr/bin/Hyprland", "/usr/local/bin/Hyprland"):
        if not os.access(candidate, os.X_OK):
            continue
        try:
            out = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=5, env={"PATH": "/usr/bin:/bin"}).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.search(r"Hyprland\s+v?(\d+\.\d+\.\d+)", out)
        return match.group(1) if match else None
    return None


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def plugin_loaded(plan):
    """Whether the compositor has the Orbit plugin, asked through the compositor's own IPC."""
    from src.native.transport import NativeTransport
    transport = NativeTransport(plan)
    plugins = json.loads(transport._exchange("j/plugin list"))
    return any(isinstance(item, dict) and item.get("name") == "ghostinput" for item in plugins)


def diagnose(root, environ, check_loaded=True, installed=installed_version):
    root = Path(root)
    environment = resolve_environment(environ)
    problems = list(environment["problems"])
    report = {"schema": 1, "environment": environment, "compositor": None, "installed": None, "plan": None,
              "build": None, "plugin": {"loaded": None}, "lastRefresh": read_json(root / "refresh-status.json"),
              "problems": problems, "ready": False}
    live = None
    if environment["resolved"]:
        try:
            live = inspect_host(environment["values"])
            report["compositor"] = {"version": live["version"], "commit": live["commit"], "abiHash": live["abi_hash"], "signature": live["signature"]}
        except (HostError, OSError, ValueError) as error:
            problems.append(problem("NO_COMPOSITOR", "The compositor did not answer its version request: " + str(error), "Restart the Hyprland session."))
    on_disk = installed()
    report["installed"] = {"version": on_disk}
    if live and on_disk and on_disk != live["version"]:
        problems.append(problem("COMPOSITOR_NOT_RESTARTED", "Hyprland " + on_disk + " is installed but " + live["version"]
                                + " is running (an upgrade without logging out). The plugin must match the RUNNING compositor.",
                                "Log out and back in to run " + on_disk + ", or keep " + live["version"] + " until you do."))
    target = root / "current"
    plan = None
    try:
        plan = read_plan(target / "host.json") if target.is_symlink() else None
    except (OSError, ValueError, HostError):
        plan = None
    if plan is None:
        problems.append(problem("NOT_CONFIGURED", "No native preparation is recorded under " + str(root) + ".",
                                "Run: sbar-orbit install --native, or native-prepare with a plugin manifest."))
    else:
        report["plan"] = {"version": plan.get("version"), "abiHash": plan.get("abi_hash"), "signature": plan.get("signature")}
    build = read_json(root / "plugin-build.json")
    if build is None:
        problems.append(problem("PLUGIN_BUILD_MISSING", "No plugin build is recorded (plugin-build.json).",
                                "Build the plugin once and run: sbar-orbit native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON"))
    else:
        current_source = hashlib.sha256(PLUGIN_SOURCE.read_bytes()).hexdigest() if PLUGIN_SOURCE.is_file() else None
        report["build"] = {"version": build.get("version"), "abiHash": build.get("abi_hash"), "sourceCurrent": current_source == build.get("source_sha256")}
        if live and build.get("abi_hash") != live["abi_hash"]:
            problems.append(problem("PLUGIN_ABI_MISMATCH", "The recorded plugin was built for Hyprland " + str(build.get("version")) + " (" + str(build.get("commit"))[:12]
                                    + ") but the running compositor is " + live["version"] + " (" + live["commit"][:12] + "). It cannot load.",
                                    "Build the plugin against hyprland-devel " + live["version"] + " (experiments/ghost-cursor/plugin/build.sh) and run: "
                                    "sbar-orbit native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON"))
        elif not report["build"]["sourceCurrent"]:
            problems.append(problem("PLUGIN_SOURCE_CHANGED", "The recorded plugin was built from different source than this Orbit installation.",
                                    "Rebuild with experiments/ghost-cursor/plugin/build.sh and run: sbar-orbit native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON"))
    fresh = False
    if plan is not None and live is not None:
        keys = ("runtime", "signature", "display", "compositor", "ipc_socket", "wayland_socket", "abi_hash", "commit", "version")
        fresh = all(plan.get(key) == live[key] for key in keys)
        if not fresh:
            same_build = build is not None and build.get("abi_hash") == live["abi_hash"]
            if plan.get("signature") != live["signature"]:
                why = "the compositor restarted (plan is for instance " + str(plan.get("signature"))[:12] + ", live is " + live["signature"][:12] + ")"
            else:
                why = "the compositor endpoints changed"
            problems.append(problem("PLAN_STALE", "The prepared native plan is stale: " + why + " and plan version " + str(plan.get("version"))
                                    + " vs running " + live["version"] + ".",
                                    "Run: sbar-orbit native-refresh" if same_build else "Rebuild the plugin for " + live["version"] + " first, then native-refresh --plugin-manifest"))
    if fresh and check_loaded:
        try:
            report["plugin"]["loaded"] = plugin_loaded(plan)
        except (HostError, OSError, ValueError, RuntimeError) as error:
            problems.append(problem("PLUGIN_STATUS_FAILED", "The loaded plugin could not be inspected: " + str(error), "Run: sbar-orbit native-refresh"))
        else:
            if not report["plugin"]["loaded"]:
                problems.append(problem("PLUGIN_NOT_LOADED", "The compositor has no Orbit plugin loaded (hyprctl plugin list is empty).", "Run: sbar-orbit native-refresh"))
    report["ready"] = fresh and report["plugin"]["loaded"] is True and not any(item["blocking"] for item in problems)
    report["selfRepairable"] = bool(problems) and all(item["code"] in SELF_REPAIRING or not item["blocking"] for item in problems)
    return report


def effective_environment(environ):
    """The process environment, completed from the live runtime directory where it is missing or stale."""
    resolved = resolve_environment(environ)
    return {**environ, **resolved["values"]} if resolved["resolved"] else dict(environ)


def explain(report):
    """The report as plain sentences, one per problem, for a person reading a terminal."""
    lines = []
    if report["ready"]:
        lines.append("OK: compositor, plan, plugin build and loaded plugin agree.")
    for item in report["problems"]:
        lines.append(("BLOCKING " if item["blocking"] else "NOTE ") + item["code"] + ": " + item["message"])
        lines.append("  Fix: " + item["fix"])
    return lines


def main():
    args = [value for value in sys.argv[1:] if not value.startswith("--")]
    root = Path(args[0]) if args else Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "sbar-orbit/native"
    report = diagnose(root, os.environ)
    if "--check" in sys.argv:
        print("\n".join(explain(report)), file=sys.stderr if not report["ready"] else sys.stdout)
        return 0 if report["ready"] else 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
