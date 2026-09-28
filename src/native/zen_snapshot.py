#!/usr/bin/python3
"""Make a private, validated copy of a Firefox family profile."""

import errno
import fcntl
import json
import os
import sqlite3
import stat
import sys
from pathlib import Path


FICLONE = 0x40049409
MAX_FILES = 200_000
MAX_BYTES = 8 * 1024**3
MAX_FILE_BYTES = 2 * 1024**3
LOCK_NAMES = {"lock", ".parentlock", "parent.lock"}


def excluded(name: str) -> bool:
    return name in LOCK_NAMES or name.startswith("Singleton") or name.endswith(".sock")


def snapshot(source: Path, destination: Path) -> dict[str, int]:
    root = source.lstat()
    if not stat.S_ISDIR(root.st_mode) or source.is_symlink():
        raise ValueError("Zen source must be a directory, not a symlink")
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("Zen destination must be an empty private directory")
    os.chmod(destination, 0o700)
    counts = {"files": 0, "bytes": 0, "databases": 0, "excluded": 0}
    databases: list[Path] = []

    def copy_regular(from_path: Path, to_path: Path, before: os.stat_result) -> None:
        if before.st_nlink != 1 or before.st_size > MAX_FILE_BYTES:
            raise ValueError("Zen source file has unsafe links or exceeds the size limit")
        counts["files"] += 1
        counts["bytes"] += before.st_size
        if counts["files"] > MAX_FILES or counts["bytes"] > MAX_BYTES:
            raise ValueError("Zen profile exceeds the snapshot budget")
        source_fd = os.open(from_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            opened = os.fstat(source_fd)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError("Zen source entry changed while opening")
            target_fd = os.open(to_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
            try:
                try:
                    fcntl.ioctl(target_fd, FICLONE, source_fd)
                except OSError as error:
                    if error.errno not in {errno.EOPNOTSUPP, errno.ENOTTY, errno.EXDEV, errno.EINVAL}:
                        raise
                    while True:
                        chunk = os.read(source_fd, 1024 * 1024)
                        if not chunk:
                            break
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(target_fd, view):]
                after = os.fstat(source_fd)
                if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
                ):
                    raise ValueError("Zen source file changed during copy")
                if os.fstat(target_fd).st_size != opened.st_size:
                    raise ValueError("Zen copied file has the wrong size")
            finally:
                os.close(target_fd)
        finally:
            os.close(source_fd)

    def walk(from_dir: Path, to_dir: Path) -> None:
        for entry in os.scandir(from_dir):
            if excluded(entry.name):
                counts["excluded"] += 1
                continue
            from_path = from_dir / entry.name
            to_path = to_dir / entry.name
            before = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                os.mkdir(to_path, 0o700)
                walk(from_path, to_path)
                after = from_path.lstat()
                if not stat.S_ISDIR(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    raise ValueError("Zen source directory changed during copy")
            elif stat.S_ISREG(before.st_mode):
                copy_regular(from_path, to_path, before)
                if entry.name.endswith(".sqlite"):
                    databases.append(to_path)
            else:
                counts["excluded"] += 1

    walk(source, destination)
    for database in databases:
        compact = database.with_name(database.name + ".orbit-backup")
        try:
            with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as original:
                original.execute("PRAGMA query_only=ON")
                with sqlite3.connect(compact, timeout=5) as copy:
                    original.backup(copy, pages=256, sleep=0.05)
                    result = copy.execute("PRAGMA quick_check").fetchone()
                    if not result or result[0] != "ok":
                        raise ValueError("Zen SQLite validation failed")
            os.chmod(compact, 0o600)
            os.replace(compact, database)
            for suffix in ("-wal", "-shm", "-journal"):
                database.with_name(database.name + suffix).unlink(missing_ok=True)
            counts["databases"] += 1
        finally:
            compact.unlink(missing_ok=True)
    return counts


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: zen_snapshot.py SOURCE DESTINATION")
    os.umask(0o077)
    try:
        print(json.dumps(snapshot(Path(sys.argv[1]), Path(sys.argv[2]))))
    except Exception as error:
        print(f"Zen snapshot failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
