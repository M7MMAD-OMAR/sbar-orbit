#!/usr/bin/python3
"""Owner entry that renews the compositor binding after the compositor restarted.

The owner's control directory and the staged plugin build outlive a compositor
restart; only the host plan and the loaded plugin belong to one compositor instance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.diagnose import effective_environment
from src.native.host import HostError, inspect_host, read_plan
from src.native.plugin_bundle import FIELDS
from src.native.plugin_owner import operate
from src.native.prepare import prepare, quoted

KEPT = 2


def private(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not path.is_dir() or path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Native state directory must be a private directory owned by this user")
    return path


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def current_target(root):
    link = root / "current"
    try:
        return Path(os.path.realpath(link, strict=True)) if link.is_symlink() else None
    except OSError:
        return None


def is_fresh(target, live):
    """The plan matches this compositor instance and its prepared plugin is loaded."""
    if target is None:
        return False
    try:
        plan = read_plan(target / "host.json")
        keys = ("runtime", "signature", "display", "compositor", "ipc_socket", "wayland_socket", "abi_hash", "commit", "version")
        if any(plan.get(key) != live[key] for key in keys):
            return False
        return operate("status", str(target))["loaded"] is True
    except (OSError, ValueError, RuntimeError, HostError, KeyError):
        return False


def build_manifest(root, live, supplied):
    """Return a manifest bound to a durable copy of the plugin binary, or explain what must be rebuilt."""
    state = root / "plugin-build.json"
    if supplied is not None:
        manifest = json.loads(Path(supplied).read_text())
    elif state.exists():
        manifest = json.loads(state.read_text())
    else:
        raise ValueError("No plugin build is recorded yet; run native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON once")
    if not isinstance(manifest, dict) or set(manifest) != FIELDS:
        raise ValueError("Unknown plugin build manifest")
    for key in ("abi_hash", "commit", "version"):
        if manifest[key] != live[key]:
            raise ValueError("The compositor changed its " + key + "; rebuild the native plugin and run native-refresh "
                             "--plugin-manifest ABSOLUTE_PRIVATE_JSON")
    return manifest


def durable_copy(root, manifest):
    """Keep one owned copy of the verified binary, so pruning a preparation never removes the build."""
    folder = private(root / "plugin-build")
    target = folder / "plugin.so"
    if not target.exists() or sha256(target) != manifest["binary_sha256"]:
        fd, name = tempfile.mkstemp(dir=folder, prefix="plugin-")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(Path(manifest["binary"]).read_bytes())
            os.chmod(name, 0o600)
            if sha256(name) != manifest["binary_sha256"]:
                raise ValueError("Plugin binary digest differs from its pin")
            os.replace(name, target)
        except BaseException:
            Path(name).unlink(missing_ok=True)
            raise
    return str(target)


def publish(root, preparation):
    link, temporary = root / "current", root / ".current.new"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(preparation.name, target_is_directory=True)
    os.replace(temporary, link)
    environment = root / "broker-native.env"
    text = ("ORBIT_NATIVE_PLAN=" + quoted(str(link / "host.json")) + "\n"
            + "ORBIT_NATIVE_CONTROL=" + quoted(str(root / "control")) + "\n")
    if not environment.exists() or environment.read_text() != text:
        scratch = root / ".broker-native.env.new"
        scratch.write_text(text)
        os.chmod(scratch, 0o600)
        os.replace(scratch, environment)
    return environment


def prune(root, keep):
    older = sorted(path for path in root.glob("prep-*") if path.is_dir() and path != keep)
    for stale in older[:max(len(older) - (KEPT - 1), 0)]:
        shutil.rmtree(stale, ignore_errors=True)


def refresh(root, environment, plugin_manifest=None, if_configured=False):
    require_budget()
    root = private(Path(root).resolve())
    if if_configured and plugin_manifest is None and not (root / "plugin-build.json").exists():
        return {"refreshed": False, "configured": False}
    live = inspect_host(environment)
    target = current_target(root)
    if plugin_manifest is None and is_fresh(target, live):
        return {"refreshed": False, "preparation": str(target), "control": str(root / "control")}
    manifest = build_manifest(root, live, plugin_manifest)
    control = root / "control"
    with ActionControl(control):
        pass
    manifest["binary"] = durable_copy(root, manifest)
    preparation = private(root / ("prep-%d" % time.time_ns()))
    with tempfile.TemporaryDirectory(dir=private(root / "manifests")) as scratch:
        path = Path(scratch) / "plugin-manifest.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(manifest, stream)
        prepare(preparation, environment, path, control)
    operate("load", str(preparation))
    state = root / "plugin-build.json"
    state.write_text(json.dumps(manifest))
    os.chmod(state, 0o600)
    env_file = publish(root, preparation)
    prune(root, preparation)
    return {"refreshed": True, "preparation": str(preparation), "control": str(control),
            "environment_file": str(env_file), "compositor": live["compositor"]}


def record(root, ok, message):
    """Leave the last outcome where doctor reads it. Autostart runs this with no terminal to print to."""
    try:
        state = Path(root) / "refresh-status.json"
        state.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ok": ok, "message": message[:600]}))
        os.chmod(state, 0o600)
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--plugin-manifest", type=Path)
    parser.add_argument("--if-configured", action="store_true")
    args = parser.parse_args()
    try:
        # The environment of a systemd user service may predate the compositor; the runtime directory does not.
        result = refresh(args.root, effective_environment(os.environ), args.plugin_manifest, args.if_configured)
        if result.get("refreshed") or result.get("configured") is not False:
            record(args.root, True, "refreshed" if result.get("refreshed") else "already current")
        print(json.dumps({"ok": True, "result": result}))
        return 0
    except BaseException as error:
        record(args.root, False, str(error))
        print(json.dumps({"ok": False, "error": {"code": "CONFIG_REQUIRED", "message": str(error)},
                          "owner_activation": "not performed"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
