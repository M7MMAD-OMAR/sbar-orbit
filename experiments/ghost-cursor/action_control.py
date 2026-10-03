#!/usr/bin/python3
"""Owner-configured action modes and a synchronized private action journal.

This is a controller for cooperative callers, not an OS security boundary.
Direct compositor IPC remains a separate experimental surface.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
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


def cli_request(argv):
    return "ghost-cli " + json.dumps(argv, separators=(",", ":"), ensure_ascii=True)


def dispatch_native(request):
    from ghost import _hypr
    parts = request.split()
    commands = {"ghost-key", "ghost-type", "ghost-texthex", "ghost-click", "ghost-move", "ghost-scroll",
                "ghost-cursor", "ghost-hide-cursor", "ghost-release", "ghost-state"}
    if not parts or parts[0] not in commands:
        raise ControlError("Unknown native action; mode changes use the owner settings entry point")
    response = _hypr(request).strip()
    if response == "ok":
        return response
    if parts[0] in ("ghost-type", "ghost-texthex") and re.fullmatch(r"ok \d+ keys", response):
        return response
    if parts[0] == "ghost-state":
        try:
            state = json.loads(response)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(state, dict) and all(isinstance(state.get(key), bool) for key in ("suspended", "render_unfocused")):
                return response
    raise ControlError(response)


def controlled_native(request):
    from lab import guard
    guard(os.environ)
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(directory) as control:
        return control.execute(request, lambda: dispatch_native(request))


def main():
    from lab import guard
    guard(os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    settings = sub.add_parser("mode", help="Owner settings entry point")
    settings.add_argument("value", choices=["protected", "full"])
    approval = sub.add_parser("approve", help="Approve one exact request")
    approval.add_argument("request")
    sub.add_parser("status")
    cli = sub.add_parser("cli-request", help="Print the exact approval request for ghost.py arguments")
    cli.add_argument("argv", nargs=argparse.REMAINDER)
    action = sub.add_parser("act")
    action.add_argument("request")
    args = parser.parse_args()
    if args.command == "cli-request":
        print(cli_request(args.argv[1:] if args.argv[:1] == ["--"] else args.argv))
        return 0
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(directory) as control:
        if args.command == "mode":
            result = control.configure(mode=args.value)
        elif args.command == "approve":
            result = control.configure(approve=args.request)
        elif args.command == "status":
            result = control.inspect()
            print(json.dumps(result))
            return 1 if result["unresolved"] else 0
        else:
            result = control.execute(args.request, lambda: dispatch_native(args.request))
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
