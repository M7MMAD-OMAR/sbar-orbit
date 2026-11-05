"""Bounded observation refs held by the private accessibility host.

Refs retain native objects, never selectors. Read traversal is available to all
providers; mutation qualification is a separate, stricter provider decision.
Any observed tree/property/state change invalidates the whole snapshot. The
caller still owns compositor/window authority and dispatch-time policy checks.
"""
from collections import OrderedDict
from dataclasses import dataclass
import re
import secrets
import time
import math
from itertools import islice
import copy

REF = re.compile(r"@([0-9a-f]{32}):e([0-9]{1,3})", re.ASCII)


class SnapshotError(Exception):
    def __init__(self, code="STALE_REF"):
        self.code = code
        super().__init__(code)


@dataclass
class Entry:
    binding: tuple
    epoch: int
    expires: float
    root: object
    root_identity: tuple
    nodes: list
    identities: list
    records: list
    mutation_identity: bool
    proof: object = None
    contexts: object = None


class SnapshotStore:
    def __init__(self, identity, member, *, clock=time.monotonic, ttl=30, max_snapshots=4, max_nodes=301):
        self.identity, self.member, self.clock = identity, member, clock
        self.ttl, self.max_snapshots, self.max_nodes = ttl, max_snapshots, max_nodes
        if (type(max_snapshots) is not int or not 1 <= max_snapshots <= 4
                or type(max_nodes) is not int or not 1 <= max_nodes <= 301
                or type(ttl) not in (int, float) or not math.isfinite(ttl) or not 0 < ttl <= 30):
            raise SnapshotError("REF_LIMIT_REACHED")
        self.entries = OrderedDict()
        self.last_time = None

    def clear(self):
        for entry in self.entries.values():
            if entry.proof is not None:
                entry.proof.close()
        self.entries.clear()

    def _drop(self, key):
        entry = self.entries.pop(key, None)
        if entry is not None and entry.proof is not None:
            entry.proof.close()

    def _prune(self):
        now = self.clock()
        if (type(now) not in (int, float) or not math.isfinite(now) or now < 0
                or self.last_time is not None and now < self.last_time):
            self.clear()
            raise SnapshotError()
        self.last_time = now
        for key, entry in tuple(self.entries.items()):
            if now >= entry.expires:
                self._drop(key)

    def publish(self, binding, epoch, root, pairs, *, mutation_identity=False, proof=None, walked_from_root=False, contexts=None):
        """Validate and construct before changing any retained snapshot."""
        self._prune()
        pairs = list(islice(pairs, self.max_nodes + 1))
        if not pairs or len(pairs) > self.max_nodes:
            raise SnapshotError("REF_LIMIT_REACHED")
        if contexts is not None and len(contexts) != len(pairs):
            raise SnapshotError()
        root_identity = self.identity(root)
        nodes, identities, records = [], [], []
        for node, record in pairs:
            token = self.identity(node)
            if not walked_from_root and not self.member(root, node):
                raise SnapshotError()
            nodes.append(node)
            identities.append(token)
            records.append(dict(record))
        key = secrets.token_hex(16)
        for index, record in enumerate(records):
            record["ref"] = "@" + key + ":e" + str(index)
        entry = Entry(tuple(binding), epoch, self.clock() + self.ttl, root, root_identity,
                      nodes, identities, records, mutation_identity, proof, copy.deepcopy(contexts))
        while self.entries and (len(self.entries) >= self.max_snapshots
                or sum(len(item.nodes) + 1 for item in self.entries.values()) + len(nodes) + 1 > 1024):
            self._drop(next(iter(self.entries)))
        self.entries[key] = entry
        return records, {"id": key, "expiresInMs": int(self.ttl * 1000),
                         "mutationIdentity": mutation_identity}

    def resolve(self, ref, binding, epoch, *, mutation=False):
        if type(ref) is not str or (match := REF.fullmatch(ref)) is None:
            raise SnapshotError("INVALID_REF")
        self._prune()
        entry = self.entries.get(match[1])
        index = int(match[2])
        if entry is None:
            raise SnapshotError()
        if entry.binding != tuple(binding):
            raise SnapshotError("FOREIGN_REF")
        try:
            if entry.epoch != epoch or self.identity(entry.root) != entry.root_identity:
                raise SnapshotError()
            if index >= len(entry.nodes):
                raise SnapshotError()
            node = entry.nodes[index]
            if self.identity(node) != entry.identities[index] or not self.member(entry.root, node):
                raise SnapshotError()
        except Exception:
            self._drop(match[1])
            raise SnapshotError() from None
        if mutation and not entry.mutation_identity:
            raise SnapshotError("UNSUPPORTED_REF_IDENTITY")
        qualified = entry.proof is not None and (not hasattr(entry.proof, "supports")
            or entry.proof.supports(entry.identities[index][1]))
        # Strong routes also protect read-only root drill-down from recycled
        # provider paths, including virtual children of a qualified window.
        if entry.proof is not None:
            root_path = entry.root_identity[1]
            root_qualified = not hasattr(entry.proof, "supports") or entry.proof.supports(root_path)
            paths = ([root_path] if root_qualified else [])
            if qualified and entry.identities[index][1] not in paths:
                paths.append(entry.identities[index][1])
            for path in paths:
                if not entry.proof.current(path):
                    self._drop(match[1])
                    raise SnapshotError()
        if mutation and entry.proof is not None and not qualified:
            raise SnapshotError("UNSUPPORTED_REF_IDENTITY")
        if mutation and entry.proof is None:
            self._drop(match[1])
            raise SnapshotError()
        self.assert_current(entry)
        return node, dict(entry.records[index]), entry

    def assert_current(self, entry):
        """Reject expiry or eviction after the caller's additional provider I/O."""
        self._prune()
        if not any(item is entry for item in self.entries.values()):
            raise SnapshotError()
