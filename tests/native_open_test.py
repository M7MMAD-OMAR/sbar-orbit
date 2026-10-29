"""Real-profile launch admission, argument separation and window attribution."""
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.window_placement import place_new_window
from src.native.owner_open import open_application, validate_open
from src.native.control import ActionControl, ControlError
from src.native.lease import process_identity
from src.native.session import SessionError, OpeningDeliveryUncertain
from src.native.owner_open_helper import main as helper_main
from src.native.launch_identity import registered_client, OriginalLaunchScope, RegisteredClient


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.directory.chmod(0o700)
        self.control = ActionControl(self.directory / "control")
        self.addCleanup(self.control.close)
        self.commands = []
        self.launched = False
        self.activation = False
        self.cursor = [100, 100]
        self.pid = os.getpid()
        self.workspace = 4
        self.layout = [960, 640]
        self.floating = True
        self.xwayland = False
        self.session = SimpleNamespace(directory=self.directory, control=self.control,
                                       transport=SimpleNamespace(_exchange=self.exchange))

    def exchange(self, command):
        self.commands.append(command)
        if command.startswith("ghost-opening "):
            _, operation, token = command.split()
            return json.dumps({"schema": 1, "token": token, "ambiguous": False,
                "windows": [{"address": "0xabc", "stableId": "123"}] if self.activation and self.launched else []}) if operation == "info" else "ok"
        if command == "j/clients":
            return json.dumps([{"address": "0xabc", "stableId": "123", "pid": self.pid,
                                "workspace": {"id": self.workspace}, "xwayland": self.xwayland,
                                "floating": self.floating, "size": self.layout, "at": [(1920 - self.layout[0]) / 2, (1080 - self.layout[1]) / 2]}] if self.launched else [])
        if command == "j/activewindow":
            return "{}"
        if command == "j/cursorpos":
            return json.dumps({"x": self.cursor[0], "y": self.cursor[1]})
        if command == "j/workspaces":
            return json.dumps([{"id": 4, "monitor": "test-monitor"}])
        if command == "j/monitors":
            return json.dumps([{"name": "test-monitor", "x": 0, "y": 0, "width": 1920, "height": 1080,
                                "scale": 1, "focused": True, "activeWorkspace": {"id":4}, "reserved": [0, 0, 0, 0]}])
        if command.startswith("eval local w="):
            self.workspace = 4
            return "ok"
        match = re.match(r'eval hl.exec_cmd\(("(?:[^"\\]|\\.)*"), ', command)
        if not match:
            raise AssertionError("Expected the native Lua launch command")
        launch = json.loads(match[1])
        spec = json.loads(Path(shlex.split(launch)[-1]).read_text())
        self.arguments = spec["argv"]
        Path(spec["receipt"]).write_text(json.dumps(process_identity(os.getpid())))
        self.launched = True
        return "ok"

    def test_protected_denial_precedes_dispatch(self):
        with self.assertRaises(ControlError):
            open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertEqual(self.commands, [])

    def test_literal_arguments_and_launch_bound_identity(self):
        self.control.configure(mode="full")
        arg = 'literal $(touch /tmp/unwanted) ; "quoted"'
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true", arg]})
        self.assertEqual(self.arguments, ["/usr/bin/true", arg])
        launch = next(command for command in self.commands if command.startswith("eval hl.exec_cmd"))
        self.assertNotIn(arg, launch)
        self.assertIn('workspace="4 silent", no_initial_focus=true, focus_on_activate=false', launch)
        self.assertEqual(result["address"], "0xabc")
        self.assertEqual(result["applicationLifetime"], "owner")
        self.assertIn("explicit native handoff", result["handoff"])

    def test_default_open_is_floating_and_verified(self):
        self.control.configure(mode="full")
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["window"]["floating"])
        self.assertEqual(result["window"]["width"], 960)
        launch = next(command for command in self.commands if command.startswith("eval hl.exec_cmd"))
        self.assertIn("float=true", launch)
        self.assertIn('size="960 640"', launch)
        self.assertIn("center=true", launch)

    def test_custom_size_is_passed_and_measured(self):
        self.control.configure(mode="full")
        self.layout = [800, 600]
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"],
                                                "window": {"width": 800, "height": 600}})
        self.assertEqual((result["window"]["width"], result["window"]["height"]), (800, 600))

    def test_application_adjusted_size_returns_actual_geometry_and_original_request(self):
        self.control.configure(mode="full")
        self.layout = [720, 616]
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 61]), patch("src.native.owner_open.time.sleep"):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"],
                                                    "window": {"width": 720, "height": 600}})
        self.assertEqual(result["window"]["height"], 616)
        self.assertEqual(result["requestedWindow"]["height"], 600)
        self.assertEqual(result["windowAdjustment"]["reason"], "observed-size-difference")

    def test_new_window_from_verified_registered_dbus_client_is_acknowledged(self):
        self.control.configure(mode="full")
        self.workspace = 3
        registered = SimpleNamespace(process=(os.getpid(), process_identity(os.getpid())[1]), verify=lambda: True)
        with patch("src.native.owner_open.registered_client", return_value=registered, create=True), \
                patch("src.native.owner_open.belongs_to", side_effect=lambda pid, root: root == registered.process):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"], "busName": "org.example.Editor"})
        self.assertEqual(result["identityEvidence"], "registered-dbus-client")
        self.assertFalse(result["opened"])
        self.assertEqual(result["candidate"]["workspace"], 3)
        self.assertEqual(result["candidate"]["address"], "0xabc")
        self.assertFalse(any(command.startswith("eval local w=") for command in self.commands))

    def test_dbus_activated_service_created_after_launch_is_attributed(self):
        self.control.configure(mode="full")
        self.workspace = 3
        registered = SimpleNamespace(process=(os.getpid(), process_identity(os.getpid())[1]), verify=lambda: True)
        with patch("src.native.owner_open.registered_client", side_effect=[None, registered]), \
                patch("src.native.owner_open.belongs_to", side_effect=lambda pid, root: root == registered.process):
            result = open_application(self.session, {"workspace":4,"argv":["/usr/bin/true"],"busName":"org.example.Editor"})
        self.assertEqual(result["identityEvidence"],"registered-dbus-client")
        self.assertFalse(result["opened"])
        self.assertEqual(result["candidate"]["workspace"],3)

    def test_forwarded_window_requires_the_exact_activation_request_before_placement(self):
        self.control.configure(mode="full")
        self.workspace = 3
        self.activation = True
        registered = SimpleNamespace(process=(os.getpid(), process_identity(os.getpid())[1]), verify=lambda: True)
        with patch("src.native.owner_open.registered_client", return_value=registered), \
                patch("src.native.owner_open.belongs_to", side_effect=lambda pid, root: root == registered.process):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"], "busName": "org.example.Editor"})
        self.assertTrue(result["opened"])
        self.assertEqual(result["identityEvidence"], "activation-token")
        self.assertEqual(result["workspace"], 4)

    def test_activation_of_preexisting_window_returns_unmodified_existing_candidate(self):
        self.control.configure(mode="full")
        self.activation = True
        original = self.exchange
        window = {"address": "0xabc", "stableId": "123", "pid": os.getpid(), "workspace": {"id": 3}}
        self.session.transport._exchange = lambda command: json.dumps([window]) if command == "j/clients" else original(command)
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 61]), patch("src.native.owner_open.time.sleep"):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertFalse(result["opened"])
        self.assertTrue(result["reusedExisting"])
        self.assertEqual(result["identityEvidence"], "activation-token")
        self.assertFalse(result["placementChanged"])
        self.assertEqual(result["candidate"]["workspace"], 3)
        self.assertFalse(any(command.startswith("eval local w=") for command in self.commands))

    def test_activation_snapshot_timeout_retries_only_the_read_without_relaunch(self):
        self.control.configure(mode="full")
        original = self.exchange
        queries = 0
        def exchange(command):
            nonlocal queries
            if command.startswith("ghost-opening info "):
                queries += 1
                if queries == 1: raise TimeoutError("busy compositor snapshot")
            return original(command)
        self.session.transport._exchange = exchange
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["opened"])
        self.assertEqual(sum(command.startswith("eval hl.exec_cmd") for command in self.commands), 1)
        self.assertEqual(queries, 2)

    def test_every_post_launch_read_timeout_reports_uncertain_delivery_without_relaunch(self):
        self.control.configure(mode="full")
        for failing in ["j/activewindow", "j/clients", "j/workspaces", "j/monitors"]:
            with self.subTest(command=failing):
                self.launched=False
                self.commands.clear()
                original=self.exchange
                def exchange(command):
                    if self.launched and command==failing: raise TimeoutError("busy compositor")
                    return original(command)
                self.session.transport._exchange=exchange
                with self.assertRaisesRegex(SessionError, "Opening delivery is uncertain"):
                    open_application(self.session,{"workspace":4,"argv":["/usr/bin/true"]})
                self.assertEqual(sum(c.startswith("eval hl.exec_cmd")for c in self.commands),1)

    def test_reused_compositor_address_with_new_stable_id_is_a_new_window(self):
        self.control.configure(mode="full")
        original=self.session.transport._exchange
        def exchange(command):
            if command=="j/clients" and not self.launched:
                return json.dumps([{"address":"0xabc","stableId":"456","pid":1}])
            return original(command)
        self.session.transport._exchange=exchange
        with patch("src.native.owner_open.time.monotonic",side_effect=[0,1,31]),patch("src.native.owner_open.time.sleep"):
            result=open_application(self.session,{"workspace":4,"argv":["/usr/bin/true"]})
        self.assertEqual(result["stableId"],"123")

    def test_forwarded_window_uses_only_silent_placement_under_unrelated_owner_focus(self):
        self.control.configure(mode="full")
        self.workspace=3
        owner={"address":"0xdef","stableId":"456","pid":1,"workspace":{"id":4}}
        original=self.session.transport._exchange
        def exchange(command):
            if command=="j/activewindow": return json.dumps(owner)
            if command=="j/clients": return json.dumps([owner,*json.loads(original(command))])
            return original(command)
        self.session.transport._exchange=exchange
        with patch("src.native.owner_open.registered_client", return_value=None), \
                patch("src.native.owner_open.belongs_to", return_value=False), \
                patch("src.native.owner_open.OriginalLaunchScope.contains", side_effect=lambda pid: pid == os.getpid()):
            open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        placed=next(command for command in self.commands if command.startswith("eval local w="))
        self.assertIn("Opening target is receiving owner input", placed)
        self.assertNotIn("hl.dsp.focus", placed)
        self.assertNotIn("cursor.move", placed)

    def test_new_active_launch_bound_candidate_is_returned_without_placement(self):
        # The owner moved the pointer after the request: the focus is real owner input, so no placement.
        self.control.configure(mode="full")
        original = self.exchange
        def exchange(command):
            if command == "j/activewindow" and self.launched:
                self.cursor = [400, 300]
                return json.dumps(json.loads(original("j/clients"))[0])
            return original(command)
        self.session.transport._exchange = exchange
        for proof in ("launch-ancestry", "activation-token", "launch-scope"):
            with self.subTest(proof=proof):
                self.launched = False
                self.cursor = [100, 100]
                self.commands.clear()
                self.activation = proof == "activation-token"
                with patch("src.native.owner_open.belongs_to", return_value=proof == "launch-ancestry"), \
                        patch("src.native.owner_open.OriginalLaunchScope.contains", return_value=proof == "launch-scope"):
                    result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
                self.assertFalse(result["opened"])
                self.assertEqual(result["attribution"], "candidate-only")
                self.assertFalse(result["placementChanged"])
                self.assertEqual(result["identityEvidence"], proof)
                self.assertEqual(result["candidateReason"], "owner-input")
                self.assertFalse(any(command.startswith("eval local w=") for command in self.commands))

    def test_unreadable_pointer_keeps_the_conservative_owner_input_default(self):
        self.control.configure(mode="full")
        original = self.exchange
        def exchange(command):
            if command == "j/cursorpos":
                raise TimeoutError("busy compositor")
            if command == "j/activewindow" and self.launched:
                return json.dumps(json.loads(original("j/clients"))[0])
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.belongs_to", return_value=False), \
                patch("src.native.owner_open.OriginalLaunchScope.contains", return_value=True):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertEqual(result["candidateReason"], "owner-input")
        self.assertFalse(any(command.startswith("eval local w=") for command in self.commands))

    def test_forwarded_window_focused_by_mapping_alone_is_placed(self):
        # Focus with no owner pointer movement since the request is map time focus, as a
        # forwarded single instance browser window takes it. The window is still placed.
        self.control.configure(mode="full")
        self.workspace = 3
        original = self.exchange
        def exchange(command):
            if command == "j/activewindow" and self.launched:
                return json.dumps(json.loads(original("j/clients"))[0])
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.belongs_to", return_value=False), \
                patch("src.native.owner_open.OriginalLaunchScope.contains", return_value=True), \
                patch("src.native.owner_open.time.sleep"):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        placed = [command for command in self.commands if command.startswith("eval local w=")]
        self.assertEqual(len(placed), 1)
        self.assertNotIn("Opening target is receiving owner input", placed[0])
        self.assertIn("stable_id==", placed[0])
        self.assertTrue(result["opened"])

    def test_pointer_movement_after_map_focus_placement_is_uncertain(self):
        self.control.configure(mode="full")
        self.workspace = 3
        original = self.exchange
        placed = False
        def exchange(command):
            nonlocal placed
            if command.startswith("eval local w="):
                placed = True
            if placed and command == "j/cursorpos":
                return json.dumps({"x": 900, "y": 500})
            if command == "j/activewindow" and self.launched:
                return json.dumps(json.loads(original("j/clients"))[0])
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.belongs_to", return_value=False), \
                patch("src.native.owner_open.OriginalLaunchScope.contains", return_value=True), \
                patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(OpeningDeliveryUncertain, "placement"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})

    def test_owner_focus_after_post_map_placement_is_uncertain_not_unmodified(self):
        self.control.configure(mode="full")
        self.workspace = 3
        original = self.exchange
        placed = False
        def exchange(command):
            nonlocal placed
            if command.startswith("eval local w="):
                placed = True
            if command == "j/activewindow" and placed:
                return json.dumps(json.loads(original("j/clients"))[0])
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.belongs_to", return_value=False), \
                patch("src.native.owner_open.OriginalLaunchScope.contains", return_value=True), \
                patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(OpeningDeliveryUncertain, "placement"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertEqual(sum(command.startswith("eval local w=") for command in self.commands), 1)


    def test_cold_toolkit_startup_after_twelve_seconds_is_still_observed(self):
        self.control.configure(mode="full")
        original = self.exchange
        polls = 0
        def exchange(command):
            nonlocal polls
            if command == "j/clients":
                polls += 1
                if polls <= 2:
                    return "[]"
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 13, 61]), patch("src.native.owner_open.time.sleep"):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["opened"])

    def test_cold_startup_beyond_thirty_seconds_is_confirmed_without_relaunch(self):
        self.control.configure(mode="full")
        original = self.exchange
        for delay in (33, 59):
            with self.subTest(delay=delay):
                self.launched = False
                self.commands.clear()
                polls = 0
                def exchange(command):
                    nonlocal polls
                    if command == "j/clients":
                        polls += 1
                        if polls <= 2:
                            return "[]"
                    return original(command)
                self.session.transport._exchange = exchange
                with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, delay, 61]), patch("src.native.owner_open.time.sleep"):
                    result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
                self.assertTrue(result["opened"])
                self.assertEqual(result["identityEvidence"], "launch-ancestry")
                self.assertEqual(sum(c.startswith("eval hl.exec_cmd") for c in self.commands), 1)

    def test_new_workspace_uses_its_actual_monitor_after_mapping(self):
        self.control.configure(mode="full")
        original = self.exchange
        def exchange(command):
            if command == "j/workspaces" and not self.launched:
                return "[]"
            if command == "j/monitors":
                return json.dumps([
                    {"name": "other", "x": 2000, "y": 0, "width": 1280, "height": 800, "scale": 1, "focused": True},
                    {"name": "test-monitor", "x": 0, "y": 0, "width": 1920, "height": 1080, "scale": 1, "focused": False}])
            return original(command)
        self.session.transport._exchange = exchange
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 61]), patch("src.native.owner_open.time.sleep"):
            result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertEqual(result["window"]["x"], 480)

    def test_tiled_acknowledgement_is_not_placement_success(self):
        self.control.configure(mode="full")
        self.floating = False
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 61]), patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(SessionError, "uncertain"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})

    def test_xwayland_original_opening_does_not_require_wayland_input_handoff(self):
        self.control.configure(mode="full")
        self.xwayland = True
        result = open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertTrue(result["opened"])
        self.assertEqual(result["windowProtocol"], "xwayland")
        self.assertIn("explicit native handoff", result["handoff"])

    def test_wrong_workspace_refuses_identity(self):
        self.control.configure(mode="full")
        self.workspace = 5
        with self.assertRaisesRegex(OpeningDeliveryUncertain, "uncertain") as raised:
            open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})
        self.assertIsInstance(raised.exception.__cause__, SessionError)
        self.assertIn("requested workspace", str(raised.exception.__cause__))
        self.assertTrue(self.launched)

    def test_unrelated_new_window_is_never_guessed(self):
        self.control.configure(mode="full")
        self.pid = 1
        with patch("src.native.owner_open.time.monotonic", side_effect=[0, 1, 61]), patch("src.native.owner_open.time.sleep"):
            with self.assertRaisesRegex(SessionError, "uncertain"):
                open_application(self.session, {"workspace": 4, "argv": ["/usr/bin/true"]})



    def test_relative_executable_is_resolved_before_approval(self):
        with patch("src.native.owner_open.shutil.which", return_value="./owner-app"):
            value = validate_open({"workspace": 4, "argv": ["./owner-app"]})
        self.assertEqual(value["argv"][0], str(Path("./owner-app").absolute()))



    def test_launch_receipt_is_complete_when_published(self):
        import time
        receipt = self.directory / "opened.json"
        specification = self.directory / "specification.json"
        specification.write_text(json.dumps({"argv": ["/usr/bin/true"], "receipt": str(receipt), "expires": time.time() + 10}))
        specification.chmod(0o600)
        link = os.link
        def publish(source, destination):
            self.assertFalse(receipt.exists())
            self.assertEqual(json.loads(Path(source).read_text()), list(process_identity(os.getpid())))
            link(source, destination)
        with patch("src.native.owner_open_helper.os.link", side_effect=publish), patch("src.native.owner_open_helper.os.execv") as execute:
            helper_main(str(specification))
        execute.assert_called_once_with("/usr/bin/true", ["/usr/bin/true"])
        self.assertEqual(json.loads(receipt.read_text()), list(process_identity(os.getpid())))
        self.assertFalse(receipt.with_name(receipt.name + ".writing").exists())

    def test_invalid_arguments_do_not_dispatch(self):
        for value in [{"workspace": True, "argv": ["true"]}, {"workspace": 4, "argv": ["true\nfalse"]},
                      {"workspace": 4, "argv": ["true"], "mode": "full"}]:
            with self.assertRaises(SessionError):
                validate_open(value)


class LaunchIdentityTests(unittest.TestCase):
    def test_registered_client_uses_bus_credentials_and_rejects_owner_change(self):
        with patch("src.native.launch_identity.bus_owner", side_effect=[":1.7", ":1.7", ":1.8"]), \
                patch("src.native.launch_identity.bus_number", side_effect=[os.getuid(), os.getpid()]):
            client = registered_client("org.example.Editor")
            self.assertIsNotNone(client)
            self.assertFalse(client.verify())

    def test_foreign_uid_bus_owner_is_not_a_launch_identity(self):
        with patch("src.native.launch_identity.bus_owner", return_value=":1.7"), \
                patch("src.native.launch_identity.bus_number", return_value=os.getuid()+1):
            self.assertIsNone(registered_client("org.example.Editor"))

    def test_scope_binding_rejects_changed_invocation_and_foreign_group(self):
        scope = OriginalLaunchScope("orbit-open-" + "a"*32 + ".scope")
        properties = {"ActiveState":"active", "InvocationID":"b"*32,
            "ControlGroup":f"/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice/{scope.unit}"}
        with patch("src.native.launch_identity.systemctl_properties", return_value=properties), \
                patch("src.native.launch_identity.manager_environment", return_value={}), \
                patch("src.native.launch_identity.cgroup_directory", return_value=(Path("/fixture"),(1,2))):
            scope.properties()
            properties["InvocationID"]="c"*32
            with self.assertRaisesRegex(ValueError, "replaced"): scope.properties()
            properties["ControlGroup"]="/system.slice/"+scope.unit
            with self.assertRaisesRegex(ValueError, "current owned invocation"): scope.properties()

    def test_generated_scope_retains_literal_original_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); spec=root/"open.json"; receipt=root/"receipt.json"
            import time
            unit="orbit-open-"+"a"*32+".scope"
            argv=["/usr/bin/true", "$literal", "$(false)"]
            spec.write_text(json.dumps({"argv":argv,"receipt":str(receipt),"expires":time.time()+10,"scope":unit})); spec.chmod(0o600)
            with patch("src.native.owner_open_helper.os.execv") as execute: helper_main(str(spec))
            actual=execute.call_args.args[1]
            self.assertIn("--expand-environment=no",actual)
            self.assertEqual(actual[actual.index("--")+1:],argv)
            self.assertIn("--unit="+unit,actual)


class LuaPlacementTests(unittest.TestCase):
    def test_actual_placement_lua_preserves_focus_pointer_and_guards_exact_identity(self):
        window = {"address": "0xabc", "stableId": "123", "pid": 42}
        owner = {"address": "0xdef", "stableId": "456", "pid": 43}
        for busy, matching in [(True, True), (False, True), (False, False)]:
            with self.subTest(busy=busy, matching=matching):
                observed = {}
                def exchange(command):
                    script = command.removeprefix("eval ")
                    fixture = """
local w={address='0xabc',stable_id=ID,pid=42,mapped=true}
local o={address='0xdef',stable_id=1110,pid=43,mapped=true}
local active=BUSY and w or o
local initial=active
local pointer={x=211,y=337}
local calls,focusCalls,warps=0,0,0
local function operation(name) return function(args) return {name=name,args=args} end end
hl={dsp={window={}},get_window=function(s) return s=='address:0xabc' and w or o end,
get_active_window=function() return active end,get_cursor_pos=function() return {x=pointer.x,y=pointer.y} end}
for _,name in ipairs({'set_prop','float','move','resize','center'}) do hl.dsp.window[name]=operation(name) end
hl.dsp.focus=operation('focus'); hl.dsp.cursor={move=operation('warp')}
hl.dispatch=function(op)
 calls=calls+1
 if op.name=='focus' then focusCalls=focusCalls+1; active=o; pointer.x=0; pointer.y=0 end
 if op.name=='warp' then warps=warps+1; pointer.x=op.args.x; pointer.y=op.args.y end
end
local ok,err=pcall(function() SCRIPT end)
print(ok and 'ok' or tostring(err))
print(calls,focusCalls,warps,active==initial and 1 or 0,pointer.x,pointer.y)
""".replace('ID', str(291 if matching else 999)).replace('BUSY', 'true' if busy else 'false').replace('SCRIPT', script)
                    result = subprocess.run(
                        [shutil.which("luajit"), "-"], input=fixture, text=True,
                        capture_output=True, check=True, timeout=5,
                    )
                    lines = result.stdout.splitlines()
                    observed["state"] = list(map(int, lines[-1].split()))
                    return lines[0]
                transport = SimpleNamespace(_exchange=exchange)
                if busy or not matching:
                    failure = None
                    try:
                        place_new_window(transport, window, 4, {"width": 800, "height": 600})
                    except SessionError as error:
                        failure = error
                    self.assertEqual(observed["state"], [0, 0, 0, 1, 211, 337])
                    self.assertIsInstance(failure, SessionError)
                else:
                    place_new_window(transport, window, 4, {"width": 800, "height": 600})
                    self.assertEqual(observed["state"], [5, 0, 0, 1, 211, 337])


if __name__ == "__main__":
    unittest.main()
