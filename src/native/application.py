"""Validate owner-only transport storage, never an application profile."""
import os
import stat
from pathlib import Path

def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("Native application directory must be canonical, private and owned")
    return path
