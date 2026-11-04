"""Untypeable text fails closed without accessing shared CLIPBOARD or PRIMARY."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.native.host import UnsupportedText
from src.native.paste import paste_text
from src.native.control import ActionControl
from src.native.session import NativeSession
from src.native.session_worker import failure_response


class Clipboard:
    """Owned wl-clipboard fixture; never connects to a display or a real selection."""
    def __init__(self, offer, primary=None, read_error=False):
        self.offer = dict(offer)
        self.primary = dict(primary or {})
        self.owner = object()
        self.calls = []
        self.read_error = read_error

    def __call__(self, argv, environment, data=None):
        self.calls.append((argv, data))
        if argv[0].endswith("wl-paste"):
            if self.read_error:
                raise TimeoutError("owned fixture read failed")
            if "--list-types" in argv:
                return SimpleNamespace(returncode=0 if self.offer else 1,
                                       stdout="\n".join(self.offer).encode())
            return SimpleNamespace(returncode=0, stdout=self.offer.get("text/plain", b""))
        if not argv[0].endswith("wl-copy"):
            raise AssertionError("Unexpected command in owned fixture")
        self.offer = {} if "--clear" in argv else {"text/plain": data}
        self.owner = object()
        return SimpleNamespace(returncode=0, stdout=b"")


class PasteTests(unittest.TestCase):
    plan = {"runtime": "/unused-owned-fixture", "display": "not-a-live-display"}

    def refuse(self, clipboard, text="café €5 😀\nline", plan=None):
        before = dict(clipboard.offer), dict(clipboard.primary), clipboard.owner
        press_paste = Mock(side_effect=AssertionError("must not send a paste key"))
        sleep = Mock(side_effect=AssertionError("must not wait for an unproven paste"))
        with self.assertRaisesRegex(UnsupportedText, "atomic clipboard ownership") as caught:
            paste_text(self.plan if plan is None else plan, text, press_paste, clipboard, sleep)
        self.assertEqual(clipboard.calls, [])
        self.assertEqual(clipboard.offer, before[0])
        self.assertEqual(clipboard.primary, before[1])
        self.assertIs(clipboard.owner, before[2])
        press_paste.assert_not_called()
        sleep.assert_not_called()
        return str(caught.exception)

    def test_text_and_primary_offers_are_preserved_without_loss_of_mime_types(self):
        # A text-only snapshot would lose the original HTML offer.
        self.refuse(Clipboard({"text/plain": b"owner text", "text/html": b"<b>owner text</b>"},
                              {"text/plain": b"owner highlight"}))

    def test_empty_and_non_text_selections_are_never_replaced_or_cleared(self):
        for offer in ({}, {"image/png": b"\x89PNG"}, {"application/octet-stream": b"\x00"}):
            with self.subTest(types=list(offer)):
                self.refuse(Clipboard(offer, {"text/plain": b"keep"}))

    def test_new_owner_copy_is_not_replaced_by_a_stale_snapshot(self):
        clipboard = Clipboard({"text/plain": b"old owner copy"})
        old_owner = clipboard.owner
        clipboard.offer = {"text/plain": b"new owner copy", "text/html": b"new"}
        clipboard.owner = object()
        self.refuse(clipboard)
        self.assertIsNot(clipboard.owner, old_owner)

    def test_same_bytes_do_not_prove_selection_ownership(self):
        clipboard = Clipboard({"text/plain": b"same bytes"})
        old_owner = clipboard.owner
        clipboard.owner = object()
        self.refuse(clipboard, text="same bytes")
        self.assertIsNot(clipboard.owner, old_owner)

    def test_default_arguments_do_not_launch_processes_or_wait(self):
        with patch("subprocess.run") as run, patch("time.sleep") as sleep:
            press_paste = Mock()
            with self.assertRaises(UnsupportedText):
                paste_text(self.plan, "€", press_paste)
            run.assert_not_called()
            sleep.assert_not_called()
            press_paste.assert_not_called()

    def test_observation_failure_cannot_be_mistaken_for_an_empty_selection(self):
        self.refuse(Clipboard({"text/plain": b"keep"}, read_error=True))

    def test_refusal_needs_no_environment_probe(self):
        message = self.refuse(Clipboard({}), plan={})
        self.assertIn("No paste key was sent", message)
        self.assertIn("selections were not changed", message)

    def test_refusal_does_not_expose_requested_text(self):
        secret = "owned-fixture-secret-€"
        self.assertNotIn(secret, self.refuse(Clipboard({}), text=secret))


class SessionPasteTests(unittest.TestCase):
    """Exercise the production execute branch with no display or input backend."""

    def session(self, directory, unsupported):
        session = NativeSession.__new__(NativeSession)
        session.closed = False
        session.plan = {}
        session.control = ActionControl(Path(directory) / "control")
        session.control.configure(mode="full")
        self.addCleanup(session.control.close)
        target = {"address": "0x1", "key": ("a" * 32, "stable"),
                  "size": (100, 80), "pointer": None}
        session._target = lambda app, window: target
        session._app = lambda app: SimpleNamespace(unit="owned-fixture")
        session._ensure_pointer = Mock()

        def perform(command):
            if unsupported:
                raise UnsupportedText("owned keymap refusal")
            return "ok 2 keys"

        session.transport = SimpleNamespace(_perform=Mock(side_effect=perform))
        return session, target

    def test_production_text_refusal_sends_no_paste_and_records_no_success(self):
        with tempfile.TemporaryDirectory(prefix="orbit-paste-session-") as directory:
            session, target = self.session(directory, unsupported=True)
            with patch("src.native.session.require_budget"):
                with self.assertRaises(UnsupportedText) as caught:
                    session.execute({"type": "text", "appId": "a" * 32,
                                     "windowId": "b" * 32, "text": "secret-€"})
            commands = session.transport._perform.call_args_list
            self.assertEqual(len(commands), 1)
            self.assertTrue(commands[0].args[0].startswith("ghost-texthex "))
            self.assertFalse(any("ctrl+v" in call.args[0] for call in commands))
            self.assertIsNone(target["pointer"])
            self.assertEqual(session.control.inspect()["events"][-1]["outcome"], "error")
            public = failure_response(caught.exception, NativeSession)
            self.assertEqual(public["error"]["code"], "TEXT_UNSUPPORTED")
            self.assertNotIn("secret", public["error"]["message"])
            self.assertIn("clipboard fallback is unavailable", public["error"]["message"])
            self.assertIn("No paste key was sent", public["error"]["message"])

    def test_public_refusal_never_serializes_private_exception_text(self):
        for session_type in (NativeSession, object):
            public = failure_response(UnsupportedText("secret-request-and-private-codepoint"), session_type)
            self.assertEqual(public["error"]["code"], "TEXT_UNSUPPORTED")
            self.assertNotIn("secret", str(public))
            self.assertIn("preserve shared selections", public["error"]["message"])

    def test_production_typeable_text_keeps_direct_route(self):
        with tempfile.TemporaryDirectory(prefix="orbit-paste-session-") as directory:
            session, _ = self.session(directory, unsupported=False)
            with patch("src.native.session.require_budget"), patch("src.native.session.paste_text") as fallback:
                result = session.execute({"type": "text", "appId": "a" * 32,
                                          "windowId": "b" * 32, "text": "ab"})
                fallback.assert_not_called()
            self.assertEqual(result, {"response": "ok 2 keys"})
            self.assertEqual(session.transport._perform.call_count, 1)
            self.assertEqual(session.control.inspect()["events"][-1]["outcome"], "success")


if __name__ == "__main__":
    unittest.main()
