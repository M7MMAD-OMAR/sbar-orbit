"""Pure retained-session/transport fixtures; never execute Lua or native input.

v0.57.1 upstream focus may change workspace and warp the cursor. These tests
reject EXTRA helper fallback/input commands, not that documented focus effect.
"""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.owner_reveal import reveal_window
from src.native.session import SessionError

APP, WINDOW = "a" * 32, "b" * 32
ADDRESS, STABLE, PID = "0x123abc", "f09", 123


class Transport:
    def __init__(self):
        self.commands = []
        self.clients = [{"address": ADDRESS, "stableId": STABLE, "pid": PID, "workspace": {"id": 7}}]
        self.active = {"address": ADDRESS, "stableId": STABLE, "pid": PID, "workspace": {"id": 7}}
        self.reply = "ok"
        self.error = None
        self.clients_raw = None
        self.active_raw = None

    def _exchange(self, command):
        self.commands.append(command)
        if command == "j/clients":
            return self.clients_raw if self.clients_raw is not None else json.dumps(self.clients)
        if command.startswith("eval "):
            if self.error is not None:
                raise self.error
            return self.reply
        if command == "j/activewindow":
            return self.active_raw if self.active_raw is not None else json.dumps(self.active)
        raise AssertionError("Unexpected fixture command")

    def _perform(self, *_args, **_kwargs):
        raise AssertionError("No input, generic dispatch or fallback may run")


class Session:
    def __init__(self):
        self.closed = False
        self.lease_id = "c" * 32
        self.transport = Transport()
        self.target = {"address": ADDRESS, "key": (APP, STABLE, "lease-" + self.lease_id),
                       "size": (100, 80), "pointer": {"x": 9, "y": 11}}
        self.calls = []
        self.target_error = None

    def _target(self, app_id, window_id, *, passive=False):
        self.calls.append((app_id, window_id, passive))
        if self.target_error:
            raise self.target_error
        if (app_id, window_id) != (APP, WINDOW):
            raise SessionError("Owned fixture handle is not retained")
        return copy.deepcopy(self.target)


class OwnerRevealTests(unittest.TestCase):
    def setUp(self):
        self.session = Session()
        self.value = {"appId": APP, "windowId": WINDOW}

    def reveal(self):
        return reveal_window(self.session, self.value)

    def no_focus(self):
        self.assertFalse(any(command.startswith("eval ") for command in self.session.transport.commands))

    def test_explicit_helper_uses_supported_guarded_focus_and_confirms_active_identity(self):
        before = copy.deepcopy(self.session.target)
        self.assertEqual(self.reveal(), {"revealed": True, "workspace": 7, "windowId": WINDOW})
        self.assertEqual(self.session.calls, [(APP, WINDOW, True)])
        self.assertEqual(self.session.target, before)
        commands = self.session.transport.commands
        self.assertEqual(len(commands), 3)
        self.assertEqual((commands[0], commands[-1]), ("j/clients", "j/activewindow"))
        lua = commands[1]
        selector = json.dumps("address:" + ADDRESS)
        self.assertTrue(lua.startswith("eval local w=hl.get_window(" + selector + ");"))
        self.assertIn("w and w.mapped", lua)
        self.assertIn("w.stable_id==" + json.dumps(STABLE), lua)  # Actual Lua property is hex string.
        self.assertIn("w.pid==" + str(PID), lua)
        self.assertIn("hl.dispatch(hl.dsp.focus({window=" + selector + "}))", lua)
        self.assertIn("r.ok==true", lua)
        self.assertLess(lua.index("assert(w"), lua.index("hl.dispatch"))
        for forbidden in ("ghost-", "focuswindow", "hl.dsp.window.focus", "hl.dsp.cursor", "warp", "moveworkspace", "exec_cmd"):
            self.assertNotIn(forbidden, " ".join(commands).lower())

    def test_owner_workspace_receipt_uses_current_inventory_without_extra_presentation(self):
        self.session.transport.clients[0]["workspace"]["id"] = 10
        self.session.transport.active["workspace"]["id"] = 10
        self.assertEqual(self.reveal()["workspace"], 10)
        self.assertEqual(len(self.session.transport.commands), 3)

    def test_closed_session_and_missing_lease_refuse_before_target_or_transport(self):
        for field, value in (("closed", True), ("lease_id", None)):
            with self.subTest(field=field):
                session = Session()
                setattr(session, field, value)
                with self.assertRaises(SessionError):
                    reveal_window(session, self.value)
                self.assertEqual(session.calls, [])
                self.assertEqual(session.transport.commands, [])

    def test_malformed_explicit_requests_do_not_query_or_dispatch(self):
        for value in (None, [], "window", {}, {"appId": APP}, {"windowId": WINDOW},
                      {"appId": True, "windowId": WINDOW}, {"appId": APP, "windowId": 1},
                      {**self.value, "workspace": 7}):
            with self.subTest(value=value):
                with self.assertRaises(SessionError):
                    reveal_window(self.session, value)
        self.assertEqual(self.session.calls, [])
        self.assertEqual(self.session.transport.commands, [])

    def test_unknown_or_stale_retained_handle_refuses_before_inventory(self):
        for value in ({"appId": "d" * 32, "windowId": WINDOW}, {"appId": APP, "windowId": "e" * 32}):
            with self.assertRaises(SessionError):
                reveal_window(self.session, value)
        self.session.target_error = SessionError("Owned target expired")
        with self.assertRaises(SessionError):
            self.reveal()
        self.assertEqual(self.session.transport.commands, [])
        self.assertTrue(all(call[2] is True for call in self.session.calls))

    def test_malformed_address_or_hex_stable_identity_refuses_before_inventory(self):
        for address in ("0x", "0xZZ", "0x1;danger", "../window", "0x" + "a" * 17, False):
            with self.subTest(address=address):
                self.session.target["address"] = address
                with self.assertRaises(SessionError):
                    self.reveal()
        self.session.target["address"] = ADDRESS
        for stable in ("", "0xf09", "F09", "a" * 17, True, 123):
            with self.subTest(stable=stable):
                self.session.target["key"] = (APP, stable, "lease-fixture")
                with self.assertRaises(SessionError):
                    self.reveal()
        self.assertEqual(self.session.transport.commands, [])

    def test_missing_duplicate_or_replaced_inventory_identity_never_focuses(self):
        entry = copy.deepcopy(self.session.transport.clients[0])
        for clients in ([], [entry, entry], [{**entry, "address": "0x123abd"}], [{**entry, "stableId": "f0a"}], [None]):
            with self.subTest(clients=clients):
                self.session.transport.clients = clients
                with self.assertRaises(SessionError):
                    self.reveal()
        self.no_focus()

    def test_malformed_inventory_shape_or_excessive_count_refuses(self):
        for clients in (None, {}, "inventory", [None] * 4097):
            with self.subTest(kind=type(clients).__name__):
                self.session.transport.clients = clients
                with self.assertRaises(SessionError):
                    self.reveal()
        self.no_focus()

    def test_unusable_pid_or_numbered_workspace_refuses_before_focus(self):
        entry = self.session.transport.clients[0]
        for pid in (None, False, 0, -1, 1.5, "123"):
            with self.subTest(pid=pid):
                entry["pid"] = pid
                with self.assertRaises(SessionError):
                    self.reveal()
        entry["pid"] = PID
        for workspace in (None, {}, {"id": None}, {"id": True}, {"id": 0}, {"id": -99}, {"id": "7"}, {"id": 2147483648}):
            with self.subTest(workspace=workspace):
                entry["workspace"] = workspace
                with self.assertRaises(SessionError):
                    self.reveal()
        self.no_focus()

    def test_compositor_guard_or_focus_refusal_never_retries_or_reads_active(self):
        for reply in ("", "refused: target changed", "unsupported focus", '{"ok":false}'):
            with self.subTest(reply=reply):
                session = Session()
                session.transport.reply = reply
                with self.assertRaises(SessionError):
                    reveal_window(session, self.value)
                self.assertEqual(len(session.transport.commands), 2)
                self.assertEqual(session.transport.commands[0], "j/clients")
                self.assertTrue(session.transport.commands[1].startswith("eval "))
        session = Session()
        session.transport.error = SessionError("Owned compositor failure")
        with self.assertRaises(SessionError):
            reveal_window(session, self.value)
        self.assertEqual(len(session.transport.commands), 2)

    def test_active_window_ack_mismatch_refuses_without_any_fallback(self):
        original = copy.deepcopy(self.session.transport.active)
        for active in (None, [], {}, {**original, "address": "0x123abd"}, {**original, "stableId": "f0a"}, {**original, "pid": PID + 1}):
            with self.subTest(active=active):
                session = Session()
                session.transport.active = active
                with self.assertRaises(SessionError):
                    reveal_window(session, self.value)
                self.assertEqual(len(session.transport.commands), 3)
                self.assertEqual(sum(command.startswith("eval ") for command in session.transport.commands), 1)

    def test_raw_invalid_inventory_or_active_json_never_produces_success(self):
        self.session.transport.clients_raw = "not-json"
        with self.assertRaises(ValueError):
            self.reveal()
        self.no_focus()
        session = Session()
        session.transport.active_raw = "not-json"
        with self.assertRaises(ValueError):
            reveal_window(session, self.value)
        self.assertEqual(len(session.transport.commands), 3)


    def test_receipt_uses_verified_current_workspace_not_pre_focus_cache(self):
        session = Session()
        session.transport.active["workspace"] = {"id": 9}
        self.assertEqual(reveal_window(session, {"appId": APP, "windowId": WINDOW})["workspace"], 9)
        session.transport.active["workspace"] = {"id": True}
        with self.assertRaises(SessionError):
            reveal_window(session, {"appId": APP, "windowId": WINDOW})


if __name__ == "__main__":
    unittest.main()
