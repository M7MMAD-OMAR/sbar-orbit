#!/usr/bin/python3
"""Take a bounded, private snapshot of Codex desktop's local project state."""

import fcntl
import json
import os
import sqlite3
import stat
import sys
import time
from contextlib import closing
from pathlib import Path


FICLONE = 0x40049409
MAX_FILES = 4096
MAX_BYTES = 16 * 1024 * 1024 * 1024
MAX_ROLLOUT_BYTES = 2 * 1024 * 1024 * 1024
MAX_DIRECTORIES = 256
MAX_DEPTH = 8
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_DATABASE_BYTES = 256 * 1024 * 1024
ROLLOUT_DIRS = ("sessions", "archived_sessions")


class SourceChangedError(ValueError):
    """A live Codex source changed while it was being snapshotted."""


def identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def plain_file(path: Path, limit: int) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError(f"Unsafe or oversized Codex source: {path.name}")
    return info


def plain_directory(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError(f"Codex directory must not be a link: {path.name}")
    return info


def read_stable(path: Path, limit: int) -> bytes:
    before = plain_file(path, limit)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        if identity(before) != identity(opened):
            raise SourceChangedError(f"Codex source changed while opening: {path.name}")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError(f"Codex source exceeds its size limit: {path.name}")
            chunks.append(chunk)
        if identity(opened) != identity(os.fstat(fd)) or total != opened.st_size:
            raise SourceChangedError(f"Codex source changed during read: {path.name}")
        if identity(before) != identity(path.lstat()):
            raise SourceChangedError(f"Codex source path changed during read: {path.name}")
        return b"".join(chunks)
    finally:
        os.close(fd)


def write_private(path: Path, data: bytes, created: list[Path]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    created.append(path)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def sqlite_backup(source: Path, target: Path, created: list[Path]) -> tuple[int, list[str]]:
    before = plain_file(source, MAX_DATABASE_BYTES)
    if target.exists() or target.is_symlink():
        raise ValueError("Codex private database already exists")
    created.append(target)
    deadline = time.monotonic() + 30

    def check_deadline(_status: int, _remaining: int, _total: int) -> None:
        if time.monotonic() > deadline:
            raise TimeoutError("Codex database backup exceeded 30 seconds")

    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)) as original:
        original.execute("PRAGMA query_only=ON")
        with closing(sqlite3.connect(target, timeout=5)) as copy:
            original.backup(copy, pages=64, sleep=0.05, progress=check_deadline)
            if copy.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise ValueError("Codex database snapshot failed integrity validation")
            projects = copy.execute("SELECT count(*) FROM projects").fetchone()[0]
            paths = [row[0] for row in copy.execute("SELECT rollout_path FROM threads")]
    if target.stat().st_size > MAX_DATABASE_BYTES:
        raise ValueError("Codex private database exceeds its size limit")
    os.chmod(target, 0o600)
    after = source.lstat()
    if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise SourceChangedError("Codex database source was replaced during backup")
    return projects, paths


def reflink(source: Path, target: Path, created: list[Path]) -> int:
    before = plain_file(source, MAX_ROLLOUT_BYTES)
    if source.suffix != ".jsonl":
        raise ValueError("Codex session tree contains a non-rollout file")
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(source_fd)
        if identity(before) != identity(opened):
            raise SourceChangedError("Codex rollout changed while opening")
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        created.append(target)
        try:
            try:
                fcntl.ioctl(target_fd, FICLONE, source_fd)
            except OSError as error:
                raise ValueError("Codex rollouts need a reflink-capable private destination") from error
            if identity(opened) != identity(os.fstat(source_fd)) or identity(before) != identity(source.lstat()):
                raise SourceChangedError("Codex rollout changed during snapshot")
            if os.fstat(target_fd).st_size != opened.st_size:
                raise ValueError("Codex rollout reflink has the wrong size")
            os.fchmod(target_fd, 0o600)
            os.utime(target_fd, ns=(opened.st_atime_ns, opened.st_mtime_ns))
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)
    return before.st_size


def snapshot_once(source: Path, destination: Path) -> dict[str, int | bool]:
    source = source.absolute()
    destination = destination.absolute()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Codex source and destination must be separate directories")
    root_before = plain_directory(source)
    plain_directory(destination)
    if any(destination.iterdir()):
        raise ValueError("Codex snapshot destination must be empty")
    os.chmod(destination, 0o700)
    created: list[Path] = []
    try:
        global_data = read_stable(source / ".codex-global-state.json", MAX_JSON_BYTES)
        global_state = json.loads(global_data)
        if not isinstance(global_state, dict):
            raise ValueError("Codex global state must be an object")
        config_data = read_stable(source / "config.toml", MAX_CONFIG_BYTES)
        write_private(destination / ".codex-global-state.json", global_data, created)
        write_private(destination / "config.toml", config_data, created)
        projects, rollout_paths = sqlite_backup(source / "state_5.sqlite", destination / "state_5.sqlite", created)
        files = 0
        total = 0
        directories = 0

        def copy_tree(from_dir: Path, to_dir: Path, depth: int) -> None:
            nonlocal files, total, directories
            directories += 1
            if directories > MAX_DIRECTORIES or depth > MAX_DEPTH:
                raise ValueError("Codex rollout tree exceeds its directory or depth limit")
            directory_before = plain_directory(from_dir)
            to_dir.mkdir(mode=0o700)
            created.append(to_dir)
            for entry in os.scandir(from_dir):
                from_path = from_dir / entry.name
                to_path = to_dir / entry.name
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    copy_tree(from_path, to_path, depth + 1)
                elif stat.S_ISREG(info.st_mode):
                    if files >= MAX_FILES or total + info.st_size > MAX_BYTES:
                        raise ValueError("Codex rollout snapshot exceeds its file or byte limit")
                    total += reflink(from_path, to_path, created)
                    files += 1
                else:
                    raise ValueError("Codex session tree contains a link or special file")
            if identity(directory_before) != identity(from_dir.lstat()):
                raise SourceChangedError("Codex session directory changed during snapshot")

        for name in ROLLOUT_DIRS:
            from_dir = source / name
            if from_dir.exists() or from_dir.is_symlink():
                copy_tree(from_dir, destination / name, 0)
        for path in rollout_paths:
            if not isinstance(path, str):
                raise ValueError("Codex rollout path is not a string")
            original = Path(path)
            if not original.is_absolute() or not original.is_relative_to(source):
                raise ValueError("Codex database references a rollout outside its source")
            relative = original.relative_to(source)
            if (len(relative.parts) < 2 or ".." in relative.parts or relative.parts[0] not in ROLLOUT_DIRS or
                    not (destination / relative).is_file()):
                raise ValueError("Codex database references a missing rollout")
        if identity(root_before) != identity(source.lstat()):
            raise SourceChangedError("Codex source directory changed during snapshot")
        if global_data != read_stable(source / ".codex-global-state.json", MAX_JSON_BYTES):
            raise SourceChangedError("Codex global state changed during snapshot")
        return {"projects": projects, "threads": len(rollout_paths), "rollouts": files,
                "rolloutBytes": total, "atomicAcrossStores": False}
    except BaseException:
        for path in reversed(created):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink(missing_ok=True)
        raise


def snapshot(source: Path, destination: Path) -> dict[str, int | bool]:
    for attempt in range(1, 4):
        try:
            return {**snapshot_once(source, destination), "attempts": attempt}
        except SourceChangedError:
            if attempt == 3:
                raise
            time.sleep(0.1 * attempt)
    raise AssertionError("Unreachable Codex snapshot retry state")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: codex_state_snapshot.py SOURCE_CODEX_HOME EMPTY_PRIVATE_CODEX_HOME")
    print(json.dumps(snapshot(Path(sys.argv[1]), Path(sys.argv[2]))))
