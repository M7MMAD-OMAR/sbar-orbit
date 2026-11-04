"""Owned NativeSession.execute fixtures for omission of cursor refresh, not input quiescence."""
from contextlib import ExitStack
from pathlib import Path
import copy
import hashlib
import json
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import session as native
from src.native.existing import ExistingApplicationSession

APP, WINDOW = "a" * 32, "b" * 32
MODE = "passive-v1"


class Clock:
    def __init__(self):
        self.now = 100.0

    def advance(self, seconds):
        self.now += seconds

    def module(self):
        return SimpleNamespace(monotonic=lambda: self.now, sleep=self.advance, time=lambda: 1000.0)


class PassiveObservationTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.clock = Clock()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(native, "time", self.clock.module()))
        self.stack.enter_context(patch.object(native, "require_budget", side_effect=lambda: self.events.append(("budget",))))
        self.stack.enter_context(patch.object(native, "verify_host", side_effect=lambda *_: self.events.append(("verify",))))
        # Fail closed if an accidentally unmocked path tries to reach the real desktop.
        self.stack.enter_context(patch("subprocess.Popen", side_effect=AssertionError("no real child processes")))
        self.stack.enter_context(patch("socket.socket", side_effect=AssertionError("no real sockets")))
        self.session = native.NativeSession.__new__(native.NativeSession)
        self.session.closed = False
        self.session.plan = {"runtime": "/owned-passive-fixture", "display": "not-a-live-display"}
        self.session.control = SimpleNamespace(execute=self.control)
        self.target = {"address": "0x1", "key": (APP, "c"), "size": (100, 80), "pointer": None}
        self.session._target = self.get_target
        self.session._app = lambda *_: SimpleNamespace(unit="lease-" + APP, profile=Path("/unused-passive-fixture"))
        self.session._owned_windows = self.windows
        self.session._geometry = lambda *_: None
        self.session._check_target = lambda *_: self.events.append(("check-target",))
        self.tree_value = {"status": "unavailable", "reason": "owned fixture", "complete": False}
        self.session._tree = self.tree
        self.session.transport = SimpleNamespace(_perform=self.perform)
        # Wrap, rather than replace, the real helper so legacy tests reach its transport effect.
        self.refresh = Mock(wraps=self.session._ensure_pointer)
        self.session._ensure_pointer = self.refresh
        self.capture_mock = self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        self.deadlines = []
        self.capture_hook = None

    def control(self, request, operation):
        self.events.append(("control-begin", json.loads(request.removeprefix("native-session "))))
        try:
            result = operation()
        except BaseException:
            self.events.append(("control-error",))
            raise
        self.events.append(("control-finish",))
        return result

    def get_target(self, *_, passive=False):
        self.events.append(("target",))
        return self.target

    def windows(self, *_, commit=True):
        self.events.append(("windows",))
        return [{"appId": APP, "windowId": WINDOW, "title": "owned fixture", "width": 100, "height": 80}]

    def tree(self, _target, deadline=None):
        self.events.append(("tree", deadline))
        native.capture_remaining(deadline)
        return copy.deepcopy(self.tree_value)

    def perform(self, request):
        self.events.append(("transport", request))
        return "ok"

    def capture(self, argv, _environment, _log, _margin, deadline=None):
        self.events.append(("capture", tuple(argv)))
        self.deadlines.append(deadline)
        native.capture_remaining(deadline)
        dimensions = tuple(self.target["size"])
        self.clock.advance(0.03)
        if self.capture_hook is not None:
            self.capture_hook()
        native.capture_remaining(deadline)
        return b"owned fixture pixels", *dimensions

    def observe(self, *, passive=True, **extra):
        action = {"type": "observe", "appId": APP, "windowId": WINDOW}
        if passive:
            action["observationMode"] = MODE
        return self.session.execute({**action, **extra})

    def assert_no_refresh(self):
        self.refresh.assert_not_called()
        self.assertEqual([event for event in self.events if event[0] == "transport"], [])
        self.assertIsNone(self.target["pointer"])

    def assert_passive_ack(self, frame):
        self.assertEqual(frame["observation"]["mode"], MODE)
        self.assertEqual(frame["observation"]["cursorRefresh"], "omitted")
        self.assert_no_refresh()

    def test_image_omits_refresh_and_reports_exact_narrow_ack(self):
        frame = self.observe()
        self.assertEqual(frame["mimeType"], "image/png")
        self.assertEqual(frame["appId"], APP)
        self.assertEqual(frame["windowId"], WINDOW)
        self.assertEqual(self.capture_mock.call_count, 1)
        self.assertEqual([event[1][0] for event in self.events if event[0] == "capture"], ["/usr/bin/grim"])
        self.assertEqual([event[0] for event in self.events if event[0].startswith("control-")],
                         ["control-begin", "control-finish"])
        self.assert_passive_ack(frame)

    def test_both_omits_refresh_for_success_and_unavailable_tree(self):
        for status in ("ok", "unavailable"):
            with self.subTest(status=status):
                self.tree_value = {"status": status, "nodes": [], "complete": status == "ok"}
                frame = self.observe(format="both")
                self.assertEqual(frame["mimeType"], "image/png")
                self.assertEqual(frame["tree"]["status"], status)
                self.assert_passive_ack(frame)
        self.assertEqual(self.capture_mock.call_count, 2)

    def test_text_never_falls_back_to_pixels_in_passive_mode(self):
        for status in ("ok", "unavailable", "timeout"):
            with self.subTest(status=status):
                self.tree_value = {"status": status, "nodes": [], "complete": False}
                frame = self.observe(format="text")
                self.assertEqual(frame["mimeType"], "text/x-orbit-a11y")
                self.assertEqual(frame["tree"]["status"], status)
                self.assertEqual(frame["observation"]["returnedFormat"], "text")
                self.assertNotIn("image", frame)
                self.assert_passive_ack(frame)
        self.capture_mock.assert_not_called()

    def test_digest_only_omits_refresh_and_keeps_ack(self):
        frame = self.observe(digestOnly=True)
        self.assertNotIn("image", frame)
        self.assertEqual(frame["sha256"], hashlib.sha256(b"owned fixture pixels").hexdigest())
        self.assertEqual(frame["bytes"], len(b"owned fixture pixels"))
        self.assertEqual(self.capture_mock.call_count, 1)
        self.assert_passive_ack(frame)

    def test_settle_recaptures_share_deadline_without_refresh(self):
        frame = self.observe(timeoutMs=300, quietMs=20, graceMs=0)
        self.assertEqual(self.capture_mock.call_count, 2)
        self.assertTrue(frame["settle"]["settled"])
        self.assertEqual(len(set(self.deadlines)), 1)
        self.assertAlmostEqual(self.deadlines[0], 100.3)
        self.assert_passive_ack(frame)

    def test_geometry_retry_never_refreshes(self):
        def resize_once():
            self.target["size"] = (101, 80)
            self.capture_hook = None
        self.capture_hook = resize_once
        frame = self.observe()
        self.assertEqual(self.capture_mock.call_count, 2)
        self.assertEqual(frame["surfaceWidth"], 101)
        self.assertEqual(len(set(self.deadlines)), 1)
        self.assert_passive_ack(frame)

    def test_repeated_geometry_change_fails_after_three_without_refresh(self):
        self.capture_hook = lambda: self.target.update(size=(self.target["size"][0] + 1, 80))
        with self.assertRaises(native.CaptureGeometryChanged):
            self.observe()
        self.assertEqual(self.capture_mock.call_count, 3)
        self.assert_no_refresh()

    def test_capture_error_preserves_failure_without_refresh_or_retry(self):
        self.capture_mock.side_effect = native.CaptureUnavailable()
        with self.assertRaises(native.CaptureUnavailable):
            self.observe()
        self.assertEqual(self.capture_mock.call_count, 1)
        self.assertIn(("control-error",), self.events)
        self.assert_no_refresh()

    def test_expired_capture_deadline_never_refreshes(self):
        self.capture_hook = lambda: self.clock.advance(0.2)
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(timeoutMs=100)
        self.assertEqual(self.capture_mock.call_count, 1)
        self.assert_no_refresh()

    def test_expired_tree_deadline_never_falls_back_or_refreshes(self):
        def slow_tree(_target, deadline=None):
            self.clock.advance(0.2)
            return {"status": "unavailable"}
        self.session._tree = slow_tree
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(format="text", observationTimeoutMs=100)
        self.capture_mock.assert_not_called()
        self.assert_no_refresh()

    def test_invalid_modes_reject_before_control_target_capture_or_transport(self):
        for mode in (None, False, True, 0, 1, "", "passive", "PASSIVE-V1", "passive-v2", [], {}):
            with self.subTest(mode=mode):
                self.events.clear()
                with self.assertRaises(native.SessionError):
                    self.observe(observationMode=mode)
                self.assertEqual(self.events, [("budget",)])
        self.capture_mock.assert_not_called()
        self.assert_no_refresh()

    def test_nonobserve_actions_reject_mode_before_admission(self):
        actions = [
            {"type": "windows", "appId": APP},
            {"type": "key", "appId": APP, "windowId": WINDOW, "key": "Return"},
            {"type": "text", "appId": APP, "windowId": WINDOW, "text": "fixture"},
            {"type": "click", "appId": APP, "windowId": WINDOW, "x": 2, "y": 3},
            {"type": "state", "appId": APP, "windowId": WINDOW},
        ]
        for action in actions:
            with self.subTest(kind=action["type"]):
                self.events.clear()
                with self.assertRaises(native.SessionError):
                    self.session.execute({**action, "observationMode": MODE})
                self.assertEqual(self.events, [("budget",)])
        self.capture_mock.assert_not_called()
        self.assert_no_refresh()

    def test_legacy_image_keeps_cursor_refresh_and_does_not_claim_passive_ack(self):
        frame = self.observe(passive=False)
        self.refresh.assert_called_once()
        commands = [event[1] for event in self.events if event[0] == "transport"]
        self.assertEqual(commands, ["ghost-cursor 0x1@c@lease-" + APP + " 50 40"])
        self.assertNotEqual(frame["observation"].get("mode"), MODE)
        self.assertNotEqual(frame["observation"].get("cursorRefresh"), "omitted")

    def test_legacy_unavailable_text_keeps_image_fallback_and_cursor_refresh(self):
        frame = self.observe(passive=False, format="text")
        self.assertEqual(frame["mimeType"], "image/png")
        self.assertEqual(frame["tree"]["status"], "unavailable")
        self.capture_mock.assert_called_once()
        self.refresh.assert_called_once()
        self.assertNotEqual(frame["observation"].get("mode"), MODE)

    def test_legacy_available_text_still_returns_text_without_refresh(self):
        self.tree_value = {"status": "ok", "nodes": [], "complete": True}
        frame = self.observe(passive=False, format="text")
        self.assertEqual(frame["mimeType"], "text/x-orbit-a11y")
        self.capture_mock.assert_not_called()
        self.assert_no_refresh()
        self.assertNotEqual(frame["observation"].get("mode"), MODE)


class ProductionPassiveMetadataTests(unittest.TestCase):
    """Real enumeration, target validation and execution, with only OS boundaries faked."""
    SIBLING = "d" * 32

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.events = []
        self.clock = Clock()
        self.stack.enter_context(patch.object(native, "time", self.clock.module()))
        self.stack.enter_context(patch.object(native, "require_budget"))
        self.stack.enter_context(patch.object(native, "verify_host"))
        self.stack.enter_context(patch("subprocess.Popen", side_effect=AssertionError("no real processes")))
        self.stack.enter_context(patch("socket.socket", side_effect=AssertionError("no real sockets")))
        self.session = ExistingApplicationSession.__new__(ExistingApplicationSession)
        self.session.lock = threading.RLock()
        self.session.closed = False
        self.session.lease_id = APP
        self.session.plan = {"runtime": "/owned-metadata-fixture", "display": "not-live"}
        self.session.apps = {APP: SimpleNamespace(unit="lease-" + APP, profile=Path("/unused-owned-fixture"), closed=False)}
        self.session.windows = {
            WINDOW: {"key": (APP, "c", APP), "address": "0x1", "size": [100, 80],
                     "pointer": {"x": 90, "y": 70}},
            self.SIBLING: {"key": (APP, "e", APP), "address": "0x2", "size": [200, 150],
                           "pointer": {"x": 120, "y": 90}},
        }
        self.leased = [self.lease("0x1", "c"), self.lease("0x2", "e")]
        self.clients = [self.client("0x1", "c", [80, 60]), self.client("0x2", "e", [20, 10])]
        self.session._info = lambda: {"status": "active", "windows": copy.deepcopy(self.leased)}
        self.session.transport = SimpleNamespace(_exchange=self.exchange, _perform=self.perform)
        self.session.control = SimpleNamespace(execute=self.control)
        self.session._geometry = lambda *_: None
        self.session._tree = lambda *_args, **_kwargs: {"status": "unavailable", "reason": "fixture"}
        self.capture_mock = self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        self.before = copy.deepcopy(self.session.windows)
        self.before_apps = copy.deepcopy(self.session.apps)
        self.window_refs = dict(self.session.windows)
        self.pointer_refs = {key: value["pointer"] for key, value in self.session.windows.items()}
        self.size_refs = {key: value["size"] for key, value in self.session.windows.items()}

    def lease(self, address, stable):
        return {"address": address, "stable": stable, "target": address + "@" + stable + "@lease-" + APP}

    def client(self, address, stable, size):
        return {"address": address, "stableId": stable, "size": size, "title": "fresh " + stable}

    def exchange(self, request):
        self.events.append(("exchange", request))
        if request == "j/clients":
            return json.dumps(self.clients)
        if request.startswith("ghost-target-check "):
            return "ok"
        raise AssertionError("Unexpected exchange: " + request)

    def perform(self, request):
        self.events.append(("perform", request))
        raise AssertionError("Passive fixture must not send cursor or input commands")

    def control(self, request, operation):
        self.events.append(("control", request))
        return operation()

    def capture(self, *_args, deadline=None):
        self.events.append(("capture", deadline))
        native.capture_remaining(deadline)
        self.clock.advance(0.03)
        return b"owned metadata pixels", *self.clients[0]["size"]

    def execute(self, **extra):
        return self.session.execute({"type": "observe", "appId": APP, "windowId": WINDOW,
                                     "observationMode": MODE, **extra})

    def assert_originals_unchanged(self):
        self.assertEqual(self.session.windows, self.before)
        self.assertEqual(self.session.apps, self.before_apps)
        for identity, original in self.window_refs.items():
            self.assertIs(self.session.windows[identity], original)
            self.assertIs(original["pointer"], self.pointer_refs[identity])
            self.assertIs(original["size"], self.size_refs[identity])
        self.assertFalse(any(event[0] == "perform" for event in self.events))

    def test_real_target_returns_fresh_local_size_and_cleared_local_pointer_only(self):
        snapshot = self.session._target(APP, WINDOW, passive=True)
        self.assertIsNot(snapshot, self.session.windows[WINDOW])
        self.assertEqual(tuple(snapshot["size"]), (80, 60))
        self.assertIsNone(snapshot["pointer"])
        self.assertEqual(snapshot["address"], "0x1")
        self.assertEqual(snapshot["key"], (APP, "c", APP))
        self.assert_originals_unchanged()
        snapshot["size"] = [1, 1]
        self.assert_originals_unchanged()

    def test_real_target_deep_copies_in_bounds_pointer(self):
        self.clients[0]["size"] = [120, 100]
        snapshot = self.session._target(APP, WINDOW, passive=True)
        self.assertEqual(snapshot["pointer"], {"x": 90, "y": 70})
        self.assertIsNot(snapshot["pointer"], self.session.windows[WINDOW]["pointer"])
        snapshot["pointer"]["x"] = 1
        self.assert_originals_unchanged()

    def test_real_enumeration_shrunk_sibling_and_unknown_sibling_do_not_commit(self):
        self.leased.append(self.lease("0x3", "f"))
        self.clients.append(self.client("0x3", "f", [50, 40]))
        with patch("src.native.existing.uuid.uuid4", side_effect=AssertionError("must not mint passive handles")):
            result = self.session._owned_windows(APP, commit=False)
        self.assertEqual([item["windowId"] for item in result], [WINDOW, self.SIBLING])
        self.assertEqual([(item["width"], item["height"]) for item in result], [(80, 60), (20, 10)])
        self.assert_originals_unchanged()

    def test_real_address_change_refuses_without_partial_metadata_commit(self):
        self.leased[1] = self.lease("0x9", "e")
        self.clients[1] = self.client("0x9", "e", [20, 10])
        with self.assertRaises(native.SessionError):
            self.session._target(APP, WINDOW, passive=True)
        self.assert_originals_unchanged()

    def test_real_stable_replacement_refuses_original_handle_without_registration(self):
        self.leased[0] = self.lease("0x1", "f")
        self.clients[0] = self.client("0x1", "f", [80, 60])
        with self.assertRaises(native.TargetClosed):
            self.session._target(APP, WINDOW, passive=True)
        self.assert_originals_unchanged()

    def test_real_default_enumeration_still_commits_sizes_pointer_clear_and_new_handle(self):
        self.leased.append(self.lease("0x3", "f"))
        self.clients.append(self.client("0x3", "f", [50, 40]))
        result = self.session._owned_windows(APP)
        self.assertEqual(len(result), 3)
        self.assertEqual(len(self.session.windows), 3)
        self.assertEqual(self.session.windows[WINDOW]["size"], [80, 60])
        self.assertIsNone(self.session.windows[WINDOW]["pointer"])
        self.assertIsNone(self.session.windows[self.SIBLING]["pointer"])
        self.assertIs(self.session._target(APP, WINDOW), self.session.windows[WINDOW])

    def test_real_execute_image_both_digest_and_settle_leave_metadata_unchanged(self):
        for options in ({}, {"format": "both"}, {"digestOnly": True},
                        {"timeoutMs": 300, "quietMs": 20, "graceMs": 0}):
            with self.subTest(options=options):
                frame = self.execute(**options)
                self.assertEqual((frame["width"], frame["height"]), (80, 60))
                self.assertEqual(frame["observation"]["mode"], MODE)
                self.assertEqual(frame["observation"]["cursorRefresh"], "omitted")
                if not options.get("digestOnly"):
                    self.assertIsNone(frame["pointer"])
                    self.assertEqual([item["windowId"] for item in frame["windows"]], [WINDOW, self.SIBLING])
                self.assert_originals_unchanged()

    def test_real_execute_failed_capture_does_not_commit_initial_resize_or_pointer_clear(self):
        self.capture_mock.side_effect = native.CaptureUnavailable()
        with self.assertRaises(native.CaptureUnavailable):
            self.execute()
        self.capture_mock.assert_called_once()
        self.assert_originals_unchanged()

    def test_real_execute_late_invalid_sibling_metadata_does_not_commit_before_refusal(self):
        self.clients[1]["size"] = [0, 10]
        with self.assertRaises(native.SessionError):
            self.execute()
        self.capture_mock.assert_not_called()
        self.assert_originals_unchanged()

    def test_real_execute_postcapture_unknown_sibling_does_not_gain_handle(self):
        def capture_then_add(*args, deadline=None):
            result = self.capture(*args, deadline=deadline)
            if len(self.leased) == 2:
                self.leased.append(self.lease("0x3", "f"))
                self.clients.append(self.client("0x3", "f", [50, 40]))
            return result
        self.capture_mock.side_effect = capture_then_add
        frame = self.execute()
        self.assertEqual([item["windowId"] for item in frame["windows"]], [WINDOW, self.SIBLING])
        self.assert_originals_unchanged()


    def test_real_passive_text_ok_and_unavailable_keep_fresh_geometry_without_commits(self):
        for status in ("ok", "unavailable"):
            with self.subTest(status=status):
                self.session._tree = lambda *_args, **_kwargs: {
                    "status": status, "nodes": [], "complete": status == "ok"}
                frame = self.execute(format="text")
                self.assertEqual(frame["mimeType"], "text/x-orbit-a11y")
                self.assertEqual(frame["tree"]["status"], status)
                self.assertEqual((frame["width"], frame["height"]), (80, 60))
                self.assertEqual((frame["surfaceWidth"], frame["surfaceHeight"]), (80, 60))
                self.assertIsNone(frame["pointer"])
                self.assertEqual(frame["observation"]["mode"], MODE)
                self.assertEqual(frame["observation"]["cursorRefresh"], "omitted")
                self.assertNotIn("image", frame)
                self.assert_originals_unchanged()
        self.capture_mock.assert_not_called()

    def test_real_passive_tree_resize_refuses_even_unavailable_without_pixels_or_commits(self):
        for status in ("ok", "unavailable"):
            for format in ("text", "both"):
                with self.subTest(status=status, format=format):
                    self.clients[0]["size"] = [80, 60]
                    def resizing_tree(_target, deadline=None):
                        native.capture_remaining(deadline)
                        self.clients[0]["size"] = [81, 61]
                        return {"status": status, "nodes": [], "complete": False}
                    self.session._tree = resizing_tree
                    with self.assertRaises(native.CaptureGeometryChanged):
                        self.execute(format=format)
                    self.capture_mock.assert_not_called()
                    self.assert_originals_unchanged()

    def test_real_detached_resize_once_retries_with_current_local_dimensions(self):
        def resize_after_first_capture(*args, deadline=None):
            result = self.capture(*args, deadline=deadline)
            if self.capture_mock.call_count == 1:
                self.clients[0]["size"] = [81, 61]
            return result
        self.capture_mock.side_effect = resize_after_first_capture
        frame = self.execute()
        self.assertEqual(self.capture_mock.call_count, 2)
        self.assertEqual((frame["width"], frame["height"]), (81, 61))
        self.assertEqual((frame["surfaceWidth"], frame["surfaceHeight"]), (81, 61))
        self.assertIsNone(frame["pointer"])
        target_metadata = next(item for item in frame["windows"] if item["windowId"] == WINDOW)
        self.assertEqual((target_metadata["width"], target_metadata["height"]), (81, 61))
        deadlines = [event[1] for event in self.events if event[0] == "capture"]
        self.assertEqual(len(deadlines), 2)
        self.assertEqual(len(set(deadlines)), 1)
        self.assertAlmostEqual(deadlines[0], 110.0)
        self.assertEqual(frame["observation"]["cursorRefresh"], "omitted")
        self.assert_originals_unchanged()

    def test_real_detached_continuous_resize_exhausts_three_on_original_deadline(self):
        def resize_after_every_capture(*args, deadline=None):
            result = self.capture(*args, deadline=deadline)
            self.clients[0]["size"] = [self.clients[0]["size"][0] + 1, 60]
            return result
        self.capture_mock.side_effect = resize_after_every_capture
        with self.assertRaises(native.CaptureGeometryChanged):
            self.execute()
        self.assertEqual(self.capture_mock.call_count, 3)
        deadlines = [event[1] for event in self.events if event[0] == "capture"]
        self.assertEqual(len(deadlines), 3)
        self.assertEqual(len(set(deadlines)), 1)
        self.assertAlmostEqual(deadlines[0], 110.0)
        self.assert_originals_unchanged()


if __name__ == "__main__":
    unittest.main()
