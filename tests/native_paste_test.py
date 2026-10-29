"""Untypeable text goes through the shared clipboard, which is restored; never replacing non-text."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.native.host import UnsupportedText
from src.native.paste import paste_text


class Clipboard:
    """A fake wl-clipboard holding at most one value, with a log of every call."""
    def __init__(self, types, content=b""):
        self.types, self.content, self.calls = types, content, []

    def __call__(self, argv, environment, data=None):
        self.calls.append(argv[0].rsplit("/", 1)[1] + " " + " ".join(argv[1:]))
        if argv[1:] == ["--list-types"]:
            return SimpleNamespace(returncode=0 if self.types else 1, stdout="\n".join(self.types).encode())
        if argv[0].endswith("wl-paste"):
            return SimpleNamespace(returncode=0, stdout=self.content)
        if "--clear" in argv:
            self.types, self.content = [], b""
        else:
            self.types, self.content = ["text/plain;charset=utf-8"], data
        return SimpleNamespace(returncode=0, stdout=b"")


class PasteTests(unittest.TestCase):
    plan = {"runtime": "/run/user/1000", "display": "wayland-1"}

    def test_text_is_pasted_and_the_previous_clipboard_text_is_restored(self):
        clipboard, seen = Clipboard(["text/plain;charset=utf-8"], b"owner text"), []
        reply = paste_text(self.plan, "café €5 😀\nline", lambda: seen.append(clipboard.content), clipboard, lambda _: None)
        self.assertEqual(seen, ["café €5 😀\nline".encode()])
        self.assertEqual(clipboard.content, b"owner text")
        self.assertEqual(reply, "ok paste 14 characters")

    def test_empty_clipboard_is_cleared_again_afterwards(self):
        clipboard = Clipboard([])
        paste_text(self.plan, "€", lambda: None, clipboard, lambda _: None)
        self.assertEqual(clipboard.types, [])
        self.assertIn("wl-copy --clear", clipboard.calls[-1])

    def test_restore_happens_even_when_the_paste_key_fails(self):
        clipboard = Clipboard(["text/plain"], b"keep")
        def fail():
            raise RuntimeError("key refused")
        with self.assertRaises(RuntimeError):
            paste_text(self.plan, "€", fail, clipboard, lambda _: None)
        self.assertEqual(clipboard.content, b"keep")

    def test_non_text_clipboard_is_never_replaced(self):
        clipboard = Clipboard(["image/png"], b"\x89PNG")
        with self.assertRaises(UnsupportedText):
            paste_text(self.plan, "€", lambda: self.fail("must not paste"), clipboard, lambda _: None)
        self.assertFalse(any(call.startswith("wl-copy") for call in clipboard.calls))
        self.assertEqual(clipboard.content, b"\x89PNG")


if __name__ == "__main__":
    unittest.main()
