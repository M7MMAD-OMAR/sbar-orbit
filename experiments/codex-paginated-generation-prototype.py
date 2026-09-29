#!/usr/bin/python3
"""Fixture-only coordinated generation for one simple saved Codex thread."""

import asyncio
import base64
import json
import runpy
import secrets
import shutil
import sqlite3
import time
from pathlib import Path


HERE = Path(__file__).parent
BASE = runpy.run_path(str(HERE / "codex-paginated-live-owner-read.py"))
PAGE = runpy.run_path(str(HERE / "codex-paginated-live-page.py"))
SQLITE_NAMES = BASE["SQLITE_NAMES"]
fingerprint = BASE["fingerprint"]
read_page = PAGE["read_page"]


class Unavailable(Exception):
    pass


class Generation:
    def __init__(self, token, root, thread_id, prefix_bytes, fingerprint_value):
        self.token = token
        self.root = root
        self.thread_id = thread_id
        self.prefix_bytes = prefix_bytes
        self.fingerprint = fingerprint_value
        self.expires_at = time.monotonic() + 30


class FixtureCoordinator:
    def __init__(self, owner_root, snapshot_root, helper_binary, owner_process):
        self.owner_root = owner_root
        self.snapshot_root = snapshot_root
        self.helper_binary = helper_binary
        self.owner_process = owner_process
        self.lock = asyncio.Lock()
        self.generations = {}
        self.writer_count = 0

    def require_owner(self):
        if self.owner_process.poll() is not None:
            raise Unavailable("fake owner process is no longer active")

    async def turn(self, rpc, thread_id, label):
        async with self.lock:
            self.require_owner()
            await rpc.turn(thread_id, label)
            self.writer_count += 1

    async def open(self, thread_id):
        async with self.lock:
            self.require_owner()
            if self.writer_count < 2:
                raise Unavailable("fixture owner has not completed two coordinated turns")
            before = fingerprint(self.owner_root)
            state = sqlite3.connect(
                f"file:{self.owner_root / 'state_5.sqlite'}?mode=ro", uri=True)
            history = sqlite3.connect(
                f"file:{self.owner_root / 'thread_history_1.sqlite'}?mode=ro", uri=True)
            try:
                for connection in (state, history):
                    connection.execute("PRAGMA query_only=ON")
                    connection.execute("BEGIN")
                row = state.execute(
                    "SELECT rollout_path, history_mode, archived FROM threads WHERE id = ?",
                    (thread_id,)).fetchone()
                checkpoint = history.execute(
                    "SELECT next_rollout_byte_offset, next_rollout_ordinal "
                    "FROM thread_history_projection_state WHERE thread_id = ?",
                    (thread_id,)).fetchone()
                if row is None or row[1] != "paginated" or row[2] != 0 or checkpoint is None:
                    raise Unavailable("only an active saved paginated fixture thread is supported")
                rollout = Path(row[0])
                fixture_prefix = Path("/fixture/sessions")
                try:
                    relative = rollout.relative_to(fixture_prefix)
                except ValueError:
                    raise Unavailable("rollout path is outside the fixture") from None
                if not relative.parts or rollout.suffix != ".jsonl" or not rollout.name.endswith(
                        "-" + thread_id + ".jsonl") or any(part in (".", "..") for part in relative.parts):
                    raise Unavailable("fork, revert, or compressed rollout is unsupported")
                selected = self.owner_root / "sessions" / relative
                candidate = self.owner_root / "sessions"
                for part in relative.parts:
                    candidate = candidate / part
                    if candidate.is_symlink():
                        raise Unavailable("selected rollout path contains a symlink")
                if not selected.is_file() or selected.stat().st_size > 64 * 1024 * 1024:
                    raise Unavailable("selected rollout is unavailable")
                with selected.open("rb") as source:
                    data = source.read(64 * 1024 * 1024 + 1)
                if not data or len(data) > 64 * 1024 * 1024 or not data.endswith(b"\n"):
                    raise Unavailable("selected rollout lacks a bounded complete prefix")
                ordinal = -1
                for index, line in enumerate(data.splitlines()):
                    record = json.loads(line)
                    if record.get("ordinal") != ordinal + 1:
                        raise Unavailable("rollout ordinal gap is unsupported")
                    if index == 0:
                        meta = record.get("payload")
                        if (record.get("type") != "session_meta" or not isinstance(meta, dict) or
                                meta.get("id") != thread_id or meta.get("history_mode") != "paginated" or
                                meta.get("history_base") is not None):
                            raise Unavailable("fork or replacement lineage is unsupported")
                    ordinal += 1
                if checkpoint != (len(data), ordinal + 1):
                    raise Unavailable("history checkpoint does not match selected rollout prefix")
                token = secrets.token_urlsafe(24)
                destination = self.snapshot_root / token
                destination.mkdir(mode=0o700)
                try:
                    for name in SQLITE_NAMES:
                        shutil.copy2(self.owner_root / name, destination / name)
                    output = destination / "sessions" / relative
                    output.parent.mkdir(mode=0o700, parents=True)
                    output.write_bytes(data)
                    if fingerprint(self.owner_root) != before:
                        raise Unavailable("fake owner changed source while opening generation")
                    captured = fingerprint(destination)
                    generation = Generation(token, destination, thread_id, len(data), captured)
                    self.generations[token] = generation
                    return generation
                except BaseException:
                    shutil.rmtree(destination, ignore_errors=True)
                    raise
            finally:
                state.close()
                history.close()

    def page(self, token, cursor, limit):
        generation = self.generations.get(token)
        if generation is None or time.monotonic() >= generation.expires_at:
            self.close(token)
            raise Unavailable("snapshot token is missing or expired")
        self.require_owner()
        if cursor is None:
            owner_cursor = None
        else:
            prefix = token + "."
            if not cursor.startswith(prefix):
                raise Unavailable("cursor belongs to a different generation")
            try:
                owner_cursor = base64.urlsafe_b64decode(cursor[len(prefix):] + "===").decode("ascii")
            except (ValueError, UnicodeDecodeError):
                raise Unavailable("invalid generation cursor") from None
        if fingerprint(generation.root) != generation.fingerprint:
            raise Unavailable("captured generation changed before page read")
        result = read_page(generation.root, self.helper_binary, {"method": "thread/turns/list",
            "params": {"threadId": generation.thread_id, "readOnly": True, "limit": limit,
                       "cursor": owner_cursor, "sortDirection": "asc", "itemsView": "full"}})
        if fingerprint(generation.root) != generation.fingerprint:
            raise Unavailable("captured generation changed during page read")
        next_cursor = result.get("nextCursor")
        if next_cursor is not None:
            result["nextCursor"] = token + "." + base64.urlsafe_b64encode(
                next_cursor.encode("ascii")).decode("ascii").rstrip("=")
        return result

    def close(self, token):
        generation = self.generations.pop(token, None)
        if generation is not None:
            shutil.rmtree(generation.root)
