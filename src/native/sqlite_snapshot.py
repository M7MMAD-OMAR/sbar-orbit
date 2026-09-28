#!/usr/bin/python3
"""Copy a live SQLite database with SQLite's online backup API."""

import os
import sqlite3
import stat
import sys
from pathlib import Path


def snapshot(source: Path, target: Path) -> None:
    before = source.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError("Source must be one regular file without hard links")
    if target.exists() or target.is_symlink():
        raise ValueError("Destination already exists")

    os.umask(0o077)
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5) as original:
            original.execute("PRAGMA query_only=ON")
            with sqlite3.connect(target, timeout=5) as copy:
                original.backup(copy, pages=64, sleep=0.05)
                if copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError("SQLite snapshot failed its integrity check")
        after = source.lstat()
        if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError("Source was replaced during the snapshot")
        target.chmod(0o600)
    except BaseException:
        target.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: sqlite_snapshot.py SOURCE TARGET")
    snapshot(Path(sys.argv[1]), Path(sys.argv[2]))
