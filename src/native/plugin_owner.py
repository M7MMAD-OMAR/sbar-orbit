"""Owner-only loading of a prepared plugin; no agent RPC or service activation."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.native.budget import require_budget
from src.native.host import verify_host
from src.native.plugin_bundle import input_file, unchanged, unique_fields, verify_staged_plugin
from src.native.transport import NativeTransport


def error_detail(error):
    if isinstance(error, BaseExceptionGroup):
        return error.message + ": [" + "; ".join(error_detail(item) for item in error.exceptions) + "]"
    return type(error).__name__ + ": " + str(error)


class OwnerLoadError(RuntimeError):
    def __init__(self, sent, errors):
        self.load_sent = sent
        self.requires_owner_review = sent
        uncertainty = "Load was sent and compositor state requires owner review." if sent else "Load was not sent."
        super().__init__("Owner plugin operation failed. " + uncertainty + " " +
                         "; ".join(error_detail(error) for error in errors))


def document(path):
    path, fd, before = input_file(path, 65536, private=True)
    try:
        data = os.read(fd, 65537)
        if len(data) != before.st_size or len(data) > 65536:
            raise ValueError("Incomplete owner preparation document")
        value = json.loads(data, object_pairs_hook=unique_fields)
        unchanged(path, fd, before)
        if not isinstance(value, dict):
            raise ValueError("Owner preparation document must be a mapping")
        return value
    finally:
        os.close(fd)


class PreparedPlugin:
    def __init__(self, directory):
        self.path = Path(directory)
        if (not self.path.is_absolute() or str(self.path.resolve(strict=True)) != str(self.path)
                or any(ord(char) < 32 or ord(char) == 127 for char in str(self.path))):
            raise ValueError("Owner preparation must be an absolute canonical directory")
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.identity = self.directory_identity()
            result = document(self.path / "preparation.json")
            self.plan = document(self.path / "host.json")
            if (type(result.get("schema")) is not int or result["schema"] != 1
                    or result.get("prepared") is not True or result.get("plan") != str(self.path / "host.json")):
                raise ValueError("Successful owner preparation is required")
            self.artifact = result.get("plugin")
            if not isinstance(self.artifact, dict) or self.artifact.get("path") != str(self.path / "plugin.so"):
                raise ValueError("Preparation has no fixed plugin artifact")
            if (self.artifact.get("file") != "plugin.so" or type(self.artifact.get("schema")) is not int
                    or self.artifact["schema"] != 1 or type(self.artifact.get("bytes")) is not int
                    or not isinstance(self.artifact.get("file_identity"), list)
                    or len(self.artifact["file_identity"]) != 8
                    or any(not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value)
                           for value in self.artifact["file_identity"])):
                raise ValueError("Invalid prepared plugin identity")
            for key in ("binary_sha256", "source_sha256"):
                if not isinstance(self.artifact.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", self.artifact[key]):
                    raise ValueError("Invalid prepared plugin pin")
            if self.artifact.get("build_identity") != {key: self.plan.get(key) for key in ("abi_hash", "commit", "version")}:
                raise ValueError("Prepared plugin ABI differs from its host plan")
            self.verify()
        except BaseException as primary:
            try:
                os.close(self.fd)
            except OSError as cleanup:
                raise BaseExceptionGroup("Owner preparation validation and descriptor cleanup failed", [primary, cleanup])
            raise

    def directory_identity(self):
        info = os.fstat(self.fd)
        current = self.path.lstat()
        identity = (info.st_dev, info.st_ino, info.st_uid, info.st_mode)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700
                or identity != (current.st_dev, current.st_ino, current.st_uid, current.st_mode)):
            raise ValueError("Owner preparation directory is changed or shared")
        return identity

    def verify(self):
        if self.directory_identity() != self.identity:
            raise RuntimeError("Owner preparation directory identity changed")
        verify_host(self.plan)
        verify_staged_plugin(self.fd, self.artifact)

    def close(self):
        os.close(self.fd)


def mapped_identity(bundle):
    """Require the same strict mapping identity as the prepared private proof."""
    pid = bundle.plan["compositor"][0]
    with open(f"/proc/{pid}/maps", "rb") as stream:
        data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise RuntimeError("Compositor mappings exceeded the inspection bound")
    mappings = {}
    for line in data.decode().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) == 6 and (Path(fields[5]).name == "plugin.so" or "ghostinput" in Path(fields[5]).name):
            mappings[fields[5]] = (fields[3], int(fields[4]))
    path = bundle.artifact["path"]
    if set(mappings) != {path}:
        raise RuntimeError("Expected only the exact prepared plugin mapping")
    device, inode = mappings[path]
    major, minor = (int(part, 16) for part in device.split(":"))
    info = os.stat("plugin.so", dir_fd=bundle.fd, follow_symlinks=False)
    if info.st_ino != inode or info.st_dev != os.makedev(major, minor):
        raise RuntimeError("Loaded plugin kernel identity differs from preparation")
    bundle.verify()


def status(bundle, transport):
    bundle.verify()
    plugins = json.loads(transport._exchange("j/plugin list"), object_pairs_hook=unique_fields)
    if not isinstance(plugins, list) or any(not isinstance(item, dict) for item in plugins):
        raise RuntimeError("Invalid loaded plugin list")
    matches = [item for item in plugins if item.get("name") == "ghostinput"]
    if not matches:
        return {"loaded": False, "compositor": bundle.plan["compositor"], "owner_service_activation": "not performed"}
    if len(matches) != 1:
        raise RuntimeError("Ambiguous loaded Orbit plugin")
    build = json.loads(transport._exchange("ghost-build-info"), object_pairs_hook=unique_fields)
    if (not isinstance(build, dict) or set(build) != {"schema", "source_sha256", "abi_hash", "live_roots"}
            or type(build["schema"]) is not int or build["schema"] != 1
            or build["source_sha256"] != bundle.artifact["source_sha256"]
            or build["abi_hash"] != bundle.plan["abi_hash"]
            or type(build["live_roots"]) is not int or not 0 <= build["live_roots"] <= 128):
        raise RuntimeError("Loaded plugin build differs from preparation")
    mapped_identity(bundle)
    return {"loaded": True, "compositor": bundle.plan["compositor"], "build": build,
            "binary_sha256": bundle.artifact["binary_sha256"], "path": bundle.artifact["path"],
            "binding": "prepared identity/digest plus exact kernel maps device/inode",
            "unload_readiness": "not measured", "owner_service_activation": "not performed"}


class OwnerJournal:
    MAXIMUM = 1024 * 1024

    def __init__(self, bundle):
        self.bundle = bundle
        self.descriptors = []
        try:
            self.lock_path = Path(bundle.plan["runtime"]) / "hypr" / bundle.plan["signature"]
            self.host_directory = os.open(self.lock_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.descriptors.append(self.host_directory)
            self.host_identity = self.host_directory_identity()
            self.lock = self.open("orbit-plugin-owner.lock", os.O_RDWR, self.host_directory)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.log = self.open("plugin-owner.jsonl", os.O_RDWR | os.O_APPEND)
            size = os.fstat(self.log).st_size
            if size > self.MAXIMUM:
                raise RuntimeError("Owner plugin journal exceeded its bound")
            data = os.pread(self.log, self.MAXIMUM + 1, 0)
            if len(data) != size or (data and not data.endswith(b"\n")):
                raise RuntimeError("Owner plugin journal is incomplete")
            pending = set()
            for line in data.splitlines():
                event = json.loads(line, object_pairs_hook=unique_fields)
                if not isinstance(event, dict) or event.get("phase") not in ("begin", "finish") or not isinstance(event.get("id"), str):
                    raise RuntimeError("Invalid owner plugin journal event")
                if event["phase"] == "begin":
                    if event["id"] in pending:
                        raise RuntimeError("Duplicate owner plugin intent")
                    pending.add(event["id"])
                else:
                    if event["id"] not in pending:
                        raise RuntimeError("Owner plugin outcome has no intent")
                    pending.remove(event["id"])
            if pending:
                raise RuntimeError("Unfinished owner plugin operation requires owner review")
            os.fsync(self.host_directory)
            os.fsync(bundle.fd)
        except BaseException as primary:
            try:
                self.close()
            except BaseException as cleanup:
                raise BaseExceptionGroup("Owner journal initialization and cleanup failed", [primary, cleanup])
            raise

    def host_directory_identity(self):
        info = os.fstat(self.host_directory)
        current = self.lock_path.lstat()
        identity = (info.st_dev, info.st_ino, info.st_uid, info.st_mode)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022
                or identity != (current.st_dev, current.st_ino, current.st_uid, current.st_mode)):
            raise RuntimeError("Compositor owner-lock directory changed or is shared")
        return identity

    def open(self, name, flags, directory=None):
        directory = self.bundle.fd if directory is None else directory
        fd = os.open(name, flags | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        self.descriptors.append(fd)
        self.validate(name, fd, directory)
        return fd

    def validate(self, name, fd, directory=None):
        directory = self.bundle.fd if directory is None else directory
        info = os.fstat(fd)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1 or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise RuntimeError("Owner plugin journal identity is changed or shared")
        if self.bundle.directory_identity() != self.bundle.identity:
            raise RuntimeError("Owner preparation directory changed while journaling")
        if self.host_directory_identity() != self.host_identity:
            raise RuntimeError("Compositor owner-lock directory identity changed")

    def append(self, event):
        self.validate("orbit-plugin-owner.lock", self.lock, self.host_directory)
        self.validate("plugin-owner.jsonl", self.log)
        data = (json.dumps(event | {"epoch_ns": time.time_ns()}, separators=(",", ":")) + "\n").encode()
        if os.fstat(self.log).st_size + len(data) > self.MAXIMUM:
            raise RuntimeError("Owner plugin journal is full")
        while data:
            written = os.write(self.log, data)
            if written <= 0:
                raise RuntimeError("Owner plugin journal write made no progress")
            data = data[written:]
        os.fsync(self.log)
        self.validate("plugin-owner.jsonl", self.log)

    def close(self):
        errors = []
        for fd in reversed(self.descriptors):
            try:
                os.close(fd)
            except OSError as error:
                errors.append(error)
        self.descriptors.clear()
        if errors:
            raise ExceptionGroup("Owner journal descriptor cleanup failed", errors)


def operate(operation, directory):
    if operation not in ("status", "load"):
        raise ValueError("Use native-plugin status|load ABSOLUTE_PREPARATION_DIRECTORY")
    require_budget()
    bundle = PreparedPlugin(directory)
    journal = None
    sent = False
    try:
        transport = NativeTransport(bundle.plan)
        if operation == "status":
            return status(bundle, transport)
        journal = OwnerJournal(bundle)
        intent = {"id": uuid.uuid4().hex, "operation": "load", "compositor": bundle.plan["compositor"],
                  "binary_sha256": bundle.artifact["binary_sha256"], "source_sha256": bundle.artifact["source_sha256"]}
        journal.append(intent | {"phase": "begin"})
        try:
            result = status(bundle, transport)
            if not result["loaded"]:
                bundle.verify()
                sent = True
                response = transport._exchange("plugin load " + bundle.artifact["path"])
                if response.strip() != "ok":
                    raise RuntimeError("Compositor plugin load was not acknowledged")
                result = status(bundle, transport)
                if not result["loaded"]:
                    raise RuntimeError("Compositor did not retain the loaded plugin")
            journal.append(intent | {"phase": "finish", "outcome": "success", "load_sent": sent})
            return result | {"load_sent": sent, "journal": str(bundle.path / "plugin-owner.jsonl")}
        except BaseException as primary:
            try:
                journal.append(intent | {"phase": "finish", "outcome": "error", "load_sent": sent,
                                         "requires_owner_review": sent, "error": str(primary)})
            except BaseException as retention:
                raise OwnerLoadError(sent, [primary, retention]) from primary
            raise OwnerLoadError(sent, [primary]) from primary
    finally:
        primary = sys.exception()
        errors = []
        if journal is not None:
            try:
                journal.close()
            except BaseException as error:
                errors.append(error)
        try:
            bundle.close()
        except BaseException as error:
            errors.append(error)
        if errors:
            raise OwnerLoadError(sent, ([primary] if primary is not None else []) + errors)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Use native-plugin status|load ABSOLUTE_PREPARATION_DIRECTORY")
        print(json.dumps({"ok": True, "result": operate(sys.argv[1], sys.argv[2])}))
    except BaseException as error:
        print(json.dumps({"ok": False, "error": error_detail(error)}), file=sys.stderr)
        raise SystemExit(1)
