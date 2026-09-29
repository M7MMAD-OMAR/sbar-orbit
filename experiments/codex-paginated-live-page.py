#!/usr/bin/python3
"""Test-only read of one live fake Codex page without mounting its auth files."""

import hashlib
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

SQLITE = tuple(base + suffix for base in ("state_5.sqlite", "thread_history_1.sqlite")
               for suffix in ("", "-wal", "-shm"))


def identity(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOATIME)
    try:
        first = os.fstat(fd)
        digest = hashlib.sha256()
        while data := os.read(fd, 65536):
            digest.update(data)
        last = os.fstat(fd)
        fields = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size,
                                value.st_mtime_ns, value.st_ctime_ns)
        if fields(first) != fields(last) or fields(last) != fields(path.lstat()):
            raise RuntimeError("STALE: source changed during fingerprint")
        return [*fields(last), digest.hexdigest()]
    finally:
        os.close(fd)


def fingerprint(root):
    files = [root / name for name in SQLITE]
    files += sorted((root / "sessions").rglob("*.jsonl"))
    if len(files) < 7 or len(files) > 1000 or any(not path.is_file() or path.is_symlink() for path in files):
        raise RuntimeError("STALE: incomplete or linked owner source")
    if sum(path.stat().st_size for path in files) > 256 * 1024 * 1024:
        raise RuntimeError("STALE: owner source exceeds fixture limit")
    return {str(path.relative_to(root)): identity(path) for path in files}


def read_page(root, binary, request):
    method = request.get("method")
    params = request.get("params") or {}
    if method not in ("thread/turns/list", "thread/items/list") or params.get("sortDirection") != "asc":
        raise RuntimeError("Unsupported private page method")
    if method == "thread/turns/list" and params.get("itemsView") != "full":
        raise RuntimeError("Private turn page requires full items")
    if params.get("readOnly") is not True:
        raise RuntimeError("Private page requires readOnly")
    payload = json.dumps(request, separators=(",", ":")).encode()
    if len(payload) > 4096:
        raise RuntimeError("Private page request exceeds fixture limit")
    command = ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--new-session",
               "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
               "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
               "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
               "--dir", "/fixture"]
    for name in SQLITE:
        command += ["--ro-bind", str(root / name), "/fixture/" + name]
    command += ["--ro-bind", str(root / "sessions"), "/fixture/sessions",
                "--ro-bind", str(binary), "/reader", "--setenv", "HOME", "/tmp",
                "--setenv", "ORBIT_BWRAP_PAGE_HELPER", "1", "--", "/reader",
                "bwrap_paginated_page_helper_child", "--nocapture"]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(str(len(payload)).encode() + b"\n" + payload, timeout=3.5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise RuntimeError("Private page helper timed out") from None
    if child.returncode != 0:
        raise RuntimeError("Private page helper failed: " + stderr[:256].decode(errors="replace"))
    if len(stdout) > 4 * 1024 * 1024:
        raise RuntimeError("Private page helper output exceeds fixture limit")
    frames = [line for line in stdout.splitlines() if line.startswith(b"ORBIT_PAGE_RESPONSE:")]
    if len(frames) != 1:
        raise RuntimeError("Private page helper returned no unique frame")
    _, length, body = frames[0].split(b":", 2)
    if int(length) != len(body):
        raise RuntimeError("Private page helper frame length mismatch")
    return json.loads(body)


def main():
    root = Path(sys.argv[1]).resolve()
    binary = Path(sys.argv[2]).resolve()
    if not str(root).startswith("/tmp/orbit-paginated-live-") or not binary.is_file():
        raise RuntimeError("Only an explicit disposable owner fixture is accepted")
    request = json.loads(sys.stdin.buffer.read(4097))
    before = fingerprint(root)
    expected = request.pop("fixtureExpectedFingerprint", None)
    if expected is not None and expected != before:
        raise RuntimeError("STALE: previous page version changed")
    try:
        page = read_page(root, binary, request)
    except Exception:
        if fingerprint(root) != before:
            raise RuntimeError("STALE: owner changed during failed page") from None
        raise
    after = fingerprint(root)
    if before != after:
        raise RuntimeError("STALE: owner changed during page")
    sys.stdout.write(json.dumps({"page": page, "fingerprint": before}, separators=(",", ":")))


if __name__ == "__main__":
    main()
