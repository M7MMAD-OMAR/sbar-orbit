"""Owned pure registry fixtures, not evidence of AT-SPI proxy or remote identity safety."""
from dataclasses import FrozenInstanceError, replace
import gc
from pathlib import Path
import sys
import unittest
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.a11y_refs import RefError, RetainedRegistry, TargetBinding


class Node:
    # All visible properties can be identical while native Python identity differs.
    name = "same name"
    role = "button"
    bounds = (1, 2, 3, 4)

    def __eq__(self, other):
        raise AssertionError("Registry must not compare native handles")

    def __hash__(self):
        raise AssertionError("Registry must not fingerprint native handles")


class Provider:
    def __init__(self, binding):
        self.binding = binding
        self.live = []
        self.calls = []
        self.error = False

    def add(self, *handles):
        self.live.extend(handles)

    def remove(self, handle):
        self.live = [node for node in self.live if node is not handle]

    def validate(self, binding, root, node):
        self.calls.append((binding, root, node))
        if self.error:
            raise RuntimeError("private provider exception")
        return (binding == self.binding and any(value is root for value in self.live) and
                any(value is node for value in self.live))


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.binding = TargetBinding("session-helper-1", 42, "process-start-1", "window-1", "window-generation-1")
        self.provider = Provider(self.binding)
        self.registry = self.make()

    def make(self, **options):
        return RetainedRegistry(validate=self.provider.validate, clock=lambda: self.now, **options)

    def commit(self, registry=None, nodes=None, root=None):
        registry = self.registry if registry is None else registry
        root = Node() if root is None else root
        nodes = [Node()] if nodes is None else nodes
        self.provider.add(root, *nodes)
        return registry.commit(self.binding, root, nodes), root, nodes

    def code(self, expected, operation):
        with self.assertRaises(RefError) as caught:
            operation()
        self.assertEqual(caught.exception.code, expected)
        self.assertEqual(str(caught.exception), expected)

    def test_exact_retained_node_and_root_not_selector_resolution(self):
        snapshot, root, nodes = self.commit()
        self.assertEqual(len(snapshot.node_refs), 1)
        self.assertIs(self.registry.resolve(snapshot.root_ref, self.binding), root)
        self.assertIs(self.registry.resolve(snapshot.node_refs[0], self.binding), nodes[0])
        self.assertIs(self.provider.calls[-1][1], root)
        self.assertIs(self.provider.calls[-1][2], nodes[0])
        self.assertEqual(self.registry.stats(), {"snapshots": 1, "retained_refs": 2})
        with self.assertRaises(FrozenInstanceError):
            snapshot.root_ref = "changed"

    def test_identical_replacement_does_not_resolve_old_ref_to_new_object(self):
        snapshot, root, nodes = self.commit()
        old = nodes[0]
        replacement = Node()
        self.provider.remove(old)
        self.provider.add(replacement)
        later = self.registry.commit(self.binding, root, [replacement])
        self.code("VALIDATION_FAILED", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.root_ref, self.binding))
        self.assertIs(self.registry.resolve(later.node_refs[0], self.binding), replacement)
        self.assertIsNot(old, replacement)
        self.assertNotEqual(snapshot.node_refs, later.node_refs)

    def test_object_invalidation_uses_identity_not_overloaded_equality(self):
        snapshot, _, nodes = self.commit()
        unrelated = Node()
        self.registry.invalidate_object(unrelated)
        self.assertIs(self.registry.resolve(snapshot.node_refs[0], self.binding), nodes[0])
        self.registry.invalidate_object(nodes[0])
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.root_ref, self.binding))

    def test_root_loss_invalidates_whole_snapshot(self):
        snapshot, root, _ = self.commit()
        self.provider.remove(root)
        self.code("VALIDATION_FAILED", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))
        self.assertEqual(self.registry.stats()["retained_refs"], 0)

    def test_expiry_is_absolute_including_exact_deadline(self):
        snapshot, _, nodes = self.commit()
        self.now = snapshot.expires_at - 1
        self.assertIs(self.registry.resolve(snapshot.node_refs[0], self.binding), nodes[0])
        self.now = snapshot.expires_at
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))
        self.assertEqual(self.registry.stats(), {"snapshots": 0, "retained_refs": 0})

    def test_clear_and_recommit_never_reuses_snapshot_generation(self):
        first, root, nodes = self.commit()
        self.registry.clear()
        second = self.registry.commit(self.binding, root, nodes)
        self.assertNotEqual(first.snapshot_id, second.snapshot_id)
        self.code("STALE_REF", lambda: self.registry.resolve(first.node_refs[0], self.binding))
        self.assertIs(self.registry.resolve(second.node_refs[0], self.binding), nodes[0])

    def test_foreign_target_process_window_or_owner_generation_refused(self):
        snapshot, _, nodes = self.commit()
        for patch in ({"owner_id": "other"}, {"process_id": 43}, {"process_generation": "reused-pid"},
                      {"window_id": "other"}, {"window_generation": "reused-window"}):
            foreign = replace(self.binding, **patch)
            self.code("FOREIGN_TARGET", lambda: self.registry.resolve(snapshot.node_refs[0], foreign))
        self.assertIs(self.registry.resolve(snapshot.node_refs[0], self.binding), nodes[0])

    def test_provider_process_generation_change_cannot_revive_old_ref(self):
        snapshot, _, _ = self.commit()
        self.provider.binding = replace(self.binding, process_generation="process-start-2")
        self.code("VALIDATION_FAILED", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))
        self.provider.binding = self.binding
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))

    def test_foreign_registry_and_malformed_refs_fail_typed(self):
        snapshot, _, _ = self.commit()
        foreign = self.make()
        self.code("FOREIGN_REF", lambda: foreign.resolve(snapshot.root_ref, self.binding))
        for value in (None, 1, "", "name=same name", "a" * 10000, snapshot.snapshot_id):
            self.code("INVALID_REF", lambda: self.registry.resolve(value, self.binding))
        unknown = snapshot.snapshot_id + ":" + "f" * 32
        self.code("STALE_REF", lambda: self.registry.resolve(unknown, self.binding))

    def test_snapshot_cap_evicts_fifo_not_lru(self):
        registry = self.make(max_snapshots=2)
        first, _, _ = self.commit(registry)
        second, _, _ = self.commit(registry)
        registry.resolve(first.root_ref, self.binding)
        third, _, _ = self.commit(registry)
        self.code("STALE_REF", lambda: registry.resolve(first.root_ref, self.binding))
        registry.resolve(second.root_ref, self.binding)
        registry.resolve(third.root_ref, self.binding)
        self.assertEqual(registry.stats(), {"snapshots": 2, "retained_refs": 4})

    def test_total_cap_and_root_slots_evict_whole_snapshots(self):
        registry = self.make(max_refs_per_snapshot=3, max_total_refs=3)
        first, _, _ = self.commit(registry)
        second, root, nodes = self.commit(registry, nodes=[Node(), Node()])
        self.code("STALE_REF", lambda: registry.resolve(first.root_ref, self.binding))
        self.assertEqual(registry.stats(), {"snapshots": 1, "retained_refs": 3})
        self.assertIs(registry.resolve(second.root_ref, self.binding), root)
        self.assertIs(registry.resolve(second.node_refs[1], self.binding), nodes[1])
        roots_only = self.make(max_refs_per_snapshot=1, max_total_refs=1)
        snapshot, root, _ = self.commit(roots_only, nodes=[])
        self.assertEqual(snapshot.node_refs, ())
        self.assertIs(roots_only.resolve(snapshot.root_ref, self.binding), root)
        self.assertEqual(roots_only.stats()["retained_refs"], 1)

    def test_failed_validation_does_not_publish_or_evict_previous_snapshot(self):
        registry = self.make(max_snapshots=1)
        first, _, nodes = self.commit(registry)
        root, valid, invalid = Node(), Node(), Node()
        self.provider.add(root, valid)
        self.code("VALIDATION_FAILED", lambda: registry.commit(self.binding, root, [valid, invalid]))
        self.assertEqual(registry.stats(), {"snapshots": 1, "retained_refs": 2})
        self.assertIs(registry.resolve(first.node_refs[0], self.binding), nodes[0])
        next_snapshot, _, _ = self.commit(registry)
        self.assertEqual(int(next_snapshot.snapshot_id.split(":")[1], 16), 2)

    def test_failing_generator_does_not_leak_exception_or_evict(self):
        first, _, _ = self.commit()
        def broken():
            yield Node()
            raise RefError("private-generator-data")
        self.code("INVALID_HANDLE", lambda: self.registry.commit(self.binding, Node(), broken()))
        self.registry.resolve(first.root_ref, self.binding)

    def test_endless_generator_consumption_is_bounded_before_provider(self):
        registry = self.make(max_refs_per_snapshot=3, max_total_refs=3)
        consumed = []
        def endless():
            while True:
                consumed.append(1)
                yield Node()
        self.code("LIMIT_REACHED", lambda: registry.commit(self.binding, Node(), endless()))
        self.assertEqual(len(consumed), 3)
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(registry.stats()["retained_refs"], 0)

    def test_provider_exception_invalidates_snapshot_and_never_leaks_content(self):
        snapshot, _, _ = self.commit()
        self.provider.error = True
        self.code("VALIDATION_FAILED", lambda: self.registry.resolve(snapshot.node_refs[0], self.binding))
        self.provider.error = False
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.root_ref, self.binding))

    def test_provider_must_return_literal_true(self):
        registry = RetainedRegistry(validate=lambda *_: 1, clock=lambda: self.now)
        self.code("VALIDATION_FAILED", lambda: registry.commit(self.binding, Node(), []))

    def test_expiry_during_validation_cannot_extend_snapshot_life(self):
        snapshot, _, _ = self.commit()
        def slow(*_):
            self.now = snapshot.expires_at
            return True
        self.registry._validate = slow
        self.code("STALE_REF", lambda: self.registry.resolve(snapshot.root_ref, self.binding))
        self.assertEqual(self.registry.stats()["retained_refs"], 0)

    def test_commit_validation_deadline_does_not_evict_existing_snapshot(self):
        registry = self.make(max_snapshots=1, ttl_seconds=5)
        first, _, _ = self.commit(registry)
        self.now += 1
        def slow(*_):
            self.now += 5
            return True
        registry._validate = slow
        self.code("STALE_REF", lambda: registry.commit(self.binding, Node(), []))
        # Existing entry was never replaced, although it is now expired and will prune on use.
        self.assertEqual(tuple(registry._entries), (first.snapshot_id,))
        self.assertEqual(registry.stats()["retained_refs"], 0)

    def test_callback_reentry_fails_closed_without_clearing_older_snapshot(self):
        first, _, _ = self.commit()
        def reentrant(*_):
            self.registry.clear()
            return True
        self.registry._validate = reentrant
        self.code("VALIDATION_FAILED", lambda: self.registry.commit(self.binding, Node(), []))
        self.registry._validate = self.provider.validate
        self.registry.resolve(first.root_ref, self.binding)
        self.registry._validate = reentrant
        self.code("VALIDATION_FAILED", lambda: self.registry.resolve(first.root_ref, self.binding))
        self.assertEqual(self.registry.stats()["retained_refs"], 0)

    def test_clock_reversal_nonfinite_and_exceptions_drop_retained_handles(self):
        for clock in (lambda: 9, lambda: float("nan"), lambda: float("inf"), lambda: True):
            registry = self.make()
            self.commit(registry)
            registry._clock = clock
            self.code("INVALID_CLOCK", registry.prune)
            self.assertEqual(registry._retained, 0)
        registry = self.make()
        self.commit(registry)
        def broken_clock():
            raise RuntimeError("private clock details")
        registry._clock = broken_clock
        self.code("INVALID_CLOCK", registry.prune)

    def test_target_snapshot_and_root_invalidation_are_whole_snapshot(self):
        first, _, _ = self.commit()
        second, root, _ = self.commit()
        self.registry.invalidate_snapshot(first.snapshot_id, self.binding)
        self.code("STALE_REF", lambda: self.registry.resolve(first.root_ref, self.binding))
        self.registry.invalidate_object(root)
        self.code("STALE_REF", lambda: self.registry.resolve(second.root_ref, self.binding))
        self.commit()
        self.registry.invalidate_target(self.binding)
        self.assertEqual(self.registry.stats()["snapshots"], 0)

    def test_snapshot_invalidation_cannot_cross_target_or_registry(self):
        snapshot, _, _ = self.commit()
        self.code("FOREIGN_TARGET", lambda: self.registry.invalidate_snapshot(snapshot.snapshot_id, replace(self.binding, owner_id="other")))
        self.code("FOREIGN_REF", lambda: self.make().invalidate_snapshot(snapshot.snapshot_id, self.binding))
        self.registry.resolve(snapshot.root_ref, self.binding)

    def test_retained_handles_release_on_clear_and_expiry_prune(self):
        # Provider fixtures also retain objects, so use a stateless validator here.
        registry = RetainedRegistry(validate=lambda *_: True, clock=lambda: self.now)
        root, node = Node(), Node()
        root_weak, node_weak = weakref.ref(root), weakref.ref(node)
        snapshot = registry.commit(self.binding, root, [node])
        del root, node
        gc.collect()
        self.assertIsNotNone(root_weak())
        self.assertIsNotNone(node_weak())
        self.now = snapshot.expires_at
        registry.prune()
        gc.collect()
        self.assertIsNone(root_weak())
        self.assertIsNone(node_weak())

    def test_strict_configuration_and_binding_validation(self):
        for options in ({"max_snapshots": True}, {"max_snapshots": 65}, {"max_snapshots": 0},
                        {"max_refs_per_snapshot": 4097}, {"max_total_refs": 16385},
                        {"max_refs_per_snapshot": 2, "max_total_refs": 1},
                        {"ttl_seconds": True}, {"ttl_seconds": 0}, {"ttl_seconds": float("nan")},
                        {"ttl_seconds": 301}, {"ttl_seconds": 10**1000}):
            self.code("INVALID_LIMIT", lambda: self.make(**options))
        for patch in ({"process_id": True}, {"process_id": 0}, {"owner_id": ""},
                      {"window_generation": "private\ncontent"}, {"process_generation": "x" * 129}):
            self.code("INVALID_BINDING", lambda: replace(self.binding, **patch))
        self.code("INVALID_BINDING", lambda: self.registry.commit({}, Node(), []))
        self.code("INVALID_HANDLE", lambda: self.registry.commit(self.binding, None, []))
        self.code("INVALID_HANDLE", lambda: self.registry.commit(self.binding, Node(), [None]))


if __name__ == "__main__":
    unittest.main()
