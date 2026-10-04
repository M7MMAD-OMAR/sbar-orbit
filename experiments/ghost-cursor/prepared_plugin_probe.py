#!/usr/bin/python3
"""Private prepared-artifact load, public broker cursor and unload proof."""
import argparse
from contextlib import redirect_stdout
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.host import inspect_host, verify_host
from src.native.lease import process_identity
from src.native.plugin_bundle import verify_staged_plugin
from lab import guard
import native_broker_probe as broker_probe


def prepared_binding(plan, artifact, pid, source_hash):
    """Bind the fixed staged filename without relaxing kernel-map identity."""
    verify_host(plan)
    if pid != plan["compositor"][0] or artifact["source_sha256"] != source_hash:
        raise RuntimeError("Prepared plugin source or compositor differs")
    path = Path(artifact["path"])
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        verify_staged_plugin(directory, artifact)
        mappings = {}
        for line in Path(f"/proc/{pid}/maps").read_text().splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) == 6 and (Path(fields[5]).name == "plugin.so" or "ghostinput" in Path(fields[5]).name):
                mappings[fields[5]] = (fields[3], int(fields[4]))
        if set(mappings) != {str(path)}:
            raise RuntimeError("Expected only the exact prepared plugin mapping")
        device, inode = mappings[str(path)]
        major, minor = (int(part, 16) for part in device.split(":"))
        info = path.stat()
        if info.st_ino != inode or info.st_dev != os.makedev(major, minor):
            raise RuntimeError("Prepared plugin kernel mapping differs from its file")
        verify_staged_plugin(directory, artifact)
        return {"path": str(path), "binary_sha256": artifact["binary_sha256"],
                "build_source_sha256": source_hash, "optimization": "O0 prototype build",
                "binding": "prepared identity/digest plus exact kernel maps device/inode"}
    finally:
        os.close(directory)


def retain_report(path, report):
    try:
        path.write_text(json.dumps(report, indent=2) + "\n")
    except BaseException as error:
        report["cleanup_errors"].append("Report retention failed: " + repr(error))
        report["complete"] = False
        print(json.dumps(report), file=sys.stderr)
    else:
        print(path)


def main():
    guard(os.environ)
    require_budget()
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--pointer-helper", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    retained = root / ".private"
    retained.mkdir(mode=0o700, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="prepared-plugin-proof-", dir=retained))
    preparation = Path(tempfile.mkdtemp(prefix="orbit-prepared-plugin-", dir="/tmp"))
    report = {"schema": 1, "complete": False, "probe_pid": os.getpid(), "errors": [], "cleanup_errors": [],
              "preparation_directory": str(preparation), "owner_activation": "not performed",
              "binding_fixture": "prepared_binding injected into unchanged broker recording fixture",
              "source_sha256": {str(Path(__file__).relative_to(root)):
                                  hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
    attempted = False
    pointer = None
    pointer_log = None

    def command(arguments, name):
        child = subprocess.run(arguments, capture_output=True, text=True, timeout=25)
        (work / (name + ".stdout")).write_text(child.stdout)
        (work / (name + ".stderr")).write_text(child.stderr)
        if child.returncode:
            raise RuntimeError(f"{name} exited {child.returncode}: {child.stderr or child.stdout}")
        return child.stdout

    def plugins(name):
        return json.loads(command(["hyprctl", "-j", "plugin", "list"], name))

    try:
        plan = inspect_host(os.environ)
        source = root / "experiments/ghost-cursor/plugin/ghostinput.cpp"
        binary = args.binary.resolve(strict=True)
        build = {"schema": 1, "source": str(source), "binary": str(binary),
                 "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                 "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                 **{key: plan[key] for key in ("abi_hash", "commit", "version")}}
        if Path(str(binary) + ".source.sha256").read_text().split()[0] != build["source_sha256"]:
            raise RuntimeError("Preserved prototype build source differs from current source")
        manifest = work / "build.json"
        manifest.write_text(json.dumps(build))
        manifest.chmod(0o600)
        report["plugins_before"] = plugins("plugins-before")
        if report["plugins_before"]:
            raise RuntimeError("Proof requires a fresh compositor without loaded plugins")
        helper = args.pointer_helper.resolve(strict=True)
        report["pointer_helper_sha256"] = hashlib.sha256(helper.read_bytes()).hexdigest()
        report["source_sha256"]["experiments/ghost-cursor/person_pointer.c"] = hashlib.sha256(
            (root / "experiments/ghost-cursor/person_pointer.c").read_bytes()).hexdigest()
        pointer_log = (work / "pointer.stderr").open("xb")
        pointer = subprocess.Popen([str(helper), "100", "100", "1920", "1200", "hold"],
                                   stdout=subprocess.DEVNULL, stderr=pointer_log)
        report["pointer_process"] = process_identity(pointer.pid)
        deadline = time.monotonic() + 5
        while True:
            if pointer.poll() is not None:
                raise RuntimeError("Private pointer fixture exited before readiness")
            position = json.loads(command(["hyprctl", "-j", "cursorpos"], "pointer-position"))
            if position == {"x": 100, "y": 100}:
                if (work / "pointer.stderr").stat().st_size:
                    raise RuntimeError("Private pointer fixture emitted stderr")
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Private pointer fixture did not reach readiness")
            time.sleep(0.05)
        output = command([shutil.which("bun"), str(root / "src/cli.ts"), "native-prepare",
                          str(preparation), "--plugin-manifest", str(manifest)], "prepare")
        result = json.loads(output)
        if not result["ok"] or not result["result"]["prepared"] or result["result"]["mode"] != "protected":
            raise RuntimeError("Public preparation did not preserve protected mode")
        report["preparation"] = result["result"]
        artifact = result["result"]["plugin"]
        fd = os.open(preparation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            verify_staged_plugin(fd, artifact)
        finally:
            os.close(fd)
        verify_host(plan)
        attempted = True
        command(["hyprctl", "plugin", "load", artifact["path"]], "load")
        report["plugins_loaded"] = plugins("plugins-loaded")
        if len(report["plugins_loaded"]) != 1 or report["plugins_loaded"][0].get("name") != "ghostinput":
            raise RuntimeError("Compositor did not report exactly the intended plugin")
        binding = prepared_binding(plan, artifact, plan["compositor"][0], build["source_sha256"])
        stream = StringIO()
        with patch.object(broker_probe, "loaded_plugin", lambda pid, source_hash: prepared_binding(plan, artifact, pid, source_hash)), \
                patch.object(sys, "argv", [str(broker_probe.__file__), "--record"]), redirect_stdout(stream):
            broker_probe.main()
        report["broker"] = json.loads(stream.getvalue())
        if report["broker"]["plugin"] != binding:
            raise RuntimeError("Broker proof plugin binding changed")
        prepared_binding(plan, artifact, plan["compositor"][0], build["source_sha256"])
        report["compositor_loader"] = "accepted in guarded private lab"
    except BaseException as error:
        report["errors"].append(repr(error))
    finally:
        if attempted:
            try:
                command(["hyprctl", "plugin", "unload", str(preparation / "plugin.so")], "unload")
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        try:
            report["plugins_after"] = plugins("plugins-after")
            if report["plugins_after"] != report.get("plugins_before"):
                raise RuntimeError("Plugin list differs after cleanup")
        except BaseException as error:
            report["cleanup_errors"].append(repr(error))
        if pointer is not None:
            try:
                if pointer.poll() is None:
                    pointer.terminate()
                    try:
                        pointer.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pointer.kill()
                        pointer.wait(timeout=3)
                identity = report.get("pointer_process")
                if identity is None or process_identity(pointer.pid) == tuple(identity):
                    raise RuntimeError("Private pointer fixture identity is missing or still alive")
                report["pointer_reaped"] = True
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        if pointer_log is not None:
            try:
                pointer_log.close()
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        report["complete"] = not report["errors"] and not report["cleanup_errors"]
        report["preparation_cleanup"] = "retained until owned compositor exit"
        retain_report(work / "report.json", report)
    if not report["complete"]:
        raise RuntimeError("Prepared plugin proof or cleanup failed; see retained report")


if __name__ == "__main__":
    main()
