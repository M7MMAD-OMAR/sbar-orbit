"""Validate exact host files before exposing them to a private Zen namespace.

This module only prepares mounts. The caller must explicitly authorize every path,
hold its cooperative file lease, pass the returned descriptors to bubblewrap, and
close them after the child starts. A file mount supports in-place writes, while
applications that save through rename need a separate file broker.
"""

import os
import stat


class ZenFileMountError(ValueError):
    pass


_DIR_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC


def _parts(path):
    if (not isinstance(path, str) or not path.startswith("/") or "\0" in path
            or len(path) > 4096):
        raise ZenFileMountError("Shared Zen files need absolute paths")
    parts = path.split("/")[1:]
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ZenFileMountError("Shared Zen paths must be canonical")
    return parts


def _directory_identity(path):
    parts = _parts(path)
    parent = os.open("/", _DIR_FLAGS)
    try:
        for part in parts:
            child = os.open(part, _DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
        info = os.fstat(parent)
        return info.st_dev, info.st_ino
    finally:
        os.close(parent)


def _open_file(path, forbidden):
    parts = _parts(path)
    parent = os.open("/", _DIR_FLAGS)
    try:
        for part in parts[:-1]:
            child = os.open(part, _DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            if (info.st_dev, info.st_ino) in forbidden:
                raise ZenFileMountError("Shared Zen file enters a protected directory")
        file_fd = os.open(parts[-1], _FILE_FLAGS, dir_fd=parent)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(file_fd)
            raise ZenFileMountError("Shared Zen files must be single-link regular files")
        return file_fd
    except OSError as error:
        raise ZenFileMountError("Shared Zen file cannot be opened without symbolic links") from error
    finally:
        os.close(parent)


def prepare_zen_file_mounts(paths, protected_directories):
    """Return bubblewrap options, inherited file descriptors and visible paths.

    Each selected host file is mounted by an O_PATH descriptor, so changing the
    pathname after validation cannot redirect the bind to a different file.
    The caller must check the source pathname still resolves to this inode when
    reporting a successful shared edit.
    """
    if (not isinstance(paths, list) or not 1 <= len(paths) <= 16 or
            not isinstance(protected_directories, list) or
            len(protected_directories) < 3 or
            any(not isinstance(path, str) for path in paths)):
        raise ZenFileMountError("Invalid shared Zen file policy")
    protected = {_directory_identity(path) for path in protected_directories}
    command = ["--dir", "/orbit/shared"]
    descriptors = []
    visible = []
    try:
        if len(set(paths)) != len(paths):
            raise ZenFileMountError("Duplicate shared Zen file path")
        identities = set()
        for index, path in enumerate(paths):
            fd = _open_file(path, protected)
            descriptors.append(fd)
            info = os.fstat(fd)
            identity = info.st_dev, info.st_ino
            if identity in identities:
                raise ZenFileMountError("Duplicate shared Zen file identity")
            identities.add(identity)
            folder = f"/orbit/shared/{index + 1}"
            destination = f"{folder}/{_parts(path)[-1]}"
            command.extend(["--dir", folder, "--bind-fd", str(fd), destination])
            visible.append(destination)
        return command, descriptors, visible
    except Exception:
        for fd in descriptors:
            os.close(fd)
        raise
