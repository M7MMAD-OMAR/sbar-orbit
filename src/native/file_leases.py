"""Cooperative canonical-path reservations owned by an application supervisor."""
import errno
import fcntl
import hashlib
import os
from pathlib import Path
import stat


class FileLeaseError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def acquire_files(paths):
    descriptors = []
    directory_fd = None
    try:
        if not isinstance(paths, list) or len(paths) > 32:
            raise ValueError("At most 32 selected files are supported")
        canonical = set()
        for path in paths:
            if not isinstance(path, str) or not path.startswith("/") or "\0" in path or len(path) > 4096:
                raise ValueError("Selected files require absolute paths")
            resolved = Path(path).resolve(strict=True)
            metadata = resolved.stat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ValueError("Select existing regular files without hard links")
            canonical.add(str(resolved))
        if not canonical:
            return [], []
        root = Path(f"/tmp/orbit-file-leases-{os.getuid()}")
        root.mkdir(mode=0o700, exist_ok=True)
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        metadata = os.fstat(directory_fd)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("File lease storage must be private")
        for path in sorted(canonical):
            name = hashlib.sha256(os.fsencode(path)).hexdigest() + ".lock"
            fd = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
            descriptors.append(fd)
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
                raise ValueError("Invalid file lease storage")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN):
                    raise FileLeaseError("FILE_BUSY", "Selected file is reserved by another application") from error
                raise
        return sorted(canonical), descriptors
    except Exception as error:
        for fd in descriptors:
            os.close(fd)
        if isinstance(error, FileLeaseError):
            raise
        raise FileLeaseError("INVALID_REQUEST", "Selected files or lease storage are invalid") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
