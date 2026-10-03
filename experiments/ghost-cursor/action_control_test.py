#!/usr/bin/python3
"""Behavioral checks for owner mode, durable intent and one-use approval."""
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest

from action_control import ActionControl, ControlError


def concurrent_action(directory, index):
    with ActionControl(directory) as control:
        control.execute(f"actor {index}", lambda: {"actor": index})


def long_action(directory, entered, release):
    with ActionControl(directory) as control:
        def operation():
            entered.set()
            if not release.wait(timeout=5):
                raise RuntimeError("Long actor was not released")
            return "finished"
        control.execute("long actor", operation)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-control-test-")
        self.directory = Path(self.temp.name) / "control"
        self.control = ActionControl(self.directory)

    def tearDown(self):
        self.control.close()
        self.temp.cleanup()

    def test_protected_approval_matches_once_and_is_consumed_on_error(self):
        called = []
        request = "ghost-key window ctrl+a"
        operation = lambda: called.append("ran") or "ok"
        with self.assertRaises(ControlError):
            self.control.execute(request, operation)
        self.assertEqual(called, [])
        self.control.configure(approve=request)
        with self.assertRaises(ControlError):
            self.control.execute(request + " extra", operation)
        self.assertEqual(self.control.execute(request, operation), "ok")
        with self.assertRaises(ControlError):
            self.control.execute(request, operation)
        self.assertEqual(called, ["ran"])
        self.control.configure(approve=request)
        with self.assertRaisesRegex(RuntimeError, "target failed"):
            self.control.execute(request, lambda: (_ for _ in ()).throw(RuntimeError("target failed")))
        with self.assertRaises(ControlError):
            self.control.execute(request, operation)
        self.assertEqual(self.control.inspect()["unresolved"], [])

    def test_full_mode_records_intent_before_operation_and_survives_reopen(self):
        self.control.configure(mode="full")
        def operation():
            events = [json.loads(line) for line in (self.directory / "actions.jsonl").read_text().splitlines()]
            self.assertEqual(events[-1]["phase"], "begin")
            return "actual result"
        self.control.execute("mode protected is just action content", operation)
        self.control.close()
        self.control = ActionControl(self.directory)
        report = self.control.inspect()
        self.assertEqual(report["settings"]["mode"], "full")
        self.assertEqual(report["events"][-1]["result"], "actual result")
        self.assertEqual(report["unresolved"], [])

    def test_broken_journal_prevents_operation_and_missing_result_is_visible(self):
        self.control.configure(mode="full")
        journal = self.directory / "actions.jsonl"
        saved = self.directory / "saved.jsonl"
        journal.rename(saved)
        journal.mkdir()
        called = []
        with self.assertRaises(OSError):
            self.control.execute("blocked input", lambda: called.append(True))
        self.assertEqual(called, [])
        journal.rmdir()
        saved.rename(journal)
        self.control._record({"id": "interrupted", "phase": "begin", "kind": "action"})
        self.assertEqual(self.control.inspect()["unresolved"], ["interrupted"])

    def test_symlink_settings_and_nonprivate_journal_are_refused(self):
        target = Path(self.temp.name) / "foreign"
        target.write_text('{"mode":"full","approval":null}')
        settings = self.directory / "settings.json"
        settings.symlink_to(target)
        called = []
        with self.assertRaises(OSError):
            self.control.execute("do input", lambda: called.append(True))
        settings.unlink()
        self.control.configure(mode="full")
        (self.directory / "actions.jsonl").chmod(0o644)
        with self.assertRaises(ControlError):
            self.control.execute("do input", lambda: called.append(True))
        self.assertEqual(called, [])

    def test_concurrent_actors_keep_unique_complete_records(self):
        self.control.configure(mode="full")
        workers = [multiprocessing.Process(target=concurrent_action, args=(self.directory, i)) for i in range(8)]
        try:
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=10)
                self.assertEqual(worker.exitcode, 0)
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(timeout=5)
        report = self.control.inspect()
        begins = [e for e in report["events"] if e["phase"] == "begin" and e["kind"] == "action"]
        self.assertEqual(len({e["id"] for e in begins}), 8)
        self.assertEqual(report["unresolved"], [])

    def test_long_action_does_not_block_another_actor(self):
        self.control.configure(mode="full")
        entered, release = multiprocessing.Event(), multiprocessing.Event()
        long = multiprocessing.Process(target=long_action, args=(self.directory, entered, release))
        short = multiprocessing.Process(target=concurrent_action, args=(self.directory, 99))
        try:
            long.start()
            self.assertTrue(entered.wait(timeout=3))
            short.start()
            short.join(timeout=1)
            self.assertEqual(short.exitcode, 0, "The short actor waited for the long action")
            self.assertTrue(long.is_alive())
        finally:
            release.set()
            for worker in (long, short):
                if worker.pid is not None:
                    worker.join(timeout=5)
                    if worker.is_alive():
                        worker.terminate()
                        worker.join(timeout=5)
        self.assertEqual(long.exitcode, 0)
        self.assertEqual(self.control.inspect()["unresolved"], [])


if __name__ == "__main__":
    unittest.main()
