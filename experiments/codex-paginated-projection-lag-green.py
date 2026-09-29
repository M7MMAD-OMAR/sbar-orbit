#!/usr/bin/python3
"""Fixture-only read guard for one standalone paginated Codex rollout."""

import asyncio
import json
import runpy
import sqlite3
import subprocess
import sys
from pathlib import Path


SQLITE_NAMES = tuple(base + suffix for base in ("state_5.sqlite", "thread_history_1.sqlite")
                     for suffix in ("", "-wal", "-shm"))
MAX_ROLLOUT_BYTES = 64 * 1024 * 1024


class ProjectionUnavailableError(Exception):
    pass


def unavailable(message):
    raise ProjectionUnavailableError("UNAVAILABLE: " + message)


def inspect_child(thread_id):
    if len(thread_id) != 36 or any(character not in "0123456789abcdef-" for character in thread_id):
        unavailable("invalid fixture thread ID")
    with sqlite3.connect("file:/fixture/state_5.sqlite?mode=ro", uri=True) as state:
        state.execute("PRAGMA query_only=ON")
        state_row = state.execute(
            "SELECT rollout_path, history_mode FROM threads WHERE id = ?", (thread_id,)
        ).fetchone()
    if state_row is None or state_row[1] != "paginated":
        unavailable("selected thread is not a saved paginated fixture")

    rollout = Path(state_row[0])
    sessions = Path("/fixture/sessions")
    if not rollout.is_absolute() or rollout.suffix != ".jsonl":
        unavailable("selected rollout is unsupported")
    try:
        relative = rollout.relative_to(sessions)
    except ValueError:
        unavailable("selected rollout is outside the fixture")
    if not relative.parts or any(part in (".", "..") for part in relative.parts):
        unavailable("selected rollout path is invalid")
    if not rollout.name.endswith("-" + thread_id + ".jsonl"):
        unavailable("replacement or forked rollout is unsupported")
    current = sessions
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            unavailable("selected rollout contains a symlink")
    if not rollout.is_file() or rollout.stat().st_size > MAX_ROLLOUT_BYTES:
        unavailable("selected rollout is missing or too large")

    with sqlite3.connect("file:/fixture/thread_history_1.sqlite?mode=ro", uri=True) as history:
        history.execute("PRAGMA query_only=ON")
        checkpoint = history.execute(
            "SELECT next_rollout_byte_offset, next_rollout_ordinal "
            "FROM thread_history_projection_state WHERE thread_id = ?", (thread_id,)
        ).fetchone()
    if checkpoint is None:
        unavailable("history projection checkpoint is missing")
    projected_bytes, projected_ordinal = checkpoint
    if not isinstance(projected_bytes, int) or not isinstance(projected_ordinal, int):
        unavailable("history projection checkpoint is invalid")

    data = rollout.read_bytes()
    if not data or not data.endswith(b"\n"):
        unavailable("selected rollout has an incomplete tail")
    last_ordinal = -1
    for index, raw_line in enumerate(data.splitlines()):
        if not raw_line:
            unavailable("blank rollout line is unsupported")
        line = json.loads(raw_line)
        ordinal = line.get("ordinal")
        if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal != last_ordinal + 1:
            unavailable("rollout ordinals are unsupported")
        if index == 0:
            metadata = line.get("payload")
            if (line.get("type") != "session_meta" or not isinstance(metadata, dict) or
                    metadata.get("id") != thread_id or
                    metadata.get("history_mode") != "paginated" or
                    metadata.get("history_base") is not None):
                unavailable("selected rollout lineage is unsupported")
        last_ordinal = ordinal
    if projected_bytes != len(data) or projected_ordinal != last_ordinal + 1:
        unavailable("history projection lags selected rollout")
    print(json.dumps({"ok": True, "projectedBytes": projected_bytes,
                      "nextOrdinal": projected_ordinal}, separators=(",", ":")))


def inspect_fixture(root, thread_id):
    root = root.resolve(strict=True)
    if not str(root).startswith("/tmp/orbit-paginated-live-mismatch-"):
        unavailable("only the disposable mixed-generation fixture is supported")
    probe = Path(__file__).resolve(strict=True)
    command = ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--new-session",
               "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
               "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
               "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/fixture"]
    for name in SQLITE_NAMES:
        command.extend(("--ro-bind", str(root / name), "/fixture/" + name))
    command.extend(("--ro-bind", str(root / "sessions"), "/fixture/sessions",
                    "--ro-bind", str(probe), "/probe", "--setenv", "HOME", "/tmp",
                    "--", "/usr/bin/python3", "/probe", "child", thread_id))
    result = subprocess.run(command, capture_output=True, timeout=5)
    if result.returncode != 0:
        error = result.stderr.decode(errors="replace").strip()
        unavailable(error[:256] if error else "projection inspection failed")
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError:
        unavailable("projection inspection returned invalid output")
    if response.get("ok") is not True:
        unavailable("projection inspection returned no result")
    return response


def run_fixture_red_with_guard():
    red = runpy.run_path(str(Path(__file__).with_name("codex-paginated-cross-store-red.py")))
    base = runpy.run_path(str(Path(__file__).with_name("codex-paginated-live-owner-read.py")))
    original_guarded_page = base["guarded_page"]
    fingerprint = base["fingerprint"]
    stale_error = base["StalePageError"]

    def guarded_page_with_projection(root, binary, thread_id, expected_source=None):
        before = fingerprint(root)
        if expected_source is not None and before != expected_source:
            raise stale_error("A prior page source version is stale")
        inspect_fixture(root, thread_id)
        if fingerprint(root) != before:
            raise stale_error("Fake source changed during projection inspection")
        page, inner_before, inner_after = original_guarded_page(
            root, binary, thread_id, expected_source)
        if inner_before != before or inner_after != before or fingerprint(root) != before:
            raise stale_error("Fake source changed during guarded page read")
        return page, inner_before, inner_after

    main = red["main"]
    main.__globals__["guarded_page"] = guarded_page_with_projection
    asyncio.run(main())


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "child":
        try:
            inspect_child(sys.argv[2])
        except Exception as error:
            print(f"{type(error).__name__}: {error}", file=sys.stderr)
            sys.exit(2)
    else:
        run_fixture_red_with_guard()
