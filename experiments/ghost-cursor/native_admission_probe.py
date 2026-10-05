#!/usr/bin/python3
"""Exercise enrollment quiescence and orphan scope readiness in a guarded lab."""
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from lab import guard
from src.native.budget import require_budget
from src.native.host import inspect_host
from src.native.lease import NativeLease, manager_environment, process_identity
from src.native.transport import NativeTransport

WORKER = """
import os,sys,time
print('ready',flush=True)
sys.stdin.readline()
pid=os.fork()
if pid==0:
 os.close(0);os.close(1);os.close(2)
 time.sleep(60)
 os._exit(0)
print(pid,flush=True)
os._exit(0)
"""


def fingerprint(identity):
    return (identity.st_dev, identity.st_ino, identity.st_uid, identity.st_mode, identity.st_nlink,
            identity.st_size, identity.st_mtime_ns, identity.st_ctime_ns)


def binary_pin(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        identity = os.fstat(descriptor)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid() or identity.st_nlink != 1:
            raise RuntimeError("Prototype artifact is not a single-link owned regular file")
        if identity.st_size > 16 * 1024 * 1024:
            raise RuntimeError("Prototype artifact exceeded its inspection bound")
        data = os.read(descriptor, identity.st_size + 1)
        if len(data) != identity.st_size or fingerprint(os.fstat(descriptor)) != fingerprint(identity) \
                or fingerprint(path.lstat()) != fingerprint(identity):
            raise RuntimeError("Prototype artifact changed while pinning")
        return descriptor, identity, hashlib.sha256(data).hexdigest()
    except BaseException:
        os.close(descriptor)
        raise


def mapped_binary(path, descriptor, identity, digest, compositor):
    assert fingerprint(os.fstat(descriptor)) == fingerprint(identity) and fingerprint(path.lstat()) == fingerprint(identity)
    os.lseek(descriptor, 0, os.SEEK_SET)
    assert hashlib.sha256(os.read(descriptor, identity.st_size + 1)).hexdigest() == digest
    with open(f"/proc/{compositor}/maps", "rb") as stream:
        mappings = stream.read(8 * 1024 * 1024 + 1)
    assert len(mappings) <= 8 * 1024 * 1024
    matches = {}
    for line in mappings.decode().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) == 6 and "ghostinput" in Path(fields[5]).name:
            major, minor = (int(value, 16) for value in fields[3].split(":"))
            matches[fields[5]] = (os.makedev(major, minor), int(fields[4]))
    assert matches == {str(path): (identity.st_dev, identity.st_ino)}, "Exact loaded prototype mapping is required"
    assert fingerprint(os.fstat(descriptor)) == fingerprint(identity) and fingerprint(path.lstat()) == fingerprint(identity)


def receive(process):
    if not select.select([process.stdout], [], [], 5)[0]:
        raise RuntimeError("Owned readiness worker did not answer")
    return process.stdout.readline().strip()


def start_scope(process, unit):
    subprocess.run(["/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "3",
                    "PIDs", "au", "1", str(process.pid), "Slice", "s", "sbarorbit.slice",
                    "RuntimeMaxUSec", "t", "30000000", "0"], env=manager_environment(),
                   capture_output=True, timeout=3, check=True)
    lease = NativeLease(unit)
    assert lease.contains(process_identity(process.pid))
    return lease


def stop_scope(unit):
    state = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                            "--property=LoadState,ActiveState"], env=manager_environment(),
                           capture_output=True, text=True, timeout=3, check=True).stdout
    if "LoadState=not-found" in state and "ActiveState=inactive" in state:
        return
    subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], env=manager_environment(),
                   capture_output=True, timeout=4, check=True)


def main():
    guard(os.environ)
    require_budget()
    if len(sys.argv) != 2:
        raise ValueError("Provide the absolute prototype binary")
    binary = Path(sys.argv[1])
    if not binary.is_absolute() or binary.resolve() != binary or not binary.is_file():
        raise ValueError("Prototype binary must exist at an absolute path")
    source = Path(__file__).with_name("plugin") / "ghostinput.cpp"
    work = Path(tempfile.mkdtemp(prefix="native-admission-", dir=Path(os.environ["XDG_RUNTIME_DIR"]).parent))
    descriptor, binary_identity, binary_digest = binary_pin(binary)
    report = {"complete": False, "checks": [], "errors": [], "cleanup_errors": [],
              "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "binary_sha256": binary_digest,
              "owner_activation": "not performed"}
    workers, units, loaded, transport = [], [], False, None
    try:
        plan = inspect_host(os.environ)
        transport = NativeTransport(plan)
        report["compositor"] = plan["compositor"]
        assert json.loads(transport._exchange("j/plugin list")) == []
        loaded = True
        assert transport._exchange("plugin load " + str(binary)).strip() == "ok"
        mapped_binary(binary, descriptor, binary_identity, binary_digest, plan["compositor"][0])
        report["binding"] = "retained artifact identity/digest plus exact kernel maps device/inode"
        build = json.loads(transport._exchange("ghost-build-info"))
        assert build["source_sha256"] == report["source_sha256"]
        report["build"] = build

        def info():
            return json.loads(transport._exchange("ghost-unload-info"))

        initial = info()
        assert initial == {"schema": 1, "admission_paused": False, "live_roots": 0,
                           "tracked_scopes": 0, "scopes_empty": True, "legacy_enrollment": False, "ready": False}
        assert transport._exchange("ghost-admission pause").strip() == "ok paused"
        paused = info()
        assert paused["ready"] and paused["admission_paused"]
        assert transport._exchange("ghost-unload-info extra").startswith("refused:")
        assert transport._exchange("ghost-admission resume extra").startswith("refused:")
        assert info() == paused
        for command in ("ghost-register-process 1", "ghost-register-scope-process 1 invalid"):
            assert transport._exchange(command).strip() == "refused: native admission is paused"
        assert info() == paused
        assert transport._exchange("ghost-admission resume").strip() == "ok running"
        report["checks"].append("strict argument refusal and read-only readiness preserve paused enrollment state")

        for index in range(2):
            process = subprocess.Popen(["/usr/bin/python3", "-c", WORKER], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            workers.append(process)
            assert receive(process) == "ready"
            unit = "orbit-native-" + uuid.uuid4().hex + ".scope"
            units.append(unit)
            lease = start_scope(process, unit)
            assert transport._exchange(f"ghost-register-scope-process {process.pid} {unit}").startswith("ok ")
            assert transport._exchange("ghost-admission pause").strip() == "ok paused"
            current = info()
            assert current["live_roots"] == 1 and not current["ready"]
            assert current["tracked_scopes"] == index + 1
            process.stdin.write("fork\n")
            process.stdin.flush()
            child = int(receive(process))
            assert process.wait(timeout=3) == 0
            identity = process_identity(child)
            assert identity is not None and lease.contains(identity)
            orphan = info()
            report.setdefault("orphan_states", []).append(orphan)
            assert orphan["live_roots"] == 0 and not orphan["scopes_empty"] and not orphan["ready"], \
                "A live orphan descendant must block readiness after its registered root exits"
            assert info() == orphan
            report.setdefault("descendants", []).append(identity)
            if index == 0:
                assert transport._exchange("ghost-admission resume").strip() == "ok running"
        report["checks"].append("live orphan descendants block unload after root exit and registry pruning")
        for unit in reversed(units):
            stop_scope(unit)
        final = info()
        assert final["admission_paused"] and final["live_roots"] == 0 and final["tracked_scopes"] == 2
        assert final["scopes_empty"] and final["ready"] and not final["legacy_enrollment"]
        assert info() == final
        report["final"] = final
        report["checks"].append("empty or removed retained scopes permit readiness only under paused admission")
        report["legacy_generation_refusal"] = "not measured"
        if os.environ["XDG_RUNTIME_DIR"].startswith("/tmp/gl-"):
            assert transport._exchange("ghost-admission resume").strip() == "ok running"
            process = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(30)"])
            workers.append(process)
            assert transport._exchange(f"ghost-register-process {process.pid}").strip() == "ok"
            assert transport._exchange("ghost-admission pause").strip() == "ok paused"
            assert info()["legacy_enrollment"] and not info()["ready"]
            process.terminate()
            process.wait(timeout=3)
            legacy = info()
            assert legacy["live_roots"] == 0 and legacy["scopes_empty"] and legacy["legacy_enrollment"] and not legacy["ready"]
            report["legacy_generation_refusal"] = "pass"
            report["legacy_final"] = legacy
        mapped_binary(binary, descriptor, binary_identity, binary_digest, plan["compositor"][0])
        report["complete"] = True
    except BaseException as error:
        report["errors"].append(repr(error))
    finally:
        for process in workers:
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3)
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
                try:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=3)
                except BaseException as fallback:
                    report["cleanup_errors"].append(repr(fallback))
        for unit in reversed(units):
            try:
                stop_scope(unit)
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        if loaded and transport is not None:
            try:
                assert transport._exchange("plugin unload " + str(binary)).strip() == "ok"
                assert json.loads(transport._exchange("j/plugin list")) == []
                report["plugins_after"] = []
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        report["units"] = units
        try:
            os.close(descriptor)
        except BaseException as error:
            report["cleanup_errors"].append(repr(error))
        report["probe_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        destination = work / "report.json"
        try:
            destination.write_text(json.dumps(report, indent=2) + "\n")
        except BaseException as retention:
            print(json.dumps(report | {"retention_error": repr(retention)}), file=sys.stderr)
            raise
        print(destination)
        if not report["complete"] or report["cleanup_errors"]:
            raise RuntimeError("Native admission proof failed")


if __name__ == "__main__":
    main()
