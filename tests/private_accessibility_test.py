import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("accessibility", Path(__file__).parents[1] / "src/native/private_accessibility.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Inspection(unittest.TestCase):
    def call(self, sender, path, interface, method, signature=None, args=()):
        if method == "GetConnectionUnixProcessID": return (55,)
        if method == "GetChildren":
            if sender == "org.a11y.atspi.Registry": return ([(":1.2", "/app")],)
            if path == "/app": return ([(":1.2", "/window")],)
            if path == "/window": return ([(":1.2", "/button")],)
            return ([],)
        if method == "Get": return ("Window",)
        if method == "GetAll": return ({"Name": "Private button"},)
        if method == "GetRoleName": return ("button",)
        if method == "GetState": return ([0, 0],)
        raise AssertionError(method)

    def test_owned_tree(self):
        result = module.inspect_tree(self.call, 55, "Window", lambda: None)
        self.assertEqual(len(result["nodes"]), 2)
        self.assertEqual(result["nodes"][1]["parent"], "1")

    def test_foreign_process(self):
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            module.inspect_tree(self.call, 56, "Window", lambda: None)

    def test_window_name_mismatch(self):
        with self.assertRaisesRegex(RuntimeError, "window identity"):
            module.inspect_tree(self.call, 55, "Other", lambda: None)

    def test_cross_sender_child(self):
        def call(*args):
            if args[1] == "/window" and args[3] == "GetChildren": return ([(":1.9", "/other")],)
            return self.call(*args)
        with self.assertRaisesRegex(RuntimeError, "changed application sender"):
            module.inspect_tree(call, 55, "Window", lambda: None)

    def test_ambiguous_window(self):
        def call(*args):
            if args[1] == "/app" and args[3] == "GetChildren": return ([(":1.2", "/a"), (":1.2", "/b")],)
            return self.call(*args)
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            module.inspect_tree(call, 55, "Window", lambda: None)

    def test_node_bound(self):
        def call(*args):
            if args[1] == "/window" and args[3] == "GetChildren":
                return ([(":1.2", f"/child{i}") for i in range(400)],)
            return self.call(*args)
        result = module.inspect_tree(call, 55, "Window", lambda: None)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["nodes"]), 256)

    def test_cycle(self):
        def call(*args):
            if args[1] == "/button" and args[3] == "GetChildren": return ([(":1.2", "/window")],)
            return self.call(*args)
        with self.assertRaisesRegex(RuntimeError, "cycle"):
            module.inspect_tree(call, 55, "Window", lambda: None)

    def test_owner_bus_refused_before_connect(self):
        with self.assertRaisesRegex(RuntimeError, "private socket"):
            module.private_bus(Path("/tmp/private"), "unix:path=/owner/bus")

    def test_stale_process(self):
        def check(): raise RuntimeError("stale")
        with self.assertRaisesRegex(RuntimeError, "stale"):
            module.inspect_tree(self.call, 55, "Window", check)


if __name__ == "__main__": unittest.main()
