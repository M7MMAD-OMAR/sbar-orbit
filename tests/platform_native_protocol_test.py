import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.platform_protocol import PlatformError, PlatformSession, serve
from src.native.control import ActionControl

macos_source = Path(__file__).resolve().parents[1] / "src/native/platform_macos.py"
compile(macos_source.read_text(), str(macos_source), "exec")


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=")


class Handle:
    alive = True


class Provider:
    platform, toolkit = "owned-fixture", "fixture"

    def __init__(self):
        self.row = {"address": "0x123", "stableId": "a" * 32, "pid": 123, "title": "Owned fixture", "width": 320, "height": 240}
        self.handle = Handle()
        self.invocations, self.values, self.released, self.close_requests = 0, [], [], 0
        self.busy = self.fail_invoke = self.replaced_during_capture = False

    def ready(self): return True
    def indicator_ready(self): return True
    def window_lifetime_qualified(self): return True
    def candidates(self): return [dict(self.row)]
    def bind(self, row): return object()
    def current(self, binding): return dict(self.row)
    def release(self, binding): self.released.append(binding)
    def release_ref(self, handle): self.released.append(handle)
    def ref_current(self, binding, handle): return handle.alive and handle is self.handle
    def owner_input_recent(self): return self.busy
    def tree(self, binding, maximum, deadline): return [{"role": "button", "name": "Owned button", "box": [2, 2, 40, 20]}], [self.handle], None
    def capture(self, binding):
        if self.replaced_during_capture: self.row["width"] += 10
        return PNG
    def invoke(self, binding, handle):
        self.invocations += 1
        if self.fail_invoke: raise PlatformError("NATIVE_DELIVERY_UNCERTAIN")
    def set_value(self, binding, handle, text): self.values.append(text)
    def close_window(self, binding): self.close_requests += 1; return {"closeRequested": True}
    def open(self, registration, geometry): return {"opened": False, "openingStatus": "uncertain"}
    def monitors(self): return {"monitors": [], "presentation": "unsupported"}


class Controlled:
    before = None
    def execute(self, name, operation):
        if self.before: self.before()
        return operation()


class Tests(unittest.TestCase):
    def setUp(self):
        self.provider, self.control = Provider(), Controlled()
        self.now = 10.0
        self.session = PlatformSession(self.provider, self.control, clock=lambda: self.now)
        claim = self.session.request("claim", {"workspace": 1, "address": "0x123", "stableId": "a" * 32})
        self.target = {"appId": claim["appId"], "windowId": claim["selectedWindowId"]}

    def tearDown(self): self.session.close()

    def observation(self): return self.session.request("act", dict(self.target, type="observe", format="text", refs=True))
    def action(self, ref, **values): return dict(self.target, type="ref-click", ref=ref, **values)

    def assertCode(self, code, operation):
        with self.assertRaises(PlatformError) as caught: operation()
        self.assertEqual(code, caught.exception.code)

    def test_refs_retain_original_object_and_refuse_identical_replacement(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.provider.handle.alive = False
        self.provider.handle = Handle()
        self.assertCode("STALE_REF", lambda: self.session.request("act", self.action(ref)))
        self.assertEqual(0, self.provider.invocations)

    def test_foreign_target_and_generation_replacement_never_dispatch(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.assertCode("INVALID_REQUEST", lambda: self.session.request("act", dict(self.action(ref), appId="f" * 32)))
        self.provider.row["stableId"] = "b" * 32
        self.assertCode("TARGET_CLOSED", lambda: self.session.request("act", self.action(ref)))
        self.assertEqual(0, self.provider.invocations)

    def test_pause_expiry_and_late_revocation_do_not_invoke(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.now = 41
        self.assertCode("STALE_REF", lambda: self.session.request("act", self.action(ref)))
        self.now = 50
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        validate = self.provider.ref_current
        def expires_during_provider_io(*args):
            self.now = 81
            return validate(*args)
        self.provider.ref_current = expires_during_provider_io
        self.assertCode("STALE_REF", lambda: self.session.request("act", self.action(ref)))
        self.provider.ref_current = validate
        self.now = 90
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.control.before = lambda: setattr(self.session, "paused", True)
        self.assertCode("SESSION_PAUSED", lambda: self.session.request("act", self.action(ref)))
        self.assertEqual(0, self.provider.invocations)

    def test_explicit_value_replacement_is_not_generic_text_injection(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.session.request("act", dict(self.target, type="ref-set-value", ref=ref, text="owned replacement"))
        self.assertEqual(["owned replacement"], self.provider.values)
        for kind in ("text", "key", "click", "drag", "cursor"):
            self.assertCode("UNSUPPORTED", lambda: self.session.request("act", dict(self.target, type=kind)))

    def test_busy_owner_and_unknown_fields_refuse_without_effect(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.provider.busy = True
        self.assertCode("OWNER_BUSY", lambda: self.session.request("act", self.action(ref)))
        self.assertCode("INVALID_REQUEST", lambda: self.session.request("act", self.action(ref, unexpected=True)))
        self.assertEqual(0, self.provider.invocations)
        self.provider.indicator_ready = lambda: False
        self.assertCode("UNSUPPORTED", lambda: self.session.request("act", self.action(ref)))
        self.assertNotIn("ref-click", self.session.request("status", {})["capabilities"])

    def test_capture_geometry_race_refuses_old_frame(self):
        self.provider.replaced_during_capture = True
        self.assertCode("CAPTURE_GEOMETRY_CHANGED", lambda: self.session.request("act", dict(self.target, type="observe")))

    def test_text_geometry_race_refuses_mixed_observation(self):
        tree = self.provider.tree
        def moving(*args):
            result = tree(*args)
            self.provider.row["x"] = 100
            return result
        self.provider.tree = moving
        self.assertCode("CAPTURE_GEOMETRY_CHANGED", lambda: self.observation())

    def test_workspace_and_registration_validation_precedes_launch(self):
        self.assertCode("UNSUPPORTED", lambda: self.session.request("open", {"workspace": 2, "registration": {"applicationId": "x", "executable": "x"}}))
        self.assertCode("INVALID_REQUEST", lambda: self.session.request("open", {"workspace": 1, "registration": {"applicationId": "x", "executable": "x"}, "window": {"width": 1, "height": 640}}))

    def test_unqualified_provider_cannot_claim_or_launch_before_any_provider_operation(self):
        self.provider.window_lifetime_qualified = lambda: False
        self.provider.indicator_ready = lambda: False
        def unexpected(*args):
            self.fail("An unqualified request reached a native provider operation")
        self.provider.candidates = self.provider.open = unexpected
        self.assertCode("UNSUPPORTED", lambda: self.session.request("claim", {"workspace": 1, "address": "0x123", "stableId": "a" * 32}))
        self.assertCode("UNSUPPORTED", lambda: self.session.request("open", {"workspace": 1, "registration": {"applicationId": "x", "executable": "x"}}))

    def test_macos_retained_root_failure_refuses_reused_numeric_window_before_capture(self):
        from src.native.platform_macos import MacProvider
        provider = MacProvider.__new__(MacProvider)
        row = {"pid": 123, "birth": "owned", "nativeId": 42, "address": "0x2a", "stableId": "a" * 32}
        provider.birth = lambda pid: "owned"
        provider.candidates = lambda: [row]
        provider.ax_pid = lambda root, pid: -25202
        self.assertCode("TARGET_CLOSED", lambda: provider.current({"row": row, "root": object()}))
        self.assertCode("TARGET_CLOSED", lambda: provider.current({"row": row, "root": None}))
        def live_pid(root, pointer):
            pointer._obj.value = 123
            return 0
        provider.ax_pid = live_pid
        provider.scalar_attribute = lambda root, key: 42
        provider.candidates = lambda: [dict(row, x=100, y=200, width=640, height=480)]
        binding = {"row": row, "root": object()}
        self.assertEqual(100, provider.current(binding)["x"])
        self.assertEqual(200, binding["row"]["y"])

    def test_stop_returns_control_without_closing_owner_window(self):
        self.session.request("close-application", {"appId": self.target["appId"]})
        self.assertEqual(0, self.provider.close_requests)
        self.assertCode("SESSION_CLOSED", lambda: self.observation())

    def test_same_request_does_not_repeat_delivered_but_unacknowledged_effect(self):
        ref = self.observation()["tree"]["nodes"][0]["ref"]
        self.provider.fail_invoke = True
        request = {"requestId": "c" * 32, "method": "act", "params": self.action(ref)}
        changed = dict(request, params=dict(self.action(ref), button="right"))
        source = io.BytesIO((json.dumps(request) + "\n" + json.dumps(request) + "\n" + json.dumps(changed) + "\n").encode())
        output = io.StringIO()
        serve(self.session, source, output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(1, self.provider.invocations)
        self.assertEqual(["NATIVE_DELIVERY_UNCERTAIN", "NATIVE_DELIVERY_UNCERTAIN", "INVALID_REQUEST"], [reply["error"]["code"] for reply in replies])

    def test_real_owner_control_journals_digest_and_fixed_receipt_without_private_text(self):
        with tempfile.TemporaryDirectory(prefix="orbit-platform-control-") as directory:
            os.chmod(directory, 0o700)
            path = Path(directory)
            (path / "settings.json").write_text('{"mode":"full","approval":null}')
            (path / "settings.json").chmod(0o600)
            with ActionControl(directory) as control:
                self.session.control = control
                ref = self.observation()["tree"]["nodes"][0]["ref"]
                self.session.request("act", dict(self.target, type="ref-set-value", ref=ref, text="private field content"))
                self.provider.open = lambda registration, geometry: {"opened": False, "candidates": [{"title": "private owner title"}]}
                opened = self.session.request("open", {"workspace": 1, "registration": {"applicationId": "owned", "executable": "/owned/fixture"}})
                self.assertEqual("private owner title", opened["candidates"][0]["title"])
            journal = (path / "actions.jsonl").read_text()
            self.assertNotIn("private field content", journal)
            self.assertNotIn("private owner title", journal)
            self.assertIn("native-semantic", journal)
            self.assertEqual(["private field content"], self.provider.values)

    def test_oversized_frame_closes_helper_without_dispatch(self):
        output = io.StringIO()
        serve(self.session, io.BytesIO(b"x" * 65537 + b"\n"), output)
        self.assertEqual("", output.getvalue())
        self.assertEqual(0, self.provider.invocations)
        self.assertTrue(self.session.closed)


if __name__ == "__main__": unittest.main()
