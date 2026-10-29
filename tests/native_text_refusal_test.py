"""Text the seat keymap cannot type is a definite refusal, never an uncertain failure."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.native.host import HostError, UnsupportedText
from src.native.keyboard import prepared_input


class TextRefusalTests(unittest.TestCase):
    target = "0x123@1@lease-" + "a" * 32

    def run_commit(self, command, payload, reply):
        requests = []

        def exchange(request, deadline):
            requests.append(request)
            verb, _, token, *_ = request.split()
            if verb == "ghost-keyboard-prepare":
                return json.dumps({"schema": 1, "status": "ready", "token": token, "serial": 9})
            if verb == "ghost-keyboard-cancel":
                return "ok"
            return reply

        import time
        return requests, lambda: prepared_input(f"{command} {self.target} {payload}", exchange, time.monotonic() + 1)

    def test_untypeable_character_raises_a_typed_refusal_without_a_resend(self):
        requests, run = self.run_commit("ghost-texthex", "c3a9", "no key for U+00E9 in the seat keymap")
        with self.assertRaises(UnsupportedText):
            run()
        commits = [r for r in requests if r.startswith("ghost-texthex-prepared ")]
        self.assertEqual(len(commits), 1)

    def test_refusal_is_a_host_error_and_names_no_typed_character(self):
        _, run = self.run_commit("ghost-type", "café €5", "no key for U+20AC in the seat keymap")
        with self.assertRaises(HostError) as caught:
            run()
        self.assertNotIn("20AC", str(caught.exception))
        self.assertNotIn("€", str(caught.exception))

    def test_typeable_text_and_keys_are_unchanged(self):
        _, run = self.run_commit("ghost-texthex", "6162", "ok 2 keys")
        self.assertEqual(run(), "ok 2 keys")
        _, run = self.run_commit("ghost-key", "End", "ok")
        self.assertEqual(run(), "ok")

    def test_other_refusals_are_left_to_the_generic_response_check(self):
        _, run = self.run_commit("ghost-texthex", "6162", "no seat keymap")
        self.assertEqual(run(), "no seat keymap")


if __name__ == "__main__":
    unittest.main()
