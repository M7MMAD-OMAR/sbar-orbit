"""Own and reap one native application tree until its parent pipe closes."""
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time
from budget import require_budget
from file_leases import acquire_files, FileLeaseError

require_budget()

# Subreaping retains descendants that detach or outlive their immediate parent.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "Cannot enable child subreaper")
report = Path(sys.argv[1])
parent = report.parent.lstat()
if (not report.is_absolute() or not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.getuid() or parent.st_mode & 0o077):
    raise ValueError("Private Orbit runtime required")
stopping = False

def stop(_signal, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
arguments = sys.argv[2:]
selected_files, lease_fds = [], []
try:
    if arguments[:1] == ["--selected-files"]:
        selected_files, lease_fds = acquire_files(json.loads(arguments[1]))
        arguments = arguments[2:]
    child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, start_new_session=True)
except Exception as error:
    for fd in lease_fds:
        os.close(fd)
    code = error.code if isinstance(error, FileLeaseError) else "BACKEND_FAILED"
    message = str(error) if isinstance(error, FileLeaseError) else "Application could not start"
    report.write_text(json.dumps({"error": {"code": code, "message": message}}))
    sys.exit(73 if code == "FILE_BUSY" else 1)

# The application never inherits this pipe, so broker death always produces EOF.
try:
    report.write_text(json.dumps({"pid": child.pid, "selectedFiles": selected_files}))
    while not stopping and child.poll() is None:
        ready, _, _ = select.select([sys.stdin], [], [], 0.05)
        if ready and not os.read(0, 1024):
            stopping = True
finally:
    # Only direct children of this supervisor are addressed. Orphans become direct
    # children as their parents exit, so repeat until all owned descendants reap.
    deadline = time.monotonic() + 1.0
    while True:
        children_path = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
        children = [int(pid) for pid in children_path.read_text().split()]
        if not children:
            break
        for pid in children:
            try:
                os.kill(pid, signal.SIGTERM if time.monotonic() < deadline else signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break
        time.sleep(0.01)

    # Keep reservations throughout descendant termination, not just the parent EOF.
    for fd in lease_fds:
        os.close(fd)
