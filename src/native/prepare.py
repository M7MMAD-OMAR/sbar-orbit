"""Prepare owner configuration without activating the compositor or broker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl
from src.native.host import inspect_host, verify_host
from src.native.budget import require_budget
from src.native.plugin_bundle import stage_plugin, verify_staged_plugin


def quoted(value):
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Configuration paths must not contain control characters")
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def prepare(directory, environment, plugin_manifest=None):
    require_budget()
    text = str(directory)
    if not directory.is_absolute() or str(directory.resolve(strict=True)) != text:
        raise ValueError("Preparation directory must be absolute and canonical")
    quoted(text)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        original = os.fstat(descriptor)
        if original.st_uid != os.getuid() or stat.S_IMODE(original.st_mode) != 0o700:
            raise ValueError("Preparation directory must belong to this user with mode0700")
        if os.listdir(descriptor):
            raise ValueError("Preparation directory must be empty")
        plan = inspect_host(environment)
        plugin = stage_plugin(descriptor, plugin_manifest, plan) if plugin_manifest is not None else None

        def write(name, content):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())

        plan_path, control_path = directory / "host.json", directory / "control"
        write("host.json", json.dumps(plan, indent=2) + "\n")
        os.mkdir("control", mode=0o700, dir_fd=descriptor)
        with ActionControl(control_path) as control:
            control.configure(mode="protected")
            if control.inspect()["settings"]["mode"] != "protected":
                raise RuntimeError("Protected control initialization failed")
        env_path = directory / "broker-native.env"
        write("broker-native.env", "ORBIT_NATIVE_PLAN=" + quoted(str(plan_path)) + "\n"
              + "ORBIT_NATIVE_CONTROL=" + quoted(str(control_path)) + "\n")
        # EnvironmentFile takes a literal path, not a shell-quoted argument.
        write("service-drop-in.conf", "[Service]\nEnvironmentFile=" + str(env_path).replace("%", "%%") + "\n")
        verify_host(plan)
        current = directory.lstat()
        if (current.st_dev, current.st_ino, current.st_uid, current.st_mode) != (
                original.st_dev, original.st_ino, original.st_uid, original.st_mode):
            raise RuntimeError("Preparation directory changed during preparation")
        source = Path(__file__).resolve().parent
        result = {"schema": 1, "prepared": True, "owner_activation": "not performed",
                  "mode": "protected", "plan": str(plan_path), "control": str(control_path),
                  "environment_file": str(env_path), "service_drop_in_template": str(directory / "service-drop-in.conf"),
                  "compositor": plan["compositor"], "abi_hash": plan["abi_hash"],
                  "source_sha256": {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                                    for name in ("prepare.py", "host.py", "control.py", "lease.py", "budget.py")}}
        if plugin is not None:
            result["plugin"] = plugin | {"path": str(directory / "plugin.so")}
            result["source_sha256"]["plugin_bundle.py"] = hashlib.sha256((source / "plugin_bundle.py").read_bytes()).hexdigest()
        write("preparation.pending.json", json.dumps(result, indent=2) + "\n")
        pending = os.stat("preparation.pending.json", dir_fd=descriptor, follow_symlinks=False)
        published = False
        try:
            if plugin is not None:
                verify_staged_plugin(descriptor, plugin)
            os.link("preparation.pending.json", "preparation.json", src_dir_fd=descriptor,
                    dst_dir_fd=descriptor, follow_symlinks=False)
            published = True
            os.unlink("preparation.pending.json", dir_fd=descriptor)
            os.fsync(descriptor)
        except OSError as primary:
            if published:
                try:
                    final = os.stat("preparation.json", dir_fd=descriptor, follow_symlinks=False)
                    if (final.st_dev, final.st_ino) != (pending.st_dev, pending.st_ino):
                        raise RuntimeError("Published preparation manifest changed before cleanup")
                    os.unlink("preparation.json", dir_fd=descriptor)
                except (OSError, RuntimeError) as cleanup:
                    raise ExceptionGroup("Preparation sync and manifest removal failed", [primary, cleanup])
            raise
        return result
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--plugin-manifest", type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args.directory, os.environ, args.plugin_manifest)
        print(json.dumps({"ok": True, "result": result}))
        return 0
    except (OSError, ValueError, RuntimeError, TypeError, ExceptionGroup) as error:
        print(json.dumps({"ok": False, "error": {"code": "CONFIG_REQUIRED", "message": str(error)},
                          "owner_activation": "not performed"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
