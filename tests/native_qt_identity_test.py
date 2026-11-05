"""Private route qualification contract, not real application acceptance."""
import unittest
from unittest.mock import patch
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.a11y_qt_identity import QtIdentity, BASE, ROUTE, mapped_bridge
from types import SimpleNamespace


class FakeBus:
    def is_closed(self): return False


class IdentityTests(unittest.TestCase):
    def identity(self):
        proof = QtIdentity.__new__(QtIdentity)
        proof.bus, proof.pid, proof.owner = FakeBus(), 42, ":1.42"
        proof.address, proof.bus_id = "unix:path=/owned/bus", "a" * 32
        proof.original_owner, proof.root = ":1.41", "/org/a11y/atspi/accessible/2147483648"
        proof.unsupported = set()
        proof.GLib = SimpleNamespace(Variant=lambda signature,value:(signature,value))
        proof.routes = {"/org/a11y/atspi/accessible/2147483648": BASE + "/" + "b" * 32}
        return proof

    def test_alias_target_never_forwards_the_reusable_original_path(self):
        proof = self.identity(); original = next(iter(proof.routes))
        self.assertEqual(proof.target(original), dict(owner=":1.42", path=BASE+"/"+"b"*32,
            address="unix:path=/owned/bus", busId="a"*32, pid=42))
        self.assertFalse(proof.supports("/org/a11y/atspi/accessible/2147483649"))
        with self.assertRaises(ValueError): proof.target("/org/a11y/atspi/accessible/2147483649")

    def test_current_checks_exact_uuid_and_bus_generation(self):
        proof = self.identity(); calls=[]
        def call(owner, path, interface, method, args, result):
            calls.append((owner,path,interface,method,result))
            return (proof.bus_id,) if method == "GetId" else ([0,0],)
        proof._call=call; proof._pid=lambda owner:42
        self.assertTrue(proof.current(next(iter(proof.routes))))
        self.assertEqual(calls[-1], (":1.42", BASE+"/"+"b"*32,"org.a11y.atspi.Accessible","GetState","(au)"))
        proof._call=lambda *args:("c"*32,)
        self.assertFalse(proof.current(next(iter(proof.routes))))

    def test_process_loss_or_removed_uuid_never_selects_replacement(self):
        proof=self.identity(); original=next(iter(proof.routes))
        proof._call=lambda *args:(proof.bus_id,);proof._pid=lambda owner:43
        self.assertFalse(proof.current(original))
        proof._pid=lambda owner:42
        def removed(*args):
            if args[3] == "GetState": raise RuntimeError("StaleRef")
            return (proof.bus_id,)
        proof._call=removed
        self.assertFalse(proof.current(original))
        self.assertEqual(proof.routes[original], BASE+"/"+"b"*32)

    def test_virtual_nodes_and_malformed_aliases_cannot_be_promoted(self):
        self.assertIsNone(ROUTE.fullmatch(BASE+"/2147483648"))
        self.assertIsNone(ROUTE.fullmatch(BASE+"/"+"a"*31))
        self.assertIsNotNone(ROUTE.fullmatch(BASE+"/"+"a"*32))
        proof=self.identity(); proof._call=lambda *args: (_ for _ in ()).throw(AssertionError("must not query virtual target"))
        self.assertFalse(proof.current("/org/a11y/atspi/accessible/2147483649"))

    def test_binding_is_established_before_fields_and_never_rebound_after_reuse(self):
        proof=self.identity(); original=next(iter(proof.routes)); calls=[]
        proof.current=lambda path: False
        proof._call=lambda *args: calls.append(args)
        with self.assertRaises(ValueError): proof.bind(original)
        self.assertEqual(calls, [])

    def test_final_pair_verification_rejects_original_path_reuse(self):
        proof=self.identity(); original=next(iter(proof.routes)); before=dict(proof.routes)
        proof._call=lambda *args:(False,)
        with self.assertRaises(ValueError): proof.retain([original], lambda path:(":1.41",path,42))
        self.assertEqual(proof.routes,before)

    def test_retaining_only_snapshot_nodes_releases_unused_private_routes(self):
        proof=self.identity(); original=next(iter(proof.routes)); extra="/org/a11y/atspi/accessible/2147483649"
        proof.routes[extra]=BASE+"/"+"c"*32;calls=[]
        def call(*args):
            calls.append(args)
            return (True,) if args[3]=="Verify" else ()
        proof._call=call
        self.assertIs(proof.retain([original],lambda path:(":1.41",path,42)),proof)
        self.assertEqual(set(proof.routes),{original})
        self.assertEqual(calls[0][3],"Verify")
        self.assertEqual(calls[1][3],"Release")

    def test_constructing_after_record_reads_cannot_qualify_numeric_paths(self):
        app=SimpleNamespace(get_toolkit_name=lambda:"Qt",get_toolkit_version=lambda:"6.11.2")
        with patch("src.native.a11y_qt_identity.mapped_bridge",return_value=True):
            with self.assertRaisesRegex(ValueError,"pre-read"):
                QtIdentity(app,None,[],lambda node:(":1.41","/org/a11y/atspi/accessible/2147483648",42),42)

    def test_optin_requires_a_live_mapping_even_with_a_local_receipt(self):
        # The current process is Python and does not load the helper.
        import os
        try: result=mapped_bridge(os.getpid())
        except FileNotFoundError: result=False
        self.assertFalse(result)


if __name__ == "__main__": unittest.main()
