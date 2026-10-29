"""A lease whose worker is gone is found and released; a live worker or a live session never is."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.native import leases
from src.native.existing import lease_conflict_message

LEASE = "a" * 32
OTHER = "b" * 32


class FakeTransport:
    """Answers the plugin's lease commands from a table and records every request."""

    def __init__(self, status=None, listed=None):
        self.status, self.listed, self.requests = status or {}, listed, []

    def _exchange(self, request, deadline=None):
        self.requests.append(request)
        verb, _, rest = request.partition(" ")
        if verb == "ghost-application-info":
            return json.dumps({"schema": 1, "status": self.status.get(rest, "unavailable"), "lease_id": rest, "windows": []})
        if verb == "ghost-application-list":
            if self.listed is None:
                return "unknown command"
            return json.dumps({"schema": 1, "leases": self.listed})
        if verb in ("ghost-application-control", "ghost-application-reap"):
            self.status.pop(rest.split()[0], None)
            return "ok"
        raise AssertionError(request)


def make_worker(root, name, lease, **extra):
    folder = Path(root) / name / "worker"
    folder.mkdir(parents=True)
    (folder / "handoff.json").write_text(json.dumps({"lease_id": lease, "selection": {}, **extra}))
    return folder


class ProcessTests(unittest.TestCase):
    def test_stat_start_ticks_survives_names_with_spaces_and_parentheses(self):
        fields = ["S"] + ["0"] * 18 + ["424242"] + ["0"] * 10
        self.assertEqual(leases.stat_start_ticks("123 (a b) c) " + " ".join(fields)), 424242)
        self.assertIsNone(leases.stat_start_ticks("garbage"))

    def test_own_process_is_alive_a_wrong_start_time_is_not(self):
        start = leases.own_start_ticks()
        self.assertTrue(leases.process_alive(os.getpid(), start))
        self.assertFalse(leases.process_alive(os.getpid(), start + 1))
        self.assertFalse(leases.process_alive(2 ** 22 + 12345, 1))

    def test_owner_token_names_this_process(self):
        pid, _, start = leases.owner_token().partition(":")
        self.assertEqual((int(pid), int(start)), (os.getpid(), leases.own_start_ticks()))


class DiscoveryTests(unittest.TestCase):
    def test_records_without_an_owner_fall_back_to_the_process_table(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            folder = make_worker(root, "native-dead", LEASE)
            found = leases.discover(root, proc)
            self.assertEqual([(e["lease_id"], e["worker_alive"]) for e in found], [(LEASE, False)])
            live = Path(proc, "77")
            live.mkdir()
            (live / "cmdline").write_bytes(b"python3\0existing_worker.py\0" + str(folder).encode() + b"\0")
            self.assertTrue(leases.discover(root, proc)[0]["worker_alive"])

    def test_malformed_records_are_ignored(self):
        with tempfile.TemporaryDirectory() as root:
            make_worker(root, "native-bad", "not-a-lease")
            self.assertEqual(leases.discover(root), [])


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.root, self.proc = tempfile.TemporaryDirectory(), tempfile.TemporaryDirectory()
        self.folder = make_worker(self.root.name, "native-orphan", LEASE, pid=2 ** 22 + 99, start=5)

    def tearDown(self):
        self.root.cleanup()
        self.proc.cleanup()

    def leases(self, transport, live=()):
        return leases.Leases(transport, self.root.name, live, self.proc.name)

    def test_orphan_is_listed_releasable_and_released(self):
        transport = FakeTransport({LEASE: "active"})
        view = self.leases(transport)
        entry = view.records()[0]
        self.assertEqual((entry["lease_id"], entry["releasable"], entry["worker_alive"]), (LEASE, True, False))
        result = view.release(LEASE)
        self.assertTrue(result["handedBack"])
        self.assertIn(f"ghost-application-control {LEASE} handback", transport.requests)
        self.assertIn(f"ghost-application-reap {LEASE}", transport.requests)
        self.assertFalse((self.folder / "handoff.json").exists())

    def test_a_live_session_keeps_its_lease_even_when_its_worker_is_gone(self):
        transport = FakeTransport({LEASE: "active"})
        view = self.leases(transport, live=[LEASE])
        self.assertFalse(view.records()[0]["releasable"])
        with self.assertRaisesRegex(ValueError, "broker session"):
            view.release(LEASE)
        self.assertFalse(any(r.startswith("ghost-application-control") for r in transport.requests))

    def test_a_live_worker_is_never_released(self):
        own = make_worker(self.root.name, "native-live", OTHER, pid=os.getpid(), start=leases.own_start_ticks())
        transport = FakeTransport({OTHER: "active"})
        with self.assertRaisesRegex(ValueError, "worker is alive"):
            leases.Leases(transport, self.root.name, (), "/proc").release(OTHER)
        self.assertTrue((own / "handoff.json").exists())

    def test_a_lease_the_plugin_no_longer_holds_is_not_listed(self):
        self.assertEqual(self.leases(FakeTransport({})).records(), [])
        with self.assertRaisesRegex(ValueError, "No active lease"):
            self.leases(FakeTransport({})).release(LEASE)

    def test_plugin_list_finds_leases_with_no_worker_directory(self):
        listed = [{"lease_id": OTHER, "owner_pid": 9, "owner_alive": "no", "age_seconds": 700}]
        entries = {e["lease_id"]: e for e in self.leases(FakeTransport({LEASE: "active"}, listed)).records()}
        self.assertTrue(entries[OTHER]["releasable"])
        self.assertIsNone(entries[OTHER]["worker_dir"])

    def test_a_malformed_identity_is_refused(self):
        with self.assertRaises(ValueError):
            self.leases(FakeTransport()).release("../../x")

    def test_reap_after_a_killed_worker_hands_back_and_clears_the_record(self):
        transport = FakeTransport({LEASE: "active"})
        result = self.leases(transport, live=[LEASE]).reap_worker(self.folder)
        self.assertTrue(result["released"])
        self.assertFalse((self.folder / "handoff.json").exists())
        self.assertIn(f"ghost-application-control {LEASE} handback", transport.requests)

    def test_reap_leaves_a_worker_that_is_still_running(self):
        running = Path(self.proc.name, "55")
        running.mkdir()
        (running / "cmdline").write_bytes(str(self.folder).encode())
        transport = FakeTransport({LEASE: "active"})
        self.assertFalse(self.leases(transport).reap_worker(self.folder)["released"])
        self.assertEqual(transport.requests, [])

    def test_reap_after_a_clean_close_does_nothing(self):
        (self.folder / "handoff.json").unlink()
        self.assertFalse(self.leases(FakeTransport()).reap_worker(self.folder)["released"])


class ConflictMessageTests(unittest.TestCase):
    def test_the_holder_is_named_and_an_orphan_says_how_to_release_it(self):
        raw = f"refused: application lease already exists or lease bound reached lease={LEASE} owner_pid=42 owner_alive=no"
        message = lease_conflict_message(raw)
        self.assertIn(LEASE, message)
        self.assertIn("orphan", message)
        self.assertIn("native-leases release " + LEASE, message)
        live = lease_conflict_message(raw.replace("owner_alive=no", "owner_alive=yes"))
        self.assertIn("its worker is alive", live)
        self.assertNotIn("release", live)

    def test_an_older_plugin_without_detail_keeps_the_generic_message(self):
        self.assertEqual(lease_conflict_message("refused: application lease already exists or lease bound reached"),
                         "Application client is already leased or native lease capacity is reached")


if __name__ == "__main__":
    unittest.main()
