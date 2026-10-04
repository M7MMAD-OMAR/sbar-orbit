"""Owner-configured cooperative action admission and durable journal."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import uuid


class ControlError(RuntimeError):
    pass


class ActionControl:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ControlError("Control directory must be private and owned by this user")
        self.root = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def close(self):
        if self.root is not None:
            os.close(self.root)
            self.root = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _open(self, name, flags):
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.root)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
            os.close(fd)
            raise ControlError(f"Unsafe control file: {name}")
        return fd

    def _lock(self):
        fd = self._open("lock", os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd

    def _settings(self):
        try:
            fd = self._open("settings.json", os.O_RDONLY)
        except FileNotFoundError:
            return {"mode": "protected", "approval": None}
        with os.fdopen(fd) as stream:
            settings = json.load(stream)
        if settings.get("mode") not in ("protected", "full") or not isinstance(settings.get("approval"), (str, type(None))):
            raise ControlError("Invalid action settings")
        return settings

    def _replace_settings(self, settings):
        name = f"settings-{uuid.uuid4().hex}.tmp"
        try:
            fd = self._open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            with os.fdopen(fd, "w") as stream:
                json.dump(settings, stream)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(name, "settings.json", src_dir_fd=self.root, dst_dir_fd=self.root)
            os.fsync(self.root)
        finally:
            try:
                os.unlink(name, dir_fd=self.root)
            except FileNotFoundError:
                pass

    def _record(self, event):
        fd = self._open("actions.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(dict(event, epoch_ns=time.time_ns()), ensure_ascii=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(self.root)

    @staticmethod
    def fingerprint(request):
        return hashlib.sha256(request.encode("utf-8")).hexdigest()

    def configure(self, *, mode=None, approve=None):
        """Owner settings entry point, never interpreted from action content."""
        if mode is not None and mode not in ("protected", "full"):
            raise ControlError("Unknown mode")
        lock = self._lock()
        try:
            settings = self._settings()
            if mode is not None:
                settings.update(mode=mode, approval=None)
            if approve is not None:
                settings["approval"] = self.fingerprint(approve)
            action_id = uuid.uuid4().hex
            self._record({"id": action_id, "phase": "begin", "kind": "settings", "settings": settings})
            self._replace_settings(settings)
            self._record({"id": action_id, "phase": "finish", "outcome": "success"})
            return settings
        finally:
            os.close(lock)

    def execute(self, request, operation):
        """Synchronize intent before calling the operation, then its outcome."""
        if not isinstance(request, str) or not request or len(request.encode("utf-8")) > 65536:
            raise ControlError("Action request must contain 1 to 65536 UTF-8 bytes")
        lock = self._lock()
        try:
            settings = self._settings()
            action_id = uuid.uuid4().hex
            approved = settings["mode"] == "full" or settings["approval"] == self.fingerprint(request)
            event = {"id": action_id, "kind": "action", "request": request, "mode": settings["mode"]}
            if not approved:
                self._record(dict(event, phase="denied", outcome="approval-required"))
                raise ControlError("Protected mode requires approval for this exact action")
            self._record(dict(event, phase="begin"))
            if settings["mode"] == "protected":
                settings["approval"] = None
                self._replace_settings(settings)
        finally:
            os.close(lock)
        try:
            result = operation()
        except BaseException as error:
            lock = self._lock()
            try:
                self._record({"id": action_id, "phase": "finish", "outcome": "error", "error": str(error)})
            finally:
                os.close(lock)
            raise
        lock = self._lock()
        try:
            self._record({"id": action_id, "phase": "finish", "outcome": "success", "result": result})
            return result
        finally:
            os.close(lock)

    def _cleanup_record(self, event):
        fd = self._open("lock", os.O_RDWR | os.O_CREAT)
        try:
            deadline = time.monotonic() + 0.5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ControlError("Cleanup journal storage is busy")
                    time.sleep(0.01)
            self._record(event)
        finally:
            os.close(fd)

    def cleanup(self, request, operation):
        """Record mandatory owned-resource cleanup, even when journaling fails.

        This internal lifecycle entry point does not admit application actions.
        Its caller must supply cleanup of resources that caller already owns.
        """
        errors, result, recorded = [], None, False
        action_id = uuid.uuid4().hex
        try:
            self._cleanup_record({"id": action_id, "phase": "begin", "kind": "action",
                                  "request": request, "lifecycle": "cleanup"})
            recorded = True
        except BaseException as error:
            errors.append(error)
        try:
            result = operation()
        except BaseException as error:
            errors.append(error)
        if recorded:
            try:
                self._cleanup_record({"id": action_id, "phase": "finish",
                                      "outcome": "error" if errors else "success", "result": result,
                                      "errors": [str(error) for error in errors]})
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("Owned cleanup or its journal failed", errors)
        return result

    def inspect(self):
        lock = self._lock()
        try:
            try:
                fd = self._open("actions.jsonl", os.O_RDONLY)
            except FileNotFoundError:
                records = []
            else:
                with os.fdopen(fd) as stream:
                    records = [json.loads(line) for line in stream]
            pending = set()
            for event in records:
                if event["phase"] == "begin":
                    pending.add(event["id"])
                elif event["phase"] == "finish":
                    if event["id"] not in pending:
                        raise ControlError("Journal contains an outcome without its intent")
                    pending.remove(event["id"])
                elif event["phase"] != "denied":
                    raise ControlError("Unknown journal phase")
            return {"settings": self._settings(), "events": records, "unresolved": sorted(pending)}
        finally:
            os.close(lock)
