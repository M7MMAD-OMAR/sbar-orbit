"""Provisional internal retained-object registry, without desktop or mutation APIs.

Not a shipped orbit_observe/act refs interface. No source caller imports this yet.

The injected provider must prove live process/window generations, root membership,
and native identity. Python object retention alone does not prove remote AT-SPI
identity: a proxy can outlive or alias a replaced remote object. Never recover a
reference by role, name, bounds, index, or a tree fingerprint. This module makes
no claim that a later native action would be atomic with validation.

Single-threaded, synchronous use only. Providers must enforce their own deadline;
there are no threads, timers, bus calls, traversal, or automatic host integration.
TTL is absolute and checked on use. Expired handles are released lazily on prune
or any successful commit, resolve, or stats call, not by a background timer.
Bounds count retained handle slots, not provider-owned memory in bytes.
"""
from collections import OrderedDict
from dataclasses import dataclass
from functools import wraps
import math
import re
import secrets
import time
from typing import Callable, Iterable


class RefError(Exception):
    """Content-free typed refusal. The code never implies safe native replay."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _identity(value: object) -> bool:
    return type(value) is str and 1 <= len(value) <= 128 and all(32 <= ord(char) <= 126 for char in value)


@dataclass(frozen=True)
class TargetBinding:
    """Caller-proven tokens, not identities discovered by this registry.

    owner_id is a trusted opaque authority-generation capability combining the
    session, helper, lease, compositor and provider bus-owner epochs. Its creator
    must derive it outside application data and rotate it on any epoch change.
    The validator must enforce the underlying provenance. This container does
    not discover or prove those gates, remote identity, or operation permission.
    """

    owner_id: str
    process_id: int
    process_generation: str
    window_id: str
    window_generation: str

    def __post_init__(self):
        if (type(self.process_id) is not int or self.process_id <= 0 or
                self.process_id > 2**63 - 1 or
                not all(_identity(value) for value in (self.owner_id, self.process_generation,
                                                       self.window_id, self.window_generation))):
            raise RefError("INVALID_BINDING")


@dataclass(frozen=True)
class Snapshot:
    """node_refs excludes root_ref. Root counts toward every retention budget."""

    snapshot_id: str
    root_ref: str
    node_refs: tuple[str, ...]
    expires_at: float


@dataclass
class _Entry:
    binding: TargetBinding
    root: object
    handles: dict[str, object]
    snapshot: Snapshot


_REF = re.compile(r"([0-9a-f]{32}):([0-9a-f]{1,16}):([0-9a-f]{32})", re.ASCII)
_SNAPSHOT = re.compile(r"([0-9a-f]{32}):([0-9a-f]{1,16})", re.ASCII)


def _operation(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        if self._active:
            raise RefError("REENTRANT_PROVIDER")
        self._active = True
        try:
            return method(self, *args, **kwargs)
        finally:
            self._active = False
    return guarded


class RetainedRegistry:
    def __init__(self, *, validate: Callable[[TargetBinding, object, object], bool],
                 clock: Callable[[], float] = time.monotonic, max_snapshots: int = 4,
                 max_refs_per_snapshot: int = 256, max_total_refs: int = 1024,
                 ttl_seconds: float = 30):
        for value, ceiling in ((max_snapshots, 64), (max_refs_per_snapshot, 4096),
                               (max_total_refs, 16384)):
            if type(value) is not int or not 1 <= value <= ceiling:
                raise RefError("INVALID_LIMIT")
        if (type(ttl_seconds) not in (int, float) or not 0 < ttl_seconds <= 300 or
                not math.isfinite(ttl_seconds) or max_refs_per_snapshot > max_total_refs or
                not callable(validate) or not callable(clock)):
            raise RefError("INVALID_LIMIT")
        self._validate = validate
        self._clock = clock
        self._max_snapshots = max_snapshots
        self._max_refs = max_refs_per_snapshot
        self._max_total = max_total_refs
        self._ttl = ttl_seconds
        self._namespace = secrets.token_hex(16)
        self._generation = 0
        self._last_time = None
        self._active = False
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._retained = 0

    @staticmethod
    def _binding(binding):
        if type(binding) is not TargetBinding:
            raise RefError("INVALID_BINDING")

    def _now(self):
        try:
            now = self._clock()
            if (type(now) not in (int, float) or not math.isfinite(now) or now < 0 or
                    (self._last_time is not None and now < self._last_time)):
                raise ValueError()
        except Exception:
            # A broken clock cannot make a once-expired reference live again.
            self._entries.clear()
            self._retained = 0
            raise RefError("INVALID_CLOCK") from None
        self._last_time = now
        return now

    def _drop(self, snapshot_id):
        entry = self._entries.pop(snapshot_id, None)
        if entry is not None:
            self._retained -= len(entry.handles)

    def _prune(self, now):
        for snapshot_id, entry in tuple(self._entries.items()):
            if now >= entry.snapshot.expires_at:
                self._drop(snapshot_id)

    def _check(self, binding, root, node):
        try:
            if self._validate(binding, root, node) is not True:
                raise RefError("VALIDATION_FAILED")
        except Exception:
            raise RefError("VALIDATION_FAILED") from None

    @_operation
    def commit(self, binding: TargetBinding, root: object, nodes: Iterable[object]) -> Snapshot:
        """Atomically publish a whole snapshot, then evict oldest whole snapshots.

        Failed enumeration/validation does not evict or replace any snapshot.
        Nodes are caller-selected handles, never selectors to be re-resolved.
        Root consumes one slot, even when also present in nodes.
        """
        self._binding(binding)
        if root is None:
            raise RefError("INVALID_HANDLE")
        started = self._now()
        handles = [root]
        try:
            iterator = iter(nodes)
        except Exception:
            raise RefError("INVALID_HANDLE") from None
        # Consume at most cap nodes, including one overflow probe after cap - 1 nodes.
        for _ in range(self._max_refs):
            try:
                node = next(iterator)
            except StopIteration:
                break
            except Exception:
                raise RefError("INVALID_HANDLE") from None
            if len(handles) >= self._max_refs:
                raise RefError("LIMIT_REACHED")
            if node is None:
                raise RefError("INVALID_HANDLE")
            handles.append(node)
        for node in handles:
            self._check(binding, root, node)
        now = self._now()
        expires = started + self._ttl
        if not math.isfinite(expires) or expires <= now:
            raise RefError("STALE_REF")
        if self._generation >= 2**63 - 1:
            raise RefError("LIMIT_REACHED")
        generation = self._generation + 1
        snapshot_id = self._namespace + ":" + format(generation, "x")
        # Position is not an identity or a selector. Each key maps only to its retained handle.
        refs = tuple(snapshot_id + ":" + format(index, "032x") for index in range(len(handles)))
        snapshot = Snapshot(snapshot_id, refs[0], refs[1:], expires)
        entry = _Entry(binding, root, dict(zip(refs, handles)), snapshot)
        self._prune(now)
        while self._entries and (len(self._entries) >= self._max_snapshots or
                                 self._retained + len(handles) > self._max_total):
            self._drop(next(iter(self._entries)))
        self._entries[snapshot_id] = entry
        self._retained += len(handles)
        self._generation = generation
        return snapshot

    @_operation
    def resolve(self, ref: str, binding: TargetBinding) -> object:
        """Validate and return the exact retained handle, never a matching replacement."""
        self._binding(binding)
        match = _REF.fullmatch(ref) if type(ref) is str else None
        if match is None:
            raise RefError("INVALID_REF")
        if match[1] != self._namespace:
            raise RefError("FOREIGN_REF")
        snapshot_id = match[1] + ":" + match[2]
        self._prune(self._now())
        entry = self._entries.get(snapshot_id)
        if entry is None or ref not in entry.handles:
            raise RefError("STALE_REF")
        if entry.binding != binding:
            raise RefError("FOREIGN_TARGET")
        node = entry.handles[ref]
        try:
            self._check(binding, entry.root, node)
        except RefError:
            self._drop(snapshot_id)
            raise
        self._prune(self._now())
        if self._entries.get(snapshot_id) is not entry:
            raise RefError("STALE_REF")
        return node

    @_operation
    def invalidate_object(self, handle: object):
        """Whole-snapshot invalidation by Python identity, not overloaded native equality."""
        for snapshot_id, entry in tuple(self._entries.items()):
            if any(node is handle for node in entry.handles.values()):
                self._drop(snapshot_id)

    @_operation
    def invalidate_target(self, binding: TargetBinding):
        self._binding(binding)
        for snapshot_id, entry in tuple(self._entries.items()):
            if entry.binding == binding:
                self._drop(snapshot_id)

    @_operation
    def invalidate_snapshot(self, snapshot_id: str, binding: TargetBinding):
        self._binding(binding)
        match = _SNAPSHOT.fullmatch(snapshot_id) if type(snapshot_id) is str else None
        if match is None:
            raise RefError("INVALID_REF")
        if match[1] != self._namespace:
            raise RefError("FOREIGN_REF")
        entry = self._entries.get(snapshot_id)
        if entry is None:
            raise RefError("STALE_REF")
        if entry.binding != binding:
            raise RefError("FOREIGN_TARGET")
        self._drop(snapshot_id)

    @_operation
    def clear(self):
        self._entries.clear()
        self._retained = 0

    @_operation
    def prune(self):
        self._prune(self._now())

    @_operation
    def stats(self):
        self._prune(self._now())
        return {"snapshots": len(self._entries), "retained_refs": self._retained}
