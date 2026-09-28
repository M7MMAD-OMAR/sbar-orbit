"""Hide host desktop sockets while allowing an application's nested mount sandbox."""

import os
import pwd
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


def mount_command(arguments, report_directory, selected_files, policy):
    if (not isinstance(policy, dict)
            or set(policy) not in ({"runtime", "sockets"}, {"runtime", "sockets", "privateHome"})
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
               "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
               "--tmpfs", "/tmp", "--bind", session, session,
               "--tmpfs", runtime]
    descriptors = []
    try:
        if "privateHome" in policy:
            private_home = policy["privateHome"]
            host_home = pwd.getpwuid(os.getuid()).pw_dir
            if (not isinstance(private_home, str) or not private_home.startswith("/")
                    or "\0" in private_home or len(private_home) > 4096
                    or not inside(private_home, session) or private_home == session
                    or os.path.realpath(private_home) != private_home
                    or not inside(host_home, "/home") or host_home.count("/") != 2):
                raise PrivateMountUnavailable("Private home path is unavailable")
            fd = os.open(private_home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            descriptors.append(fd)
            found = os.fstat(fd)
            if (not stat.S_ISDIR(found.st_mode) or found.st_uid != os.getuid()
                    or found.st_mode & 0o077):
                raise PrivateMountUnavailable("Private home has unsafe ownership")
            command += ["--tmpfs", "/home", "--dir", host_home,
                        "--bind-fd", str(fd), host_home]
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
