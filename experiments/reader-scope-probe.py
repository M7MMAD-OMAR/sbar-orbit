"""Manual original-kernel test of owned helpers only, never desktop input/capture."""
import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "native"))
from budget import require_budget
from reader_scope import ReaderLimits, ReaderScope, ReaderScopeError, _cgroup2

LIMITS = ReaderLimits(memory_bytes=32 * 1024 * 1024, pids=8, cpu_quota=50000)
# Fixed isolated stdlib fixture: stop before fork/work; every branch self-expires.
CHILD = r"""
import ctypes, os, signal, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != int(sys.argv[2]):
    os._exit(94)
signal.alarm(15)
os.kill(os.getpid(), signal.SIGSTOP)
# Only the trusted parent resumes after cgroup admission.
if libc.prctl(1, 0, 0, 0, 0) != 0:
    os._exit(95)
if sys.argv[1] == "descendant":
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.alarm(12)
        os.close(1); os.close(2)
        while True: signal.pause()
    print(child, flush=True)
    os._exit(0)
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print("ready", flush=True)
    while True: signal.pause()
"""

def wait_until(check, timeout=3):
    deadline = time.monotonic() + timeout
    while True:
        if check():
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned fixture deadline expired; stop/debt remains unconfirmed")
        time.sleep(0.01)

def stopped(process):
    def check():
        event = os.waitid(os.P_PID, process.pid, os.WSTOPPED | os.WNOHANG | os.WNOWAIT)
        return event is not None and event.si_code == os.CLD_STOPPED
    wait_until(check)

def kill_root(process):
    if process.returncode is None:
        fd = os.pidfd_open(process.pid)
        try:
            try: signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError: pass
        finally:
            os.close(fd)
    process.communicate(timeout=3)

def spawn(mode):
    process = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", CHILD, mode, str(os.getpid())],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stopped(process)
        return process
    except BaseException:
        kill_root(process)
        raise

def resume(process):
    fd = os.pidfd_open(process.pid)
    try:
        signal.pidfd_send_signal(fd, signal.SIGCONT)
    finally:
        os.close(fd)

def reap(pid):
    def check():
        try:
            return os.waitpid(pid, os.WNOHANG)[0] == pid
        except ChildProcessError:
            return True
    wait_until(check)

def expect_refusal(call, codes):
    try:
        call()
    except ReaderScopeError as error:
        if error.code not in codes:
            raise
        return error.code
    raise RuntimeError("Expected owned scope refusal")

def ready(process):
    if not select.select([process.stdout], [], [], 3)[0] or os.read(process.stdout.fileno(), 16) != b"ready\n":
        raise RuntimeError("Fixture not ready before deadline")

def bootstrap_owner():
    signal.alarm(8)
    process = spawn("root")
    print(json.dumps({"pid": process.pid}), flush=True)
    # Deliberately never admit/resume: controller death must kill the stopped bootstrap.
    while True: signal.pause()

def orphan_owner(root, journal):
    scope = ReaderScope(Path(root), Path(journal), limits=LIMITS, initialize=True)
    scope.prepare(); scope.reserve_spawn()
    process = spawn("root")
    try:
        scope.bind_child(process); scope.admit(process)
        resume(process); ready(process)
        print(json.dumps({"pid": process.pid}), flush=True)
        # Real coordinator death after confirmed admission; helper remains in its owned leaf.
        os._exit(0)
    except BaseException:
        kill_root(process)
        scope.close()
        raise

def run():
    require_budget()
    started_at = datetime.now(timezone.utc).isoformat()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, this fixture tree only.
        raise RuntimeError("Cannot own/reap orphan fixture descendants")
    relative = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    parts = Path(relative).parts
    index = parts.index("sbarorbit.slice")
    shared = Path("/sys/fs/cgroup").joinpath(*parts[1:index + 1])
    shared_controls = {name: (shared / name).read_text() for name in ("memory.max", "memory.swap.max", "pids.max", "cpu.max", "cgroup.subtree_control")}
    name = "orbit-reader-probe-" + uuid.uuid4().hex
    root = shared / name
    artifacts = Path(tempfile.mkdtemp(prefix="orbit-reader-scope-probe-", dir=Path.home() / ".cache"))
    fd = None
    identity = None
    created = False
    reports = []
    scopes = []
    roots = []
    cleanup_errors = []
    success = False
    try:
        os.mkdir(root, 0o700)  # Fresh exclusive owned parent, never alter shared controls.
        created = True
        info = os.stat(root, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        _cgroup2(fd)
        parent_limits = {"memory.max": str(64 * 1024 * 1024), "memory.swap.max": "0", "pids.max": "16", "cpu.max": "50000 100000"}
        for control, value in parent_limits.items():
            (root / control).write_text(value)
            if (root / control).read_text().split() != value.split():
                raise RuntimeError("Owned parent limits did not read back")
        # Only this fresh empty parent gets subtree controllers enabled.
        (root / "cgroup.subtree_control").write_text("+cpu +memory +pids")
        if not {"cpu", "memory", "pids"}.issubset((root / "cgroup.subtree_control").read_text().split()):
            raise RuntimeError("Owned parent delegation unavailable")

        guardian = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(Path(__file__).resolve()), "--bootstrap-owner"],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        roots.append(guardian)
        if not select.select([guardian.stdout], [], [], 3)[0]: raise RuntimeError("Bootstrap owner not ready")
        bootstrap = json.loads(os.read(guardian.stdout.fileno(), 128))["pid"]
        bootstrap_fd = os.pidfd_open(bootstrap)
        try:
            kill_root(guardian)
            reap(bootstrap)
        finally:
            try: signal.pidfd_send_signal(bootstrap_fd, signal.SIGKILL)
            except ProcessLookupError: pass
            os.close(bootstrap_fd)
        reports.append({"scenario": "owner-death-before-admission", "bootstrapReaped": True, "parentDeathSignal": "SIGKILL"})

        scope = ReaderScope(root, artifacts / "empty.jsonl", limits=LIMITS, initialize=True); scopes.append(scope)
        scope.prepare()
        if not scope.empty(): raise RuntimeError("Fresh leaf is populated")
        receipt = scope.retire()
        if not receipt["scopeEmpty"] or receipt["rootReaped"] or not receipt["neverAdmitted"]: raise RuntimeError("Invalid no-admission receipt")
        expect_refusal(scope.prepare, {"DEBT"})
        reports.append({"scenario": "never-admitted-single-use", "receipt": receipt})
        scope.close()

        scope = ReaderScope(root, artifacts / "descendant.jsonl", limits=LIMITS, initialize=True); scopes.append(scope)
        scope.prepare(); scope.reserve_spawn()
        process = spawn("descendant"); roots.append(process)
        scope.bind_child(process); scope.admit(process); resume(process)
        out, err = process.communicate(timeout=3)
        descendant = int(out.strip())
        if process.returncode != 0 or err or scope.empty(): raise RuntimeError("Root exit/EOF incorrectly became scope-empty")
        refusal = expect_refusal(scope.retire, {"UNKNOWN"})
        scope.kill(); wait_until(scope.empty); reap(descendant)
        receipt = scope.retire()
        if not receipt["scopeEmpty"] or not receipt["rootReaped"]: raise RuntimeError("Invalid descendant-drain receipt")
        reports.append({"scenario": "root-exit-and-eof-with-live-term-ignoring-descendant", "refusalBeforeKill": refusal, "receipt": receipt})
        scope.close()

        scope = ReaderScope(root, artifacts / "root.jsonl", limits=LIMITS, initialize=True); scopes.append(scope)
        scope.prepare(); scope.reserve_spawn()
        process = spawn("root"); roots.append(process)
        scope.bind_child(process); scope.admit(process); resume(process)
        ready(process)
        scope.kill(); wait_until(scope.empty)
        refusal = expect_refusal(scope.retire, {"UNKNOWN"})
        process.communicate(timeout=3)
        receipt = scope.retire()
        if not receipt["rootReaped"]: raise RuntimeError("Root reap was not witnessed")
        reports.append({"scenario": "scope-empty-before-root-reap", "refusalBeforeReap": refusal, "receipt": receipt})
        scope.close()

        journal = artifacts / "orphan.jsonl"
        owner = subprocess.run(["/usr/bin/python3", "-I", "-S", str(Path(__file__).resolve()), "--orphan-owner", str(root), str(journal)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=True)
        orphan = json.loads(owner.stdout)["pid"]
        scope = ReaderScope(root, journal, limits=LIMITS); scopes.append(scope)
        refusal = expect_refusal(scope.prepare, {"DEBT"})
        scope.recover()
        if scope.empty(): raise RuntimeError("Orphan stopped helper unexpectedly absent before recovery cleanup")
        scope.kill(); wait_until(scope.empty); reap(orphan)
        receipt = scope.retire()
        if not receipt["scopeEmpty"] or not receipt["recovered"] or receipt["rootReaped"]: raise RuntimeError("Recovery manufactured old-parent root reap")
        reports.append({"scenario": "owner-death-durable-debt-and-exact-recovery", "refusalBeforeRecovery": refusal, "receipt": receipt})
        scope.close()
        checkpoint_journal = artifacts / "checkpoint.jsonl"
        cumulative_history = 0
        maximum_checkpoint = 0
        journal_identity = None
        for index in range(64):
            scope = ReaderScope(root, checkpoint_journal, limits=LIMITS, initialize=index == 0)
            scopes.append(scope)
            scope.prepare(); scope.retire()
            before = checkpoint_journal.stat()
            cumulative_history += before.st_size
            current_identity = (before.st_dev, before.st_ino)
            if journal_identity is None: journal_identity = current_identity
            if current_identity != journal_identity: raise RuntimeError("Checkpoint replaced the journal inode")
            scope.checkpoint()
            after = checkpoint_journal.stat()
            maximum_checkpoint = max(maximum_checkpoint, after.st_size)
            if (after.st_dev, after.st_ino) != journal_identity or after.st_size >= 4096:
                raise RuntimeError("Checkpoint identity/size bound failed")
            expect_refusal(scope.prepare, {"DEBT"})
            scope.close()
        if cumulative_history <= ReaderScope.MAX_JOURNAL_BYTES: raise RuntimeError("Checkpoint fixture did not cross history capacity")
        reports.append({"scenario": "same-inode-healthy-checkpoint", "cycles": 64, "cumulativeHistoryBytes": cumulative_history,
                        "maximumCheckpointBytes": maximum_checkpoint, "inodePreserved": True})

        pending_journal = artifacts / "pending.jsonl"
        scope = ReaderScope(root, pending_journal, limits=LIMITS, initialize=True); scopes.append(scope)
        scope.prepare(); scope.reserve_spawn()
        refusal = expect_refusal(scope.retire, {"UNKNOWN"})
        scope.kill()
        if not scope.empty(): raise RuntimeError("Unbound test leaf unexpectedly populated")
        if expect_refusal(scope.retire, {"UNKNOWN"}) != "UNKNOWN": raise RuntimeError("Pending spawn debt disappeared")
        reports.append({"scenario": "unbound-spawn-remains-unknown", "refusal": refusal, "emptyLeafInsufficient": True})
        scope.close()
        # Keep the unresolved leaf and journal until the private test-parent cleanup.
        success = True
    finally:
        for scope in scopes:
            try:
                scope.close()
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        # Emergency cleanup is limited to this fresh exclusive probe parent, not shared/root/PIDs.
        if not success and created and fd is not None:
            try:
                if (os.stat(root).st_dev, os.stat(root).st_ino) != identity: raise RuntimeError("Owned parent replaced")
                killfd = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=fd)
                try: os.write(killfd, b"1\n")
                finally: os.close(killfd)
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        for process in roots:
            try: kill_root(process)
            except BaseException as error: cleanup_errors.append(type(error).__name__)
        try:
            if not created:
                raise RuntimeError("Fresh owned parent was not created; no cleanup attempted")
            wait_until(lambda: "populated 0" in (root / "cgroup.events").read_text().splitlines())
            if (os.stat(root).st_dev, os.stat(root).st_ino) != identity: raise RuntimeError("Owned parent replaced")
            # Only known private fresh descendants are eligible for empty directory removal.
            for child in root.iterdir():
                if child.is_dir():
                    if child.parent.resolve() != root.resolve() or not child.name.startswith("orbit-reader-"): raise RuntimeError("Unexpected owned parent child")
                    os.rmdir(child)
            os.rmdir(root)
        except BaseException as error:
            cleanup_errors.append(type(error).__name__)
        if fd is not None: os.close(fd)
        unchanged = shared_controls == {name: (shared / name).read_text() for name in shared_controls}
        source_files = [Path(__file__).resolve(), Path(__file__).with_suffix(".ts").resolve(),
                        Path(__file__).resolve().parents[1] / "src" / "native" / "reader_scope.py"]
        result = {"startedAtUTC": started_at, "finishedAtUTC": datetime.now(timezone.utc).isoformat(),
                  "kernel": os.uname().release, "arch": os.uname().machine, "python": sys.version.split()[0],
                  "sourceSha256": {str(path.relative_to(Path(__file__).resolve().parents[1])): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files},
                  "manualOnly": True, "nativeDesktopOperations": 0, "scenarios": reports, "sharedControlsUnchanged": unchanged,
                  "ownedParentRemoved": not root.exists(), "cleanupErrors": cleanup_errors, "artifacts": str(artifacts),
                  "helperLimits": {"memoryBytes": LIMITS.memory_bytes, "pids": LIMITS.pids, "cpuQuota": LIMITS.cpu_quota, "cpuPeriod": LIMITS.cpu_period},
                  "scopeRootIdentity": list(identity) if identity is not None else None}
        (artifacts / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)
        if cleanup_errors or not unchanged or root.exists(): raise RuntimeError("Owned probe cleanup/preservation unconfirmed")

if __name__ == "__main__":
    if sys.argv[1:] == ["--bootstrap-owner"]: bootstrap_owner()
    elif len(sys.argv) == 4 and sys.argv[1] == "--orphan-owner": orphan_owner(sys.argv[2], sys.argv[3])
    elif sys.argv[1:] == ["--run"]: run()
    else: raise SystemExit("Manual only: launch via bun experiments/reader-scope-probe.ts --run")
