"""Owned capture fixtures only. No desktop access, compositor activation or application input."""
from contextlib import ExitStack
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import a11y
from src.native import session as native
from src.native.session_worker import failure_response


class Clock:
    def __init__(self):
        self.now = 100.0
    def __call__(self):
        return self.now
    def advance(self, seconds):
        self.now += seconds
    def module(self):
        return SimpleNamespace(monotonic=self, sleep=self.advance, time=lambda: 1000.0)


class Stream:
    def __init__(self, descriptor):
        self.descriptor, self.closed = descriptor, False
    def fileno(self):
        return self.descriptor
    def close(self):
        self.closed = True


class Child:
    def __init__(self, clock, returncode=0, wait_cost=0, cleanup_failure=False):
        self.stdout, self.stderr = Stream(1), Stream(2)
        self.clock, self.returncode, self.wait_cost = clock, returncode, wait_cost
        self.cleanup_failure, self.waits, self.killed, self.finished = cleanup_failure, [], False, False
    def poll(self):
        return self.returncode if self.finished else None
    def kill(self):
        self.killed = True
    def wait(self, timeout=None):
        if timeout is None:
            raise AssertionError("Unbounded wait")
        self.waits.append(timeout)
        if self.cleanup_failure and (self.killed or self.finished):
            raise subprocess.TimeoutExpired("private fixture command", timeout)
        if not self.killed and not self.finished and self.wait_cost > timeout:
            self.clock.advance(timeout)
            raise subprocess.TimeoutExpired("private fixture command", timeout)
        if not self.killed and not self.finished:
            self.clock.advance(self.wait_cost)
        self.finished = True
        return self.returncode


class Selector:
    def __init__(self, clock, tick=0):
        self.clock, self.tick, self.keys, self.timeouts = clock, tick, {}, []
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass
    def register(self, stream, _events, data):
        self.keys[stream.fileno()] = SimpleNamespace(fileobj=stream, data=data)
    def unregister(self, stream):
        self.keys.pop(stream.fileno())
    def get_map(self):
        return self.keys
    def select(self, timeout):
        self.timeouts.append(timeout)
        self.clock.advance(min(self.tick, timeout))
        return [] if self.tick >= timeout else [(key, None) for key in tuple(self.keys.values())]


def png_header():
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 2, 1)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.log = Path(self.directory.name) / "capture.log"

    def capture(self, *, code=0, output=None, stderr=b"", tick=0, wait_cost=0,
                deadline=None, cleanup_failure=False):
        child = Child(self.clock, code, wait_cost, cleanup_failure)
        selector = Selector(self.clock, tick)
        chunks = {1: [png_header() if output is None else output, b""], 2: [stderr, b""]}
        def read(descriptor, _bound):
            return chunks[descriptor].pop(0)
        with ExitStack() as stack:
            stack.enter_context(patch.object(native, "time", self.clock.module()))
            spawn = stack.enter_context(patch.object(native.subprocess, "Popen", return_value=child))
            stack.enter_context(patch.object(native.selectors, "DefaultSelector", return_value=selector))
            stack.enter_context(patch.object(native.os, "read", side_effect=read))
            try:
                result = native.bounded_capture(["owned-fixture"], {}, self.log, deadline=deadline)
                return result, child, selector
            except BaseException as error:
                error.fixture_child, error.fixture_selector, error.fixture_spawn = child, selector, spawn.call_count
                raise

    def test_single_nonzero_capture_is_typed_not_group_and_private_stderr_preserved(self):
        with self.assertRaises(native.CaptureUnavailable) as caught:
            self.capture(code=9, output=b"", stderr=b"private application diagnostic")
        self.assertNotIsInstance(caught.exception, BaseExceptionGroup)
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(self.log.read_bytes(), b"private application diagnostic")
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(caught.exception.fixture_spawn, 1)

    def test_empty_stderr_does_not_invent_visibility_or_geometry_cause(self):
        with self.assertRaises(native.CaptureUnavailable) as caught:
            self.capture(code=1, output=b"")
        response = failure_response(caught.exception, object)
        self.assertEqual(response["error"]["code"], "CAPTURE_UNAVAILABLE")
        for text in ("workspace", "visibility", "geometry", "owner"):
            self.assertNotIn(text, response["error"]["message"])
        self.assertEqual(self.log.read_bytes(), b"")

    def test_valid_capture_retains_default_budget_and_bounded_cleanup_reserve(self):
        (data, width, height), child, selector = self.capture(tick=0.1)
        self.assertEqual((data, width, height), (png_header(), 2, 1))
        self.assertLess(selector.timeouts[-1], selector.timeouts[0])
        self.assertLessEqual(child.waits[0], 10)
        self.assertEqual(child.waits[-1], native.CAPTURE_CLEANUP_SECONDS)
        self.assertTrue(child.stdout.closed and child.stderr.closed)

    def test_expired_or_invalid_deadline_never_spawns(self):
        for deadline in (99, 100, float("nan"), float("inf"), True, "100"):
            with patch.object(native, "time", self.clock.module()), patch.object(native.subprocess, "Popen") as spawn:
                with self.assertRaises(native.CaptureDeadlineExceeded):
                    native.bounded_capture(["owned-fixture"], {}, self.log, deadline=deadline)
                spawn.assert_not_called()

    def test_io_timeout_and_wait_timeout_are_typed_and_child_is_reaped(self):
        for mode in ("io", "wait"):
            self.log = Path(self.directory.name) / (mode + ".log")
            self.clock.now = 100
            with self.assertRaises(native.CaptureDeadlineExceeded) as caught:
                self.capture(deadline=100.1, tick=1 if mode == "io" else 0, wait_cost=1 if mode == "wait" else 0)
            child = caught.exception.fixture_child
            self.assertTrue(child.killed)
            self.assertTrue(child.stdout.closed and child.stderr.closed)
            self.assertLessEqual(self.clock.now, 100.1 + 1e-9)
            self.assertEqual(child.waits[-1], 3)

    def test_spawn_cost_consumes_same_budget(self):
        child = Child(self.clock)
        def spawn(*_args, **_kwargs):
            self.clock.advance(0.2)
            return child
        with patch.object(native, "time", self.clock.module()), patch.object(native.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(native.CaptureDeadlineExceeded):
                native.bounded_capture(["owned-fixture"], {}, self.log, deadline=100.1)
        self.assertTrue(child.killed)
        self.assertEqual(child.waits, [3])

    def test_primary_plus_cleanup_error_stays_uncertain_group(self):
        with self.assertRaises(BaseExceptionGroup) as caught:
            self.capture(code=1, output=b"", cleanup_failure=True)
        self.assertIsInstance(caught.exception.exceptions[0], native.CaptureUnavailable)
        self.assertTrue(any(isinstance(error, subprocess.TimeoutExpired) for error in caught.exception.exceptions))
        self.assertEqual(failure_response(caught.exception, object)["error"]["code"], "NATIVE_FAILED")
        self.assertNotIn("private fixture command", failure_response(caught.exception, object)["error"]["message"])

    def test_invalid_image_is_capture_unavailable_not_invalid_request(self):
        with self.assertRaises(native.CaptureUnavailable) as caught:
            self.capture(output=b"not PNG")
        self.assertEqual(failure_response(caught.exception, object)["error"]["code"], "CAPTURE_UNAVAILABLE")

    def test_all_fixed_capture_types_map_without_arbitrary_exception_text(self):
        for kind, code in ((native.CaptureUnavailable, "CAPTURE_UNAVAILABLE"),
                           (native.CaptureDeadlineExceeded, "CAPTURE_DEADLINE_EXCEEDED"),
                           (native.CaptureGeometryChanged, "CAPTURE_GEOMETRY_CHANGED")):
            error = kind()
            error.args = ("private injected exception text",)
            response = failure_response(error, native.NativeSession)
            self.assertEqual(response["error"]["code"], code)
            self.assertNotIn("private", response["error"]["message"])


APP, WINDOW = "a" * 32, "b" * 32


class ObservationBudgetTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(native, "time", self.clock.module()))
        self.stack.enter_context(patch.object(native, "require_budget"))
        self.stack.enter_context(patch.object(native, "verify_host"))
        self.session = native.NativeSession.__new__(native.NativeSession)
        self.session.closed = False
        self.session.plan = {"runtime": "/owned-fixture", "display": "wayland-fixture"}
        self.session.control = SimpleNamespace(execute=lambda _request, operation: operation())
        self.target = {"address": "0x1", "key": (APP, "stable"), "size": (100, 80), "pointer": None}
        self.session._target = lambda *_: self.target
        self.session._app = lambda *_: SimpleNamespace(unit="fixture", profile=Path("/unused-fixture"))
        self.session._ensure_pointer = lambda *_: None
        self.session._check_target = lambda *_: None
        self.session._geometry = lambda *_: None
        self.session._owned_windows = lambda *_: [{"appId": APP, "windowId": WINDOW, "title": "fixture", "width": 100, "height": 80}]
        self.session._tree = lambda _target, deadline=None: {"status": "unavailable", "reason": "owned fixture"}
        self.calls = []

    def observe(self, **extra):
        return self.session.execute({"type": "observe", "appId": APP, "windowId": WINDOW, **extra})

    def capture(self, *_args, deadline=None):
        native.capture_remaining(deadline)
        self.calls.append(deadline)
        self.clock.advance(0.03)
        native.capture_remaining(deadline)
        return b"pixels", 100, 80

    def test_initial_frame_and_settle_share_one_deadline_no_failed_read_retry(self):
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(timeoutMs=100, quietMs=100, graceMs=100)
        self.assertGreater(len(self.calls), 1)
        self.assertTrue(all(deadline == 100.1 for deadline in self.calls))
        self.assertEqual(len(self.calls), 4)

    def test_initial_frame_cost_consumes_settle_budget_not_a_second_clock(self):
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        response = self.observe(timeoutMs=300, quietMs=20, graceMs=0)
        self.assertEqual(len(self.calls), 2)
        self.assertGreaterEqual(response["settle"]["waitedMs"], 59)
        self.assertTrue(response["settle"]["settled"])
        self.assertTrue(all(deadline == 100.3 for deadline in self.calls))

    def test_only_three_proven_size_change_resamples_then_typed_geometry_error(self):
        def changing(*args, deadline=None):
            result = self.capture(*args, deadline=deadline)
            self.target["size"] = (self.target["size"][0] + 1, 80)
            return result
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=changing))
        with self.assertRaises(native.CaptureGeometryChanged):
            self.observe()
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all(deadline == 110 for deadline in self.calls))

    def test_unchanged_outer_size_changed_crop_origin_is_not_applied_to_old_pixels(self):
        geometries = iter(((0, 0, 100, 80), (1, 0, 100, 80),
                           (1, 0, 100, 80), (2, 0, 100, 80),
                           (2, 0, 100, 80), (3, 0, 100, 80)))
        self.session._geometry = lambda *_: next(geometries)
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        crop = self.stack.enter_context(patch.object(native, "cropped_png"))
        visible_crop = self.stack.enter_context(patch.object(native, "visible_crop"))
        with self.assertRaises(native.CaptureGeometryChanged):
            self.observe()
        self.assertEqual(self.target["size"], (100, 80))
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all(deadline == 110 for deadline in self.calls))
        crop.assert_not_called()
        visible_crop.assert_not_called()

    def test_crop_geometry_availability_change_is_unavailable_not_a_proven_resize(self):
        for before, after in ((None, (0, 0, 100, 80)), ((0, 0, 100, 80), None)):
            self.calls.clear()
            geometries = iter((before, after))
            self.session._geometry = lambda *_: next(geometries)
            with patch.object(native, "bounded_capture", side_effect=self.capture), patch.object(native, "cropped_png") as crop:
                with self.assertRaises(native.CaptureUnavailable):
                    self.observe()
                self.assertEqual(len(self.calls), 1)
                crop.assert_not_called()

    def test_postcapture_geometry_query_obeys_same_remaining_deadline(self):
        queries = []
        def geometry(*_):
            queries.append(1)
            if len(queries) == 2:
                self.clock.advance(0.2)
            return (0, 0, 100, 80)
        self.session._geometry = geometry
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(timeoutMs=100)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(queries, [1, 1])

    def test_successful_tree_is_not_returned_with_changed_exact_target_size(self):
        for format in ("text", "both"):
            calls = []
            def target(*_):
                calls.append(1)
                return self.target if len(calls) == 1 else {**self.target, "size": (101, 80)}
            self.session._target = target
            self.session._tree = lambda _target, deadline=None: {"status": "ok", "nodes": [{"role": "frame"}], "complete": True}
            with patch.object(native, "bounded_capture", side_effect=self.capture) as capture, patch.object(self.session, "_owned_windows") as windows:
                with self.assertRaises(native.CaptureGeometryChanged):
                    self.observe(format=format)
                capture.assert_not_called()
                windows.assert_not_called()
            self.assertEqual(len(calls), 2)
            self.assertEqual(self.target["size"], (100, 80))

    def test_capture_unavailable_never_retries_or_resamples(self):
        capture = self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=native.CaptureUnavailable()))
        with self.assertRaises(native.CaptureUnavailable):
            self.observe(timeoutMs=1000)
        self.assertEqual(capture.call_count, 1)

    def test_slow_geometry_resampling_cannot_reset_deadline(self):
        def changing(*args, deadline=None):
            result = self.capture(*args, deadline=deadline)
            self.target["size"] = (self.target["size"][0] + 1, 80)
            return result
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=changing))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(timeoutMs=100)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(deadline == 100.1 for deadline in self.calls))

    def test_tree_budget_exhaustion_does_not_start_pixel_fallback(self):
        deadlines = []
        def tree(_target, deadline=None):
            deadlines.append(deadline)
            self.clock.advance(0.2)
            return {"status": "unavailable"}
        self.session._tree = tree
        capture = self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(format="both", timeoutMs=100)
        self.assertEqual(deadlines, [100.1])
        capture.assert_not_called()

    def test_production_discards_valid_last_settle_frame_when_absolute_budget_expired(self):
        settle = native.NativeSession._settle
        reports = []
        def expired_settle(capture, first, action, deadline=None, started=None):
            # The first frame was valid within budget. Legacy settle can still return it at expiry.
            self.clock.now = deadline
            result = settle(capture, first, action, deadline=deadline, started=started)
            reports.append(result[-1])
            return result
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        self.stack.enter_context(patch.object(self.session, "_settle", side_effect=expired_settle))
        windows = self.stack.enter_context(patch.object(self.session, "_owned_windows"))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe(timeoutMs=100, quietMs=100)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(reports[0]["captures"], 1)
        self.assertFalse(reports[0]["settled"])
        windows.assert_not_called()

    def test_unchanged_frame_grace_under_deadline_reports_changed_false_not_input_success(self):
        import hashlib
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        response = self.observe(timeoutMs=300, quietMs=20, graceMs=40,
                                since=hashlib.sha256(b"pixels").hexdigest())
        self.assertFalse(response["settle"]["changed"])
        self.assertTrue(response["settle"]["settled"])
        self.assertLess(self.clock.now, 100.3)

    def test_metadata_refresh_cannot_accept_frame_after_budget_expires(self):
        def windows(*_):
            self.clock.advance(20)
            return []
        self.session._owned_windows = windows
        self.stack.enter_context(patch.object(native, "bounded_capture", side_effect=self.capture))
        with self.assertRaises(native.CaptureDeadlineExceeded):
            self.observe()
        self.assertEqual(len(self.calls), 1)

    def test_direct_legacy_settle_signature_remains_available(self):
        def capture():
            self.clock.advance(0.01)
            return b"pixels", 1, 1, 0, (1, 1)
        action = native.NativeSession.parse({"type": "observe", "appId": APP, "windowId": WINDOW,
                                            "timeoutMs": 100, "quietMs": 20})
        *_, report = native.NativeSession._settle(capture, capture(), action)
        self.assertTrue(report["settled"])


class TreeBudgetTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()

    def test_cold_tree_timeout_and_provider_budget_clamp_to_remaining(self):
        reply = SimpleNamespace(returncode=0, stdout=b'{"status":"ok","nodes":[{"role":"frame"}]}')
        with patch.object(a11y, "time", self.clock.module()), patch.object(a11y.subprocess, "run", return_value=reply) as run:
            result = a11y.read_tree(42, "fixture", "/owned", deadline=100.25)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(run.call_args.kwargs["timeout"], 0.25)
        self.assertEqual(run.call_args.args[0][-1], "250")

    def test_warm_tree_passes_only_remaining_timeout_without_changing_wire(self):
        calls = []
        host = SimpleNamespace(observe=lambda *args, **kwargs: calls.append((args, kwargs)) or {"status": "ok", "nodes": [{"role": "frame"}]})
        with patch.object(a11y, "time", self.clock.module()):
            result = a11y.read_tree(42, "fixture", "/owned", host=host, deadline=100.25)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(calls, [((42, "fixture"), {"timeout_ms": 250})])

    def test_expired_tree_never_starts_cold_or_warm_query(self):
        host = SimpleNamespace(observe=lambda *_args, **_kwargs: self.fail("expired warm query"))
        with patch.object(a11y, "time", self.clock.module()), patch.object(a11y.subprocess, "run") as run:
            for deadline in (99, 100, float("nan"), "invalid"):
                self.assertEqual(a11y.read_tree(42, "fixture", "/owned", deadline=deadline)["status"], "unavailable")
                self.assertEqual(a11y.read_tree(42, "fixture", "/owned", host=host, deadline=deadline)["status"], "unavailable")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
