"""Own and reap one native application tree until its parent pipe closes."""
import ctypes
import json
import os
from pathlib import Path
import resource
import select
import signal
import stat
import subprocess
import sys
import time
from budget import require_budget
from file_leases import acquire_files, FileLeaseError
from landlock_unix import LandlockUnavailable, make_abstract_ruleset, make_ruleset, restrict_child
from mount_unix import PrivateMountUnavailable, mount_command
from zen_file_mount import ZenFileMountError, prepare_zen_file_mounts

require_budget()
# This limit is inherited by every supervised application and its descendants.
# The host coredump helper receives it through the kernel's %c argument.
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

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
policy_fd = None
mount_fds = []
zero_core_filter = False
try:
    if arguments[:1] == ["--selected-files"]:
        selected_files, lease_fds = acquire_files(json.loads(arguments[1]))
        arguments = arguments[2:]
    if arguments[:1] == ["--coredump-filter-zero"]:
        zero_core_filter = True
        arguments = arguments[1:]
    if arguments[:1] == ["--zen-file-policy"]:
        zen_policy = json.loads(arguments[1])
        if (not isinstance(zen_policy, dict) or set(zen_policy) != {"paths", "protectedDirectories"}
                or not isinstance(zen_policy["paths"], list)
                or any(not isinstance(path, str) for path in zen_policy["paths"])
                or sorted(zen_policy["paths"]) != selected_files):
            raise ZenFileMountError("Shared Zen files differ from their reserved paths")
        zen_mounts, zen_fds, _ = prepare_zen_file_mounts(
            zen_policy["paths"], zen_policy["protectedDirectories"])
        mount_fds.extend(zen_fds)
        arguments = arguments[2:]
        if (not arguments or arguments[0] != "/usr/bin/bwrap"
                or arguments.count("--clearenv") != 1):
            raise ZenFileMountError("Shared Zen files need the private browser mount")
        before_env = arguments.index("--clearenv")
        arguments = arguments[:before_env] + zen_mounts + arguments[before_env:]
    if arguments[:1] == ["--socket-policy"]:
        policy_fd = make_ruleset(json.loads(arguments[1]))
        arguments = arguments[2:]
    elif arguments[:1] == ["--desktop-mount-policy"]:
        policy_fd = make_abstract_ruleset()
        arguments, mount_fds = mount_command(arguments[2:], report.parent, selected_files,
                                             json.loads(arguments[1]))

    def prepare_child():
        if zero_core_filter:
            # Firefox needs dumpability to map sandbox user IDs. Notes and registers can still enter a core.
            with open("/proc/self/coredump_filter", "w", encoding="ascii") as filter_file:
                filter_file.write("0\n")
            with open("/proc/self/coredump_filter", "r", encoding="ascii") as filter_file:
                if filter_file.read().strip() != "00000000":
                    raise OSError("Cannot apply zero core mapping filter")
        if policy_fd is not None:
            restrict_child(policy_fd)

    child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, start_new_session=True,
                             pass_fds=tuple(mount_fds) + ((policy_fd,) if policy_fd is not None else ()),
                             preexec_fn=prepare_child if zero_core_filter or policy_fd is not None else None)
except Exception as error:
    for fd in lease_fds:
        os.close(fd)
    code = error.code if isinstance(error, FileLeaseError) else "INVALID_REQUEST" if isinstance(error, ZenFileMountError) else "UNSUPPORTED" if isinstance(error, (LandlockUnavailable, PrivateMountUnavailable)) else "BACKEND_FAILED"
    message = str(error) if isinstance(error, (FileLeaseError, ZenFileMountError, LandlockUnavailable, PrivateMountUnavailable)) else "Application could not start"
    report.write_text(json.dumps({"error": {"code": code, "message": message}}))
    sys.exit(73 if code == "FILE_BUSY" else 1)
finally:
    if policy_fd is not None:
        os.close(policy_fd)
    for fd in mount_fds:
        os.close(fd)

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
