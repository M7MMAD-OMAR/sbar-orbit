"""Pure compositor reply fixtures. No native desktop, sockets, processes or plugin."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.session import SessionError
from src.native.workspace_inventory import workspace_inventory


class Transport:
    def __init__(self, clients=None, monitors=None):
        self.clients = [] if clients is None else clients
        self.monitors = [{"activeWorkspace": {"id": 1}}] if monitors is None else monitors
        self.raw = {}
        self.calls = []
        self.failure = None

    def _exchange(self, command):
        self.calls.append(command)
        if self.failure == command:
            raise RuntimeError("OWNED-PRIVATE-COMPOSITOR-ERROR")
        if command not in ("j/clients", "j/monitors"):
            raise AssertionError("No mutation or plugin query is allowed")
        if command in self.raw:
            return self.raw[command]
        return json.dumps(self.clients if command == "j/clients" else self.monitors)


def client(number, **extra):
    return {"workspace": {"id": number}, **extra}


def monitor(number, **extra):
    return {"activeWorkspace": {"id": number}, **extra}


class WorkspaceInventoryTests(unittest.TestCase):
    def fixed(self, transport):
        with self.assertRaises(SessionError) as caught:
            workspace_inventory(transport)
        self.assertEqual(str(caught.exception), "Workspace inventory is unavailable")
        self.assertNotIn("OWNED-PRIVATE", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_invisible_unmapped_and_other_owner_clients_all_count_as_occupied(self):
        transport = Transport([client(9, mapped=False, hidden=True, title="OWNED-PRIVATE-TITLE", pid=424242),
                               client(3, focusHistoryID=99), client(7, class_name="other-owner")], [monitor(2)])
        self.assertEqual(workspace_inventory(transport), {"occupied": [3, 7, 9], "shown": [2]})
        self.assertEqual(transport.calls, ["j/clients", "j/monitors"])

    def test_visible_empty_workspace_is_shown_but_not_fabricated_occupied(self):
        self.assertEqual(workspace_inventory(Transport([], [monitor(24)])), {"occupied": [], "shown": [24]})

    def test_duplicate_ids_are_sorted_and_collapsed_independently(self):
        self.assertEqual(workspace_inventory(Transport([client(4), client(2), client(4), client(1)],
                        [monitor(6), monitor(3), monitor(6)])), {"occupied": [1, 2, 4], "shown": [3, 6]})

    def test_zero_and_negative_special_workspaces_never_become_numbered_choices(self):
        self.assertEqual(workspace_inventory(Transport([client(0), client(-1), client(-99), client(5)])), {"occupied": [5], "shown": [1]})

    def test_explicit_special_workspace_object_without_numeric_id_is_not_numbered_occupancy(self):
        special = {"address": "special:special", "type": "special", "name": "special:special"}
        transport = Transport([{"workspace": special}, client(3), client(7)], [monitor(1)])
        self.assertEqual(workspace_inventory(transport), {"occupied": [3, 7], "shown": [1]})
        self.assertEqual(special, {"address": "special:special", "type": "special", "name": "special:special"})
        self.assertEqual(transport.calls, ["j/clients", "j/monitors"])

    def test_missing_numeric_id_requires_consistent_explicit_special_identity(self):
        malformed = (
            {"address": "special:special", "name": "special:special"},
            {"address": "special:special", "type": "regular", "name": "special:special"},
            {"address": "4", "type": "special", "name": "special:special"},
            {"address": "special:special", "type": "special", "name": "4"},
            {"address": "special:special", "type": "special"},
            {"type": "special", "name": "special:special"},
            {"address": "special:", "type": "special", "name": "special:"},
        )
        for workspace in malformed:
            with self.subTest(workspace=workspace):
                self.fixed(Transport([{"workspace": workspace}]))

    def test_special_workspace_marker_cannot_hide_a_positive_numbered_id(self):
        for number in (1, 4, 2147483647):
            with self.subTest(number=number):
                self.fixed(Transport([{"workspace": {"id": number,
                    "address": "special:special", "type": "special", "name": "special:special"}}]))

    def test_explicit_special_workspace_without_numeric_id_cannot_be_a_shown_numbered_workspace(self):
        special = {"address": "special:special", "type": "special", "name": "special:special"}
        self.fixed(Transport([], [{"activeWorkspace": special}]))

    def test_maximum_numbered_id_is_preserved_without_rounding(self):
        self.assertEqual(workspace_inventory(Transport([client(2147483647)], [monitor(2147483647)])),
                         {"occupied": [2147483647], "shown": [2147483647]})

    def test_clients_top_level_requires_list(self):
        for raw in ("null", "true", "0", "{}", '"OWNED-PRIVATE"'):
            transport = Transport(); transport.raw["j/clients"] = raw
            self.fixed(transport)

    def test_client_entries_require_dictionary(self):
        for value in (None, True, 1, "OWNED-PRIVATE", []):
            self.fixed(Transport([value]))

    def test_client_workspace_requires_dictionary_and_explicit_id(self):
        for value in ({}, {"workspace": None}, {"workspace": []}, {"workspace": 1}, {"workspace": {}}):
            self.fixed(Transport([value]))

    def test_client_workspace_id_rejects_bool_float_string_and_out_of_range_positive(self):
        for number in (True, False, None, 2.0, "2", 2147483648):
            self.fixed(Transport([client(number)]))

    def test_client_cap_is_enforced_before_shown_workspace_query(self):
        transport = Transport([client(1)] * 16385)
        self.fixed(transport)
        self.assertEqual(transport.calls, ["j/clients"])

    def test_exact_client_cap_is_supported(self):
        result = workspace_inventory(Transport([client(number) for number in range(1, 16385)]))
        self.assertEqual(result["occupied"], list(range(1, 16385)))

    def test_monitors_require_nonempty_list(self):
        for raw in ("[]", "null", "false", "{}", '"OWNED-PRIVATE"'):
            transport = Transport(); transport.raw["j/monitors"] = raw
            self.fixed(transport)

    def test_monitor_entries_require_dictionary(self):
        for value in (None, False, 1, "OWNED-PRIVATE", []):
            self.fixed(Transport([], [value]))

    def test_every_monitor_must_have_explicit_active_workspace_dictionary(self):
        for value in ({}, {"activeWorkspace": None}, {"activeWorkspace": []}, {"activeWorkspace": {}}):
            self.fixed(Transport([], [value]))

    def test_monitor_active_workspace_requires_known_positive_bounded_integer(self):
        for number in (True, False, None, 0, -1, 2.0, "2", 2147483648):
            self.fixed(Transport([], [monitor(number)]))

    def test_monitor_cap_is_exactly_sixty_four(self):
        self.assertEqual(workspace_inventory(Transport([], [monitor(number) for number in range(1, 65)]))["shown"], list(range(1, 65)))
        self.fixed(Transport([], [monitor(1)] * 65))

    def test_malformed_json_nonstandard_constants_and_duplicate_fields_fail_closed(self):
        for raw in ("[", "OWNED-PRIVATE", '[{"workspace":{"id":1,"id":2}}]', '[{"workspace":{"id":NaN}}]', '[{"workspace":{"id":Infinity}}]'):
            transport = Transport(); transport.raw["j/clients"] = raw
            self.fixed(transport)
        transport = Transport(); transport.raw["j/monitors"] = '[{"activeWorkspace":{"id":1},"activeWorkspace":{"id":2}}]'
        self.fixed(transport)

    def test_nonstring_transport_reply_is_unavailable_not_guessed(self):
        for value in (None, [], {}, b"[]"):
            transport = Transport(); transport.raw["j/clients"] = value
            self.fixed(transport)

    def test_transport_errors_are_redacted_for_either_read(self):
        for command in ("j/clients", "j/monitors"):
            transport = Transport(); transport.failure = command
            self.fixed(transport)

    def test_metadata_is_not_returned_and_input_is_not_mutated_or_cached(self):
        transport = Transport([client(2, title="OWNED-PRIVATE-TITLE", pid=424242, address="0xsecret")], [monitor(3, name="OWNED-PRIVATE-MONITOR")])
        original = copy.deepcopy((transport.clients, transport.monitors))
        first = workspace_inventory(transport)
        self.assertEqual(first, {"occupied": [2], "shown": [3]})
        self.assertNotIn("OWNED-PRIVATE", json.dumps(first)); self.assertNotIn("424242", json.dumps(first))
        first["occupied"].append(99)
        self.assertEqual(workspace_inventory(transport), {"occupied": [2], "shown": [3]})
        self.assertEqual((transport.clients, transport.monitors), original)
        self.assertEqual(transport.calls, ["j/clients", "j/monitors"] * 2)


if __name__ == "__main__":
    unittest.main()
