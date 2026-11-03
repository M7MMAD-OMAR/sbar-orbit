"""Pure assertions and fake retained handles. No GI, bus, process or application access."""
from dataclasses import FrozenInstanceError
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.a11y_identity import (
    AccessibleIdentity, GTK_SOURCE_REVISION, IdentityError, ProviderEvidence, identity_matches,
)
from src.native import a11y_refs
from src.native.a11y_refs import RefError, RetainedRegistry, TargetBinding

BASE = "/org/example/Owned/a11y"
ROOT_PATH = BASE + "/00112233_4455_6677_8899_aabbccddeeff"
NODE_PATH = BASE + "/ffeeddcc_bbaa_9988_7766_554433221100"
REPLACEMENT = BASE + "/00000000_1111_2222_3333_444444444444"


def binding(**changes):
    values = dict(owner_id="owned-epoch", process_id=42, process_generation="12345",
                  window_id="owned-window", window_generation="compositor-stable-1")
    values.update(changes)
    return TargetBinding(**values)


def fixture_verifier(_assertion):
    # FIXTURE ONLY. Always-True is never a production provider verifier or native proof.
    return True


def evidence(**changes):
    # Synthetic trusted-caller assertions only, not measured provider qualifications.
    values = dict(toolkit="GTK", toolkit_version="4.22.5", source_revision=GTK_SOURCE_REVISION,
                  artifact_sha256="a" * 64, route="managed-accessibility-bus", path_base=BASE,
                  lifetime_policy="gtk4-per-realization-random-uuid",
                  qualification="trusted-provider-uuid-noncollision", verify=fixture_verifier)
    values.update(changes)
    return ProviderEvidence(**values)


def token(**changes):
    values = dict(binding=binding(), helper_generation="b" * 32, bus_id="c" * 32,
                  unique_owner=":1.42", process_start=12345, object_path=NODE_PATH, window_root_path=ROOT_PATH, evidence=evidence())
    values.update(changes)
    return AccessibleIdentity(**values)


class TokenTests(unittest.TestCase):
    def test_exact_qualified_tuple_matches_without_native_object_lookup(self):
        self.assertTrue(identity_matches(token(), token(), binding()))

    def test_all_containers_are_immutable_and_nested_fields_are_typed(self):
        value = token()
        with self.assertRaises(FrozenInstanceError): value.bus_id = "d" * 32
        with self.assertRaises(FrozenInstanceError): value.evidence.route = "unknown"
        with self.assertRaises(FrozenInstanceError): value.binding.owner_id = "other"
        with self.assertRaises(IdentityError): token(binding={"process_id": 42})
        with self.assertRaises(IdentityError): token(evidence="GTK 4.22.5")

    def test_bus_restart_owner_reconnect_and_helper_restart_never_alias(self):
        expected = token()
        for changes in ({"bus_id": "d" * 32}, {"unique_owner": ":1.43"}, {"helper_generation": "e" * 32}):
            with self.subTest(changes=changes):
                self.assertFalse(identity_matches(expected, token(**changes), binding()))

    def test_pid_and_start_generation_reuse_do_not_match(self):
        old = token()
        changed_pid = binding(process_id=43)
        self.assertFalse(identity_matches(old, token(binding=changed_pid), changed_pid))
        changed_start = binding(process_generation="12346")
        self.assertFalse(identity_matches(old, token(binding=changed_start, process_start=12346), changed_start))

    def test_window_or_authority_replacement_is_an_exact_target_change(self):
        for key, value in (("owner_id", "new-authority"), ("window_id", "new-window"), ("window_generation", "new-stable")):
            with self.subTest(key=key):
                changed = binding(**{key: value})
                self.assertFalse(identity_matches(token(), token(binding=changed), changed))
                self.assertFalse(identity_matches(token(), token(), changed))

    def test_rerealization_new_uuid_must_not_replace_original_context(self):
        self.assertFalse(identity_matches(token(), token(object_path=REPLACEMENT), binding()))

    def test_root_recreation_changes_identity_even_with_same_node_uuid_and_native_binding(self):
        expected, current = token(), token(window_root_path=REPLACEMENT)
        self.assertEqual(expected.object_path, current.object_path)
        self.assertEqual(expected.binding, current.binding)
        self.assertFalse(identity_matches(expected, current, binding()))

    def test_toolkit_version_or_path_shape_alone_never_proves_eligibility(self):
        with self.assertRaises(TypeError): ProviderEvidence(toolkit="GTK", toolkit_version="4.22.5")
        with self.assertRaises(IdentityError): token(evidence={"toolkit": "GTK", "toolkit_version": "4.22.5", "verified": True})
        for changes in ({"verify": False}, {"verify": True}, {"toolkit": "Qt"}, {"toolkit_version": "4.22.6"},
                        {"source_revision": "d" * 40}, {"artifact_sha256": "unknown"},
                        {"qualification": "version-only"}, {"lifetime_policy": "numeric-counter"}):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(IdentityError, "^Accessibility identity proof is missing or unsupported$"):
                    evidence(**changes)

    def test_verifier_is_mandatory_strict_true_and_exceptions_are_fixed(self):
        for result in (False, 1, "true", None):
            with self.subTest(result=result):
                with self.assertRaises(IdentityError): evidence(verify=lambda _assertion: result)
        seen = []
        def trusted_fixture(assertion):
            seen.append(assertion.toolkit)
            return True
        evidence(verify=trusted_fixture)
        self.assertEqual(seen, ["GTK"])
        def throwing(_assertion):
            raise RuntimeError("private-provider-data")
        with self.assertRaises(IdentityError) as caught: evidence(verify=throwing)
        self.assertNotIn("private-provider-data", str(caught.exception))

    def test_unknown_and_app_private_routes_fail_closed(self):
        for route in (None, "", "unknown", "p2p", "app-private-peer", "private-connection"):
            with self.subTest(route=route):
                with self.assertRaises(IdentityError): evidence(route=route)

    def test_provenance_and_trusted_base_are_part_of_exact_identity(self):
        self.assertFalse(identity_matches(token(), token(evidence=evidence(artifact_sha256="d" * 64)), binding()))
        new_base = "/org/example/Other/a11y"
        self.assertFalse(identity_matches(token(), token(evidence=evidence(path_base=new_base),
            object_path=new_base + "/ffeeddcc_bbaa_9988_7766_554433221100",
            window_root_path=new_base + "/00112233_4455_6677_8899_aabbccddeeff"), binding()))

    def test_qualified_paths_require_exact_base_and_audited_underscore_uuid(self):
        for path in ("/org/a11y/atspi/accessible/root", BASE, BASE + "/1", BASE + "/0x1234", BASE + "/root",
                     BASE + "/00112233-4455-6677-8899-aabbccddeeff", BASE + "/00112233_4455_6677_8899_AABBCCDDEEFF",
                     NODE_PATH + "/child", NODE_PATH + "\n", ROOT_PATH.replace("/Owned/", "/Other/")):
            with self.subTest(path=path):
                with self.assertRaises(IdentityError): token(object_path=path)
                with self.assertRaises(IdentityError): token(window_root_path=path)
        # No UUID-version bit constraint was invented from an unreviewed GLib implementation.
        self.assertTrue(identity_matches(token(object_path=ROOT_PATH), token(object_path=ROOT_PATH), binding()))

    def test_base_paths_cannot_be_roots_relative_traversals_or_wellknown_bus_names(self):
        for base in ("/", "relative/a11y", "/org/../a11y", "/org/a11y/", "/org/bad-name/a11y", "org.example.App"):
            with self.subTest(base=base):
                with self.assertRaises(IdentityError): evidence(path_base=base)

    def test_missing_epochs_wellknown_owners_and_noncanonical_starts_refuse(self):
        for key, bad_values in (("bus_id", ("", "unknown", "C" * 32)),
                                ("helper_generation", ("", None, "helper")),
                                ("unique_owner", ("org.example.App", ":1", "1.42", ":1.42\n")),
                                ("process_start", (None, True, 0, -1, "12345", 2 ** 64))):
            for value in bad_values:
                with self.subTest(key=key, value=value):
                    with self.assertRaises(IdentityError): token(**{key: value})
        with self.assertRaises(IdentityError): token(binding=binding(process_generation="012345"))
        with self.assertRaises(IdentityError): token(binding=binding(process_generation="other"))
        with self.assertRaises(IdentityError): token(binding=binding(process_id=2 ** 31))

    def test_forged_plain_values_and_incomplete_instances_are_false_not_coerced(self):
        for fake in (None, "GTK:" + NODE_PATH, {"bus_id": "c" * 32, "object_path": NODE_PATH},
                     object(), object.__new__(AccessibleIdentity)):
            with self.subTest(kind=type(fake).__name__):
                self.assertFalse(identity_matches(token(), fake, binding()))
                self.assertFalse(identity_matches(fake, token(), binding()))
        self.assertFalse(identity_matches(token(), token(), dict(process_id=42)))

    def test_comparator_revalidates_even_same_python_instance_after_bypass(self):
        value = token()
        object.__setattr__(value, "unique_owner", "org.example.Forged")
        self.assertFalse(identity_matches(value, value, binding()))
        value = token()
        object.__setattr__(value.evidence, "_attested", None)
        self.assertFalse(identity_matches(value, value, binding()))

    def test_fixed_errors_do_not_echo_application_supplied_identifiers(self):
        with self.assertRaises(IdentityError) as caught: token(unique_owner="private-application-content")
        self.assertNotIn("private-application-content", str(caught.exception))


class HostileProxy:
    def __eq__(self, _other):
        raise AssertionError("Native proxy equality is not an identity primitive")
    def __hash__(self):
        raise AssertionError("Native proxy hash is not an identity primitive")


class RegistryUseTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.binding = binding()
        self.root, self.node = HostileProxy(), HostileProxy()
        self.expected = [(self.root, token(object_path=ROOT_PATH)), (self.node, token())]
        self.current = list(self.expected)
        self.members = [self.root, self.node]
        def lookup(records, handle):
            return next((identity for native, identity in records if native is handle), None)
        def validate(target, root, node):
            # These membership facts are fake caller evidence, not inferred by identity_matches.
            return (root is self.root and any(node is member for member in self.members)
                    and identity_matches(lookup(self.expected, root), lookup(self.current, root), target)
                    and identity_matches(lookup(self.expected, node), lookup(self.current, node), target)
                    and lookup(self.expected, root).object_path == lookup(self.expected, node).window_root_path
                    and lookup(self.current, root).object_path == lookup(self.current, node).window_root_path)
        with patch.object(a11y_refs.secrets, "token_hex", return_value="f" * 32):
            self.registry = RetainedRegistry(validate=validate, clock=lambda: self.now, ttl_seconds=1)
        self.snapshot = self.registry.commit(self.binding, self.root, [self.node])

    def test_exact_retained_handle_works_without_proxy_equality_or_hash(self):
        self.assertIs(self.registry.resolve(self.snapshot.node_refs[0], self.binding), self.node)

    def test_fresh_epoch_change_invalidates_whole_snapshot_not_selector_substitution(self):
        self.current[1] = (self.node, token(bus_id="d" * 32))
        with self.assertRaisesRegex(RefError, "VALIDATION_FAILED"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)
        self.assertEqual(self.registry.stats()["snapshots"], 0)

    def test_ref_expiry_remains_the_registry_gate_even_with_identical_tokens(self):
        self.now = self.snapshot.expires_at
        self.assertTrue(identity_matches(token(), token(), self.binding))
        with self.assertRaisesRegex(RefError, "STALE_REF"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)

    def test_root_membership_is_a_separate_mandatory_validator_predicate(self):
        self.members = [self.root]
        with self.assertRaisesRegex(RefError, "VALIDATION_FAILED"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)

    def test_recreated_frame_root_refuses_unchanged_native_binding_and_node_uuid(self):
        self.current[0] = (self.root, token(object_path=REPLACEMENT, window_root_path=REPLACEMENT))
        self.current[1] = (self.node, token(window_root_path=REPLACEMENT))
        with self.assertRaisesRegex(RefError, "VALIDATION_FAILED"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)

    def test_crossroot_node_is_not_qualified_by_matching_node_tokens_alone(self):
        crossroot = token(window_root_path=REPLACEMENT)
        self.expected[1] = (self.node, crossroot)
        self.current[1] = (self.node, token(window_root_path=REPLACEMENT))
        self.assertTrue(identity_matches(crossroot, self.current[1][1], self.binding))
        with self.assertRaisesRegex(RefError, "VALIDATION_FAILED"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)

    def test_root_epoch_change_refuses_nodes_with_otherwise_matching_identity(self):
        self.current[0] = (self.root, token(object_path=ROOT_PATH, helper_generation="e" * 32))
        with self.assertRaisesRegex(RefError, "VALIDATION_FAILED"):
            self.registry.resolve(self.snapshot.node_refs[0], self.binding)


if __name__ == "__main__":
    unittest.main()
