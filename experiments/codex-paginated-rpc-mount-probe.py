#!/usr/bin/python3
"""Probe existing paginated app-server RPCs on a disposable fake Codex home.

The caller supplies a synthetic fixture. This script clones it twice. Both
app-server processes run in private bwrap namespaces with no network. The
green process has read-only history database files and rollouts.
"""

import argparse
import hashlib
import json
import os
import selectors
import shutil
import signal
import sqlite3
import stat
import subprocess
import tempfile
import time
from pathlib import Path


WATCHED = (
    "state_5.sqlite",
    "state_5.sqlite-wal",
    "state_5.sqlite-shm",
    "thread_history_1.sqlite",
    "thread_history_1.sqlite-wal",
    "thread_history_1.sqlite-shm",
)


class Rpc:
    def __init__(self, child):
        self.child = child
        self.fd = child.stdout.fileno()
        os.set_blocking(self.fd, False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.fd, selectors.EVENT_READ)
        self.buffer = bytearray()
        self.messages = []

    def call(self, request_id, method, params):
        self.child.stdin.write((json.dumps({
            "id": request_id, "method": method, "params": params,
        }) + "\n").encode())
        self.child.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.selector.select(0.2):
                data = os.read(self.fd, 65536)
                if not data:
                    raise RuntimeError(f"app-server closed stdout during {method}")
                self.buffer.extend(data)
                while b"\n" in self.buffer:
                    line, _, remaining = self.buffer.partition(b"\n")
                    self.buffer[:] = remaining
                    if line:
                        self.messages.append(json.loads(line))
            for index, message in enumerate(self.messages):
                if message.get("id") == request_id:
                    response = self.messages.pop(index)
                    if "error" in response:
                        raise RuntimeError(f"{method}: {response['error']}")
                    return response["result"]
        raise TimeoutError(f"{method} did not respond")

    def notify(self, method):
        self.child.stdin.write((json.dumps({"method": method, "params": {}}) + "\n").encode())
        self.child.stdin.flush()


def file_state(path):
    if not path.is_file():
        return None
    stat = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size": stat.st_size,
            "modifiedNs": stat.st_mtime_ns, "mode": stat.st_mode & 0o777}


def snapshots(home):
    result = {name: file_state(home / name) for name in WATCHED}
    for path in sorted((home / "sessions").rglob("*.jsonl")):
        result[str(path.relative_to(home))] = file_state(path)
    return result


def ignore_special(directory, names):
    ignored = []
    for name in names:
        mode = (Path(directory) / name).lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            ignored.append(name)
    return ignored


def rebase_fixture_rollouts(source, clone):
    with sqlite3.connect(clone / "state_5.sqlite") as database:
        rows = database.execute("SELECT id, rollout_path FROM threads").fetchall()
        for thread_id, rollout_path in rows:
            relative = Path(rollout_path).relative_to(source)
            if not (clone / relative).is_file():
                raise ValueError("Cloned fixture lacks a referenced rollout")
            database.execute("UPDATE threads SET rollout_path = ? WHERE id = ?",
                             (str(Path("/fixture") / relative), thread_id))


def stop(child):
    if child.poll() is not None:
        return
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


def isolated_command(codex, fixture, writable):
    command = [
        "/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--new-session",
        "--clearenv", "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--bind", str(fixture), "/fixture",
    ]
    if not writable:
        for suffix in ("", "-wal", "-shm"):
            name = "thread_history_1.sqlite" + suffix
            if (fixture / name).is_file():
                command.extend(["--ro-bind", str(fixture / name), "/fixture/" + name])
        command.extend(["--ro-bind", str(fixture / "sessions"), "/fixture/sessions"])
        command.extend(["--setenv", "ORBIT_PAGINATED_READ_ONLY_EXPERIMENT", "1"])
    command.extend([
        "--ro-bind", str(codex), "/codex",
        "--setenv", "HOME", "/tmp",
        "--setenv", "CODEX_HOME", "/fixture",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--chdir", "/tmp", "--", "/codex", "app-server", "--listen", "stdio://",
    ])
    return command


def probe(codex, fixture, thread_id, writable):
    child = subprocess.Popen(
        isolated_command(codex, fixture, writable), stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    result = {"mount": "writable" if writable else "historyReadOnly"}
    try:
        rpc = Rpc(child)
        rpc.call(1, "initialize", {"clientInfo": {
            "name": "orbit_paginated_rpc_probe", "title": "Orbit paginated RPC probe",
            "version": "1",
        }, "capabilities": {"experimentalApi": True}})
        rpc.notify("initialized")
        before = snapshots(fixture)
        params = {"threadId": thread_id, "limit": 5,
                  "sortDirection": "asc", "itemsView": "full"}
        first_turns = rpc.call(2, "thread/turns/list", params)
        next_turn_cursor = first_turns.get("nextCursor")
        second_turns = rpc.call(3, "thread/turns/list", {
            **params, "cursor": next_turn_cursor,
        }) if next_turn_cursor else None
        item_params = {"threadId": thread_id, "limit": 1,
                       "sortDirection": "asc"}
        first_items = rpc.call(4, "thread/items/list", item_params)
        next_item_cursor = first_items.get("nextCursor")
        second_items = rpc.call(5, "thread/items/list", {
            **item_params, "cursor": next_item_cursor,
        }) if next_item_cursor else None
        after = snapshots(fixture)
        full_turn_text = json.dumps(first_turns.get("data", []), ensure_ascii=False)
        result.update({
            "turnsFirstCount": len(first_turns.get("data", [])),
            "turnsSecondCount": len(second_turns.get("data", [])) if second_turns else None,
            "itemsFirstCount": len(first_items.get("data", [])),
            "itemsSecondCount": len(second_items.get("data", [])) if second_items else None,
            "turnsCursorPresent": bool(next_turn_cursor),
            "itemsCursorPresent": bool(next_item_cursor),
            "turnsResponseFields": sorted(first_turns),
            "itemsResponseFields": sorted(first_items),
            "turnFields": sorted(first_turns["data"][0]) if first_turns.get("data") else [],
            "itemEntryFields": sorted(first_items["data"][0]) if first_items.get("data") else [],
            "itemFields": sorted(first_items["data"][0]["item"]) if first_items.get("data") else [],
            "itemTypes": [entry["item"].get("type") for page in (first_items, second_items)
                          if page for entry in page.get("data", [])],
            "fixtureUserTextPresent": "Private fixture conversation" in full_turn_text,
            "fixtureAssistantTextPresent": "Orbit completed fixture answer" in full_turn_text,
            "changedFiles": sorted(name for name in before if before[name] != after[name]),
            "filePresence": sorted(name for name, state in after.items() if state),
        })
    except Exception as error:
        result["error"] = str(error)
    finally:
        stop(child)
        error_output = child.stderr.read(4096).decode(errors="replace")
        if error_output and "error" in result:
            result["serverStderrTail"] = error_output[-1000:]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--fixture-home", type=Path, required=True)
    parser.add_argument("--thread-id", required=True)
    args = parser.parse_args()
    if not args.codex.is_file() or not args.fixture_home.is_dir():
        raise ValueError("Codex binary and synthetic fixture home must exist")
    if not args.fixture_home.is_relative_to(Path("/var/tmp")):
        raise ValueError("Synthetic fixture home must live under /var/tmp")
    source_before = snapshots(args.fixture_home)
    with tempfile.TemporaryDirectory(prefix="orbit-codex-paginated-rpc-", dir="/var/tmp") as root:
        results = []
        for writable in (True, False):
            clone = Path(root) / ("red" if writable else "green")
            shutil.copytree(args.fixture_home, clone, symlinks=False,
                            ignore=ignore_special)
            os.chmod(clone, 0o700)
            rebase_fixture_rollouts(args.fixture_home, clone)
            results.append(probe(args.codex, clone, args.thread_id, writable))
        source_after = snapshots(args.fixture_home)
        source_changes = sorted(name for name in source_before
                                if source_before[name] != source_after[name])
        for result in results:
            result["originalFixtureChangedFiles"] = source_changes
        print(json.dumps(results, sort_keys=True))
        red, green = results
        if ("error" in green or not green.get("turnsFirstCount") or
                not green.get("itemsFirstCount") or
                not green.get("fixtureUserTextPresent") or
                not green.get("fixtureAssistantTextPresent")):
            raise SystemExit(1)
        if green["changedFiles"]:
            raise SystemExit(2)
        if not red["changedFiles"]:
            raise SystemExit(3)
        if source_changes:
            raise SystemExit(4)


if __name__ == "__main__":
    main()
