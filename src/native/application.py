"""Admitted native launches with private profiles and parent-pipe supervision."""
import copy
import hashlib
import json
import os
import signal
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import uuid

from .budget import require_budget
from .host import verify_host
from .lease import NativeLease, process_identity


CONFIG_FILES = frozenset({"kdeglobals", "gtk-3.0/settings.ini", "gtk-4.0/settings.ini"})


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("Native application directory must be canonical, private and owned")
    return path


def launch_arguments(argv, configuration):
    if (not isinstance(argv, list) or not argv or not isinstance(argv[0], str)
            or not Path(argv[0]).is_absolute() or any(not isinstance(arg, str) or "\0" in arg for arg in argv)):
        raise RuntimeError("Native launch requires an absolute executable and string arguments")
    configuration = {} if configuration is None else copy.deepcopy(configuration)
    if (not isinstance(configuration, dict) or set(configuration) - CONFIG_FILES
            or any(not isinstance(value, str) for value in configuration.values())):
        raise RuntimeError("Only staged native appearance settings are accepted")
    payload = json.dumps({"argv": argv, "configuration": configuration}, sort_keys=True)
    if len(payload.encode()) > 60000:
        raise RuntimeError("Native launch arguments and staged settings are too large")
    return list(argv), configuration, hashlib.sha256(payload.encode()).hexdigest()


def application_environment(profile, plan, unit):
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(profile / "home"),
            "XDG_RUNTIME_DIR": str(profile / "run"), "XDG_CONFIG_HOME": str(profile / "config"),
            "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
            "XDG_STATE_HOME": str(profile / "state"), "XDG_DATA_DIRS": "/usr/local/share:/usr/share",
            "WAYLAND_DISPLAY": str(Path(plan["runtime"]) / plan["display"]),
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={profile / 'session'}",
            "AT_SPI_BUS_ADDRESS": f"unix:path={profile / 'run' / 'at-spi' / 'bus'}", "GDK_BACKEND": "wayland",
            "QT_QPA_PLATFORM": "wayland", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1",
            "GTK_A11Y": "atspi", "GIO_USE_VFS": "local", "GTK_USE_PORTAL": "0",
            "ORBIT_NATIVE_UNIT": unit}


class NativeApplication:
    def __init__(self, profile, unit, control):
        self.profile, self.unit, self.control = profile, unit, control
        self.supervisor, self.lease, self.process = None, None, None
        self.members = set()
        self.closed = False

    def close(self):
        if self.closed:
            return

        def stop_owned():
            errors = []
            try:
                require_budget()
            except BaseException as error:
                errors.append(error)
            if self.supervisor is not None:
                try:
                    if self.supervisor.stdin is not None and not self.supervisor.stdin.closed:
                        self.supervisor.stdin.close()
                except BaseException as error:
                    errors.append(error)
                try:
                    self.supervisor.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    errors.append(error)
                    # Resume a stopped guardian so its own subreaper can finish.
                    for sig in (signal.SIGCONT, signal.SIGTERM):
                        try:
                            self.supervisor.send_signal(sig)
                        except ProcessLookupError:
                            pass
                    try:
                        self.supervisor.wait(timeout=3)
                    except subprocess.TimeoutExpired as error:
                        errors.append(error)
                        try:
                            self._kill_owned_scope()
                        except BaseException as error:
                            errors.append(error)
                        else:
                            self.supervisor.kill()
                            try:
                                self.supervisor.wait(timeout=3)
                            except subprocess.TimeoutExpired as error:
                                errors.append(error)
                if self.supervisor.returncode != 0:
                    errors.append(RuntimeError("Native supervisor exited with a cleanup failure"))
            if any(process_identity(identity[0]) == identity for identity in self.members):
                errors.append(RuntimeError("Native cleanup left a recorded process alive"))
            if errors:
                raise BaseExceptionGroup("Native cleanup failed", errors)
            self.closed = True
            return {"unit": self.unit, "owned_tree_reaped": True}

        return self.control.cleanup("native-close " + self.unit, stop_owned)

    def _kill_owned_scope(self):
        if self.lease is None:
            raise RuntimeError("No captured native scope for fallback cleanup")
        directory = os.open(self.lease.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(directory)
            if (info.st_dev, info.st_ino) != self.lease.directory_identity:
                raise RuntimeError("Native cleanup scope directory changed")
            # cgroup.kill addresses this captured subtree, including new children.
            target = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                os.write(target, b"1")
            finally:
                os.close(target)
        finally:
            os.close(directory)


class NativeLauncher:
    def __init__(self, plan, parent, control):
        self.plan = copy.deepcopy(plan)
        verify_host(self.plan)
        self.parent = private_directory(parent)
        private_directory(control.directory)
        self.control = control

    def request(self, argv, configuration=None):
        argv, _, digest = launch_arguments(argv, configuration)
        return "native-launch " + json.dumps({"argv": argv, "settings_sha256": digest,
                                               "compositor": self.plan["compositor"],
                                               "abi_hash": self.plan["abi_hash"]}, sort_keys=True)

    def launch(self, argv, configuration=None):
        require_budget()
        argv, configuration, _ = launch_arguments(argv, configuration)
        request = self.request(argv, configuration)
        application = None

        def start():
            nonlocal application
            verify_host(self.plan)
            profile = Path(tempfile.mkdtemp(prefix="native-app-", dir=self.parent))
            unit = "orbit-native-" + uuid.uuid4().hex + ".scope"
            application = NativeApplication(profile, unit, self.control)
            for name in ("home", "run", "config", "data", "cache", "state"):
                (profile / name).mkdir(mode=0o700)
            for name, content in configuration.items():
                path = profile / "config" / name
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with open(path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                    output.write(content)
            spec = {"host": self.plan, "unit": unit, "argv": argv}
            with open(profile / "launch.json", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                json.dump(spec, output)
            here = Path(__file__).resolve().parent
            environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
            with open(profile / "worker.log", "xb") as log:
                application.supervisor = subprocess.Popen(
                    ["/usr/bin/python3", str(here / "supervise.py"), str(profile / "supervisor.json"),
                     "--native-lifecycle", str(self.control.directory), unit,
                     "/usr/bin/python3", str(here / "application_worker.py"), str(profile)],
                    env=environment, stdin=subprocess.PIPE, stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + 15
            while True:
                if application.supervisor.poll() is not None:
                    raise RuntimeError("Native worker exited before application exec")
                report = profile / "application.json"
                if report.exists():
                    state = json.loads(report.read_text())
                    if application.lease is None:
                        application.lease = NativeLease(unit)
                    process = tuple(state["process"])
                    if process_identity(process[0]) != process:
                        raise RuntimeError("Native application exited before exec acknowledgement")
                    token = ("HL_EXEC_RULE_TOKEN=" + state["token"]).encode()
                    if token in Path(f"/proc/{process[0]}/environ").read_bytes().split(b"\0"):
                        if not application.lease.contains(process):
                            raise RuntimeError("Native application escaped its launch scope")
                        application.process = process
                        application.members = application.lease.members()
                        verify_host(self.plan)
                        return {"unit": unit, "process": process, "profile": str(profile), "exec_acknowledged": True}
                if time.monotonic() >= deadline:
                    raise TimeoutError("Native application exec was not acknowledged")
                time.sleep(0.02)

        try:
            self.control.execute(request, start)
            return application
        except BaseException as primary:
            if application is not None:
                try:
                    application.close()
                except BaseException as cleanup:
                    raise BaseExceptionGroup("Native launch and cleanup failed", [primary, cleanup])
            raise
