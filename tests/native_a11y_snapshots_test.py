import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.a11y_snapshots import SnapshotStore, SnapshotError
from src.native import a11y_dump
from native_a11y_test import Node as DumpNode, fake_atspi
import time


class Node:
    def __init__(self, key, parent=None):
        self.key, self.parent, self.live = key, parent, True


class Snapshots(unittest.TestCase):
    def setUp(self):
        self.now = 1.0
        self.root = Node("frame")
        self.child = Node("original", self.root)
        self.binding = (123, "start", "title", "window")
        self.store = SnapshotStore(self.identity, self.member, clock=lambda: self.now, ttl=1)

    def identity(self, node):
        if not node.live:
            raise RuntimeError("disposed")
        return node.key

    def member(self, root, node):
        return root is node or node.parent is root

    def publish(self, **options):
        return self.store.publish(self.binding, 4, self.root,
            [(self.root, {"role": "frame"}), (self.child, {"name": "same"})], **options)

    def test_refs_bind_native_objects_not_identical_replacement(self):
        nodes, _ = self.publish()
        original = self.store.resolve(nodes[1]["ref"], self.binding, 4)[0]
        self.assertIs(original, self.child)
        self.child.live = False
        replacement = Node("original", self.root)
        self.assertIsNot(replacement, original)
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)

    def test_any_changed_epoch_rejects_without_rebinding(self):
        nodes, _ = self.publish()
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 5)

    def test_foreign_window_cannot_use_ref_or_destroy_original(self):
        nodes, _ = self.publish()
        with self.assertRaisesRegex(SnapshotError, "FOREIGN_REF"):
            self.store.resolve(nodes[1]["ref"], (123, "start", "title", "other"), 4)
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)

    def test_expired_and_bare_refs_fail_typed(self):
        nodes, _ = self.publish()
        with self.assertRaisesRegex(SnapshotError, "INVALID_REF"):
            self.store.resolve("e1", self.binding, 4)
        self.now = 2
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)

    def test_unqualified_provider_cannot_mutate(self):
        nodes, _ = self.publish()
        with self.assertRaisesRegex(SnapshotError, "UNSUPPORTED_REF_IDENTITY"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4, mutation=True)
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)

    def test_readonly_root_checks_strong_lifetime_even_if_raw_proxy_path_is_unchanged(self):
        self.store.identity = lambda node: (":1.42", node.key, 123)
        class Proof:
            live, closed = True, False
            def supports(self, path): return path == "original"
            def current(self, path): return self.live
            def close(self): self.closed = True
        proof = Proof()
        nodes, _ = self.publish(mutation_identity=True, proof=proof)
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)
        # The proxy still reports exactly the same provider path and ancestry,
        # but the provider-side UUID/QPointer says the original object died.
        proof.live = False
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)
        self.assertTrue(proof.closed)

    def test_readonly_virtual_ref_remains_available_without_mutation_qualification(self):
        self.store.identity = lambda node: (":1.42", node.key, 123)
        class Proof:
            def supports(self, path): return False
            def current(self, path): raise AssertionError("An unqualified path must not use a different strong route")
            def close(self): pass
        nodes, _ = self.publish(mutation_identity=True, proof=Proof())
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)
        with self.assertRaisesRegex(SnapshotError, "UNSUPPORTED_REF_IDENTITY"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4, mutation=True)

    def test_virtual_read_ref_still_rejects_a_dead_qualified_window_root(self):
        self.store.identity = lambda node: (":1.42", node.key, 123)
        class Proof:
            live = True
            def supports(self, path): return path == "frame"
            def current(self, path): return self.live
            def close(self): pass
        proof = Proof()
        nodes, _ = self.publish(mutation_identity=True, proof=proof)
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)
        proof.live = False
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)

    def test_failed_subtree_publication_preserves_old_refs(self):
        nodes, _ = self.publish()
        with self.assertRaises(SnapshotError):
            self.store.publish(self.binding, 4, self.root, [(Node("foreign"), {})])
        self.assertIs(self.store.resolve(nodes[1]["ref"], self.binding, 4)[0], self.child)

    def test_eviction_and_bounded_generator(self):
        nodes, _ = self.publish()
        for _ in range(4):
            self.publish()
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)
        visits = []
        def infinite():
            while True:
                visits.append(1)
                yield self.child, {}
        with self.assertRaisesRegex(SnapshotError, "REF_LIMIT_REACHED"):
            self.store.publish(self.binding, 4, self.root, infinite())
        self.assertEqual(len(visits), 302)

    def test_expiry_during_native_validation_cannot_extend_a_ref(self):
        nodes, _ = self.publish()
        def delayed(root, node):
            self.now = 3
            return True
        self.store.member = delayed
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.resolve(nodes[1]["ref"], self.binding, 4)

    def test_final_current_check_rejects_expiry_and_eviction_after_resolve(self):
        nodes, _ = self.publish()
        _, _, entry = self.store.resolve(nodes[1]["ref"], self.binding, 4)
        self.store.assert_current(entry)
        self.now = 2
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.assert_current(entry)
        self.setUp()
        nodes, _ = self.publish()
        _, _, entry = self.store.resolve(nodes[1]["ref"], self.binding, 4)
        for _ in range(4):
            self.publish()
        with self.assertRaisesRegex(SnapshotError, "STALE_REF"):
            self.store.assert_current(entry)

    def test_clock_reversal_or_nonfinite_value_drops_refs(self):
        for value in [0.5, float("nan"), float("inf")]:
            self.setUp()
            nodes, _ = self.publish()
            self.now = value
            with self.assertRaises(SnapshotError):
                self.store.resolve(nodes[1]["ref"], self.binding, 4)
            self.assertEqual(len(self.store.entries), 0)

    def test_subtree_keeps_full_tree_scale_and_scroll_context(self):
        leaf = DumpNode("push button", "hit", box=(300, 400, 150, 60))
        document = DumpNode("document web", "doc", box=(0, 300, 1500, 900), children=[leaf])
        root = DumpNode("frame", "app", box=(0, 0, 1000, 800), children=[document])
        retained = {}
        def keep(node, record, context):
            retained[record.get("name")] = context
        atspi = fake_atspi()
        full, _ = a11y_dump.walk(root, atspi, 100, time.monotonic() + 2, retain=keep)
        subtree, _ = a11y_dump.walk(leaf, atspi, 100, time.monotonic() + 2, initial=retained["hit"])
        self.assertEqual(subtree[0]["box"], next(n["box"] for n in full if n.get("name") == "hit"))
        self.assertTrue(retained["hit"]["scrolling"])
        self.assertEqual(retained["hit"]["unit"], 1.5)


if __name__ == "__main__":
    unittest.main()
