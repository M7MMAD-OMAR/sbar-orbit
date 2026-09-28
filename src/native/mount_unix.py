"""Hide host desktop sockets while allowing an application's nested mount sandbox."""

import os
import pwd
import re
import stat


class PrivateMountUnavailable(Exception):
    pass


def inside(path, root):
    return path == root or path.startswith(root + "/")


def open_verified_socket(entry):
    if (not isinstance(entry, dict) or set(entry) != {"path", "device", "inode"}
            or not isinstance(entry["path"], str) or not entry["path"].startswith("/")
            or "\0" in entry["path"] or len(entry["path"]) > 4096
            or not isinstance(entry["device"], str) or not entry["device"].isdecimal()
            or not isinstance(entry["inode"], str) or not entry["inode"].isdecimal()):
        raise PrivateMountUnavailable("Invalid private socket identity")
    if os.path.realpath(entry["path"]) != entry["path"]:
        raise PrivateMountUnavailable("Private socket path resolves through a link")
    fd = os.open(entry["path"], os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        found = os.fstat(fd)
        if (not stat.S_ISSOCK(found.st_mode) or found.st_uid != os.getuid()
                or found.st_dev != int(entry["device"])
                or found.st_ino != int(entry["inode"])):
            raise PrivateMountUnavailable("Private socket changed before launch")
    except Exception:
        os.close(fd)
        raise
    return fd


def open_verified_project(entry, host_home):
    if (not isinstance(entry, dict) or set(entry) != {"path", "device", "inode"}
            or not isinstance(entry["path"], str) or not inside(entry["path"], host_home)
            or entry["path"] == host_home or len(entry["path"]) > 4096 or "\0" in entry["path"]
            or not isinstance(entry["device"], str) or not entry["device"].isdecimal()
            or not isinstance(entry["inode"], str) or not entry["inode"].isdecimal()):
        raise PrivateMountUnavailable("Invalid selected Codex project")
    parts = entry["path"][len(host_home) + 1:].split("/")
    if not parts or parts[0].startswith(".") or any(part in ("", ".", "..") for part in parts):
        raise PrivateMountUnavailable("Selected Codex project has an unsafe path")
    current = os.open(host_home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if os.fstat(current).st_uid != os.getuid():
            raise PrivateMountUnavailable("Codex home has unsafe ownership")
        for part in parts:
            next_fd = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=current)
            os.close(current)
            current = next_fd
            if os.fstat(current).st_uid != os.getuid():
                raise PrivateMountUnavailable("Selected Codex project has unsafe ownership")
        found = os.fstat(current)
        if found.st_dev != int(entry["device"]) or found.st_ino != int(entry["inode"]):
            raise PrivateMountUnavailable("Selected Codex project changed before launch")
        result = current
        current = -1
        return result, parts
    except OSError as error:
        raise PrivateMountUnavailable("Selected Codex project changed before launch") from error
    finally:
        if current >= 0:
            os.close(current)


def render_device_mounts():
    """Expose render nodes without exposing host input or display-control devices."""
    try:
        with os.scandir("/dev/dri") as scan:
            entries = sorted(scan, key=lambda entry: entry.name)
    except FileNotFoundError:
        return []
    nodes = []
    for entry in entries:
        if not re.fullmatch(r"renderD[0-9]+", entry.name):
            continue
        info = entry.stat(follow_symlinks=False)
        if not stat.S_ISCHR(info.st_mode) or info.st_uid != 0:
            continue
        nodes.append(entry.path)
    if len(nodes) > 16:
        raise PrivateMountUnavailable("Too many render devices for a private desktop")
    if not nodes:
        return []
    command = ["--dir", "/dev/dri"]
    for node in nodes:
        command.extend(["--dev-bind", node, node])
    return command


def mount_command(arguments, report_directory, selected_files, policy):
    if (not isinstance(policy, dict)
            or set(policy) not in ({"runtime", "sockets"}, {"runtime", "sockets", "privateHome"},
                                   {"runtime", "sockets", "privateHome", "sharedProject"},
                                   {"runtime", "sockets", "privateHome", "authoritySocket"})
            or not isinstance(policy["runtime"], str)
            or not isinstance(policy["sockets"], list)
            or not 1 <= len(policy["sockets"]) <= 8):
        raise PrivateMountUnavailable("Invalid private desktop mount policy")
    session = str(report_directory)
    runtime = policy["runtime"]
    expected_runtime = f"/run/user/{os.getuid()}"
    if (not session.startswith("/tmp/orbit-native-") or os.path.realpath(session) != session
            or runtime != expected_runtime or os.path.realpath(runtime) != runtime):
        raise PrivateMountUnavailable("Private session or host runtime path is unavailable")
    session_info = os.lstat(session)
    runtime_info = os.lstat(runtime)
    if (not stat.S_ISDIR(session_info.st_mode) or session_info.st_uid != os.getuid()
            or session_info.st_mode & 0o077 or not stat.S_ISDIR(runtime_info.st_mode)
            or runtime_info.st_uid != os.getuid()):
        raise PrivateMountUnavailable("Private session or host runtime has unsafe ownership")
    command = ["/usr/bin/bwrap", "--unshare-pid", "--unshare-ipc", "--die-with-parent",
               "--bind", "/", "/", "--dev", "/dev", *render_device_mounts(), "--proc", "/proc",
               "--tmpfs", "/tmp", "--bind", session, session,
               "--tmpfs", runtime]
    descriptors = []
    try:
        if "privateHome" in policy:
            private_home = policy["privateHome"]
            host_home = pwd.getpwuid(os.getuid()).pw_dir
            disk_root = os.path.join(host_home, ".cache", "sbar-orbit", "codex-private")
            disk_parts = (os.path.relpath(private_home, disk_root).split("/")
                          if isinstance(private_home, str) and inside(private_home, disk_root) else [])
            disk_home = (len(disk_parts) == 2 and re.fullmatch(r"codex-[A-Za-z0-9]{6}", disk_parts[0])
                         and disk_parts[1] == "home")
            if (not isinstance(private_home, str) or not private_home.startswith("/")
                    or "\0" in private_home or len(private_home) > 4096
                    or (not inside(private_home, session) and not disk_home) or private_home == session
                    or os.path.realpath(private_home) != private_home
                    or not inside(host_home, "/home") or host_home.count("/") != 2):
                raise PrivateMountUnavailable("Private home path is unavailable")
            if disk_home:
                for candidate in (disk_root, os.path.dirname(private_home)):
                    check = os.lstat(candidate)
                    if (not stat.S_ISDIR(check.st_mode) or check.st_uid != os.getuid()
                            or check.st_mode & 0o077 or os.path.realpath(candidate) != candidate):
                        raise PrivateMountUnavailable("Private disk home root is unsafe")
            fd = os.open(private_home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            descriptors.append(fd)
            found = os.fstat(fd)
            if (not stat.S_ISDIR(found.st_mode) or found.st_uid != os.getuid()
                    or found.st_mode & 0o077):
                raise PrivateMountUnavailable("Private home has unsafe ownership")
            command += ["--tmpfs", "/home", "--dir", host_home,
                        "--bind-fd", str(fd), host_home]
            if "sharedProject" in policy:
                if not disk_home:
                    raise PrivateMountUnavailable("A selected Codex project needs a private disk home")
                project_fd, parts = open_verified_project(policy["sharedProject"], host_home)
                descriptors.append(project_fd)
                current_path = host_home
                for part in parts:
                    current_path = os.path.join(current_path, part)
                    command += ["--dir", current_path]
                command += ["--bind-fd", str(project_fd), current_path]
        seen = set()
        for entry in policy["sockets"]:
            fd = open_verified_socket(entry)
            path = entry["path"]
            if path in seen:
                os.close(fd)
                raise PrivateMountUnavailable("Duplicate private socket identity")
            seen.add(path)
            if inside(path, session):
                os.close(fd)
                continue
            descriptors.append(fd)
            if path.startswith("/tmp/.X11-unix/X") and path[len("/tmp/.X11-unix/X"):].isdecimal():
                command += ["--dir", "/tmp/.X11-unix", "--bind-fd", str(fd), path]
                continue
            if path == runtime + "/pipewire-0":
                command += ["--bind-fd", str(fd), path]
                continue
            if path == runtime + "/pulse/native":
                command += ["--dir", runtime + "/pulse", "--bind-fd", str(fd), path]
                continue
            raise PrivateMountUnavailable("Unexpected socket outside the private display")
        if "authoritySocket" in policy:
            entry = policy["authoritySocket"]
            path = entry.get("path") if isinstance(entry, dict) else None
            if (not isinstance(path, str) or not path.startswith(runtime + "/")
                    or path in seen or path == runtime + "/orbit-codex-authority.sock"):
                raise PrivateMountUnavailable("Codex authority socket is outside the user runtime")
            fd = open_verified_socket(entry)
            descriptors.append(fd)
            found = os.fstat(fd)
            if found.st_mode & 0o077 or found.st_nlink != 1:
                raise PrivateMountUnavailable("Codex authority socket has unsafe permissions")
            current = os.path.dirname(path)
            while inside(current, runtime):
                info = os.lstat(current)
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_mode & 0o077 or os.path.realpath(current) != current):
                    raise PrivateMountUnavailable("Codex authority socket parent is unsafe")
                if current == runtime:
                    break
                current = os.path.dirname(current)
            command += ["--bind-fd", str(fd), runtime + "/orbit-codex-authority.sock"]
        for path in selected_files:
            if inside(path, "/tmp") and not inside(path, session):
                fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
                found = os.fstat(fd)
                if not stat.S_ISREG(found.st_mode):
                    os.close(fd)
                    raise PrivateMountUnavailable("Selected temporary file changed before launch")
                descriptors.append(fd)
                command += ["--bind-fd", str(fd), path]
        return command + arguments, descriptors
    except Exception:
        for fd in descriptors:
            os.close(fd)
        raise
