"""Private read-only helper with bounded snapshot refs, no mutation or public socket.

Only an inherited descriptor carries bounded observation and ref-resolution requests.
Parent-death protection is armed before accessibility initialization. Provider errors
never leave as exception strings. Mutation identity requires separate qualification.
"""
import ctypes
import gc
import json
import os
from pathlib import Path
import re
import resource
import signal
import socket
import struct
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native import a11y_dump
from src.native.a11y import _trim
from src.native.a11y_snapshots import SnapshotStore, SnapshotError, REF

PROTOCOL = 1
MAX_REQUEST = 65536
MAX_RESPONSE = 262144
TOKEN = re.compile(r"[0-9a-f]{32}", re.ASCII)


def trim_refs(nodes):
    """Reserve the longest scoped ref before deciding publication fits."""
    reserved, cut = _trim([{**node, "ref": "@" + "0" * 32 + ":e300"} for node in nodes])
    return nodes[:len(reserved)], cut


def arm_parent_death(expected_parent):
    """No preexec_fn in a threaded parent; close the parent-death startup race here."""
    if type(expected_parent) is not int or expected_parent <= 1 or os.getppid() != expected_parent:
        raise RuntimeError("Parent unavailable")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise RuntimeError("Parent supervision unavailable")
    if os.getppid() != expected_parent:
        raise RuntimeError("Parent unavailable")


def resource_limits():
    # Additional per-helper ceilings supplement the inherited native process budget.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    for kind, ceiling in ((resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_NOFILE, 64)):
        soft, hard = resource.getrlimit(kind)
        limit = min(ceiling, soft) if soft != resource.RLIM_INFINITY else ceiling
        if hard != resource.RLIM_INFINITY:
            limit = min(limit, hard)
        resource.setrlimit(kind, (limit, hard))


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Invalid JSON")
        value[key] = item
    return value


def receive(connection):
    def exact(size):
        data = bytearray()
        while len(data) < size:
            part = connection.recv(size - len(data))
            if not part:
                raise EOFError()
            data.extend(part)
        return bytes(data)
    size = struct.unpack("!I", exact(4))[0]
    if not 1 <= size <= MAX_REQUEST:
        raise ValueError("Invalid frame")
    return json.loads(exact(size).decode("utf-8"), object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON")))


def send(connection, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if not 1 <= len(data) <= MAX_RESPONSE:
        raise ValueError("Invalid frame")
    connection.sendall(struct.pack("!I", len(data)) + data)


def parse_request(value, generation):
    if (type(value) is not dict or set(value) != {"protocol", "generation", "requestId", "method", "target"}
            or type(value["protocol"]) is not int or value["protocol"] != PROTOCOL
            or value["generation"] != generation or value["method"] != "observe"
            or type(value["requestId"]) is not str or not TOKEN.fullmatch(value["requestId"])):
        raise ValueError("Invalid request")
    target = value["target"]
    if (type(target) is not dict or set(target) - {"pid", "title", "maxNodes", "budgetMs", "deadlineNs", "selection"}
            or not {"pid", "title", "maxNodes", "budgetMs", "deadlineNs"} <= set(target)
            or type(target["pid"]) is not int or not 0 < target["pid"] <= 2147483647
            or type(target["title"]) is not str or len(target["title"].encode("utf-8")) > 16384 or "\0" in target["title"]
            or type(target["maxNodes"]) is not int or target["maxNodes"] != 300
            or type(target["budgetMs"]) is not int or target["budgetMs"] != 1500
            or type(target["deadlineNs"]) is not int):
        raise ValueError("Invalid target")
    if "selection" in target:
        selected = target["selection"]
        if (type(selected) is not dict or set(selected) - {"window", "refs", "skeleton", "root", "resolve", "mutation"}
                or type(selected.get("window")) is not str or not re.fullmatch(r"[0-9a-f]{1,32}", selected["window"])
                or any(type(selected[key]) is not bool for key in ("refs", "skeleton", "mutation") if key in selected)
                or any(type(selected[key]) is not str or REF.fullmatch(selected[key]) is None
                       for key in ("root", "resolve") if key in selected)
                or "root" in selected and "resolve" in selected or "mutation" in selected and "resolve" not in selected):
            raise ValueError("Invalid observation selection")
    now = time.monotonic_ns()
    if not now < target["deadlineNs"] <= now + 5_000_000_000:
        raise ValueError("Expired request")
    return target


def process_generation(pid):
    # Linux stat field 22, after the final parenthesis of the executable name.
    fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    return fields[19]


class ReadOnlyProvider:
    def __init__(self):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib, Gio
        self.atspi = Atspi
        self.Gio = Gio
        # libatspi's default-context cache dispatch can synchronously query other
        # applications for seconds. Pump only our dedicated GDBus signal context.
        self.context = GLib.MainContext.new()
        self.changed = False
        self.changes = set()
        self.epoch = 0
        self.snapshots = SnapshotStore(self.identity, self.member)
        self.deadline = 0
        # Registration enables provider broadcasts. Its global libatspi callback
        # must not invalidate this window for unrelated application events.
        self.listener = Atspi.EventListener.new(lambda *_: None, None)
        Atspi.init()
        Atspi.set_timeout(250, 250)
        for event in ("object:children-changed", "object:state-changed",
                      "object:property-change", "object:text-changed"):
            if not self.listener.register(event):
                raise RuntimeError("Event observation unavailable")
        session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        address = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress",
            None, GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 500, None).unpack()[0]
        self.owner = None
        self.object_subscription = self.owner_subscription = None
        self.context.push_thread_default()
        try:
            self.events = Gio.DBusConnection.new_for_address_sync(address,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
        finally:
            self.context.pop_thread_default()

    def _event(self, connection, sender, path, interface, member, parameters, user_data):
        if sender == self.owner and member in ("ChildrenChanged", "StateChanged", "PropertyChange", "TextChanged", "BoundsChanged"):
            self.changes.add(member)
            self._changed()

    def _owner_event(self, connection, sender, path, interface, member, parameters, user_data):
        name, before, after = parameters.unpack()
        if self.owner is not None and self.owner in (name, before) and before != after:
            self._changed()

    def select_owner(self, owner):
        if owner == self.owner:
            return
        if self.owner is not None and owner != self.owner:
            self.snapshots.clear()
            self.epoch += 1
        self.owner = owner
        self.watch_owner(owner)

    def watch_owner(self, owner):
        for subscription in (self.object_subscription, self.owner_subscription):
            if subscription is not None:
                self.events.signal_unsubscribe(subscription)
        self.context.push_thread_default()
        try:
            self.object_subscription = self.events.signal_subscribe(owner, "org.a11y.atspi.Event.Object", None,
                None, None, self.Gio.DBusSignalFlags.NONE, self._event, None)
            self.owner_subscription = self.events.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus",
                "NameOwnerChanged", "/org/freedesktop/DBus", owner, self.Gio.DBusSignalFlags.NONE, self._owner_event, None)
        finally:
            self.context.pop_thread_default()

    def _changed(self, *args):
        self.changed = True
        self.epoch += 1

    def pump(self):
        # A flood must not turn event dispatch into an unbounded drain loop.
        for _ in range(16):
            if time.monotonic_ns() >= self.deadline:
                raise TimeoutError()
            if not self.context.pending():
                return
            self.context.iteration(False)
        if self.context.pending():
            self.changed = True

    def refresh(self, node):
        self.pump()
        preproof = getattr(self, "_qt_preproof", None)
        if preproof is not None:
            preproof.bind(self.identity(node)[1])
        application = node.get_application()
        if application is not None:
            application.set_cache_mask(self.atspi.Cache.NONE)
        node.clear_cache_single()

    def identity(self, node):
        app = node.app
        owner, path = app.bus_name, node.path
        if (type(owner) is not str or not re.fullmatch(r":[0-9]+\.[0-9]+", owner)
                or type(path) is not str or not re.fullmatch(r"(?:/[A-Za-z0-9_]+)+", path)):
            raise SnapshotError()
        return owner, path, self.pid

    def member(self, root, node):
        expected = self.identity(root)
        seen = set()
        for _ in range(64):
            self.refresh(node)
            if node.get_state_set().contains(self.atspi.StateType.DEFUNCT):
                return False
            current = self.identity(node)
            if current == expected:
                return True
            if current in seen:
                return False
            seen.add(current)
            node = node.get_parent()
            if node is None:
                return False
        return False

    def clear_preproof(self):
        proof = getattr(self, "_qt_preproof", None)
        self._qt_preproof = None
        if proof is not None:
            proof.close()

    def begin_qualification(self, app, frame, pid):
        self.clear_preproof()
        try:
            toolkit = app.get_toolkit_name()
        except Exception:
            return
        if toolkit == "Qt":
            try:
                from src.native.a11y_qt_identity import QtIdentity
                self._qt_preproof = QtIdentity(app, frame, None, self.identity, pid)
            except Exception:
                self._qt_preproof = None

    def qualify(self, app, frame, pairs, pid):
        try:
            toolkit = app.get_toolkit_name()
        except Exception:
            return None
        if toolkit == "Qt":
            proof = getattr(self, "_qt_preproof", None)
            if proof is None:
                return None
            try:
                proof.retain([node for node, _ in pairs], self.identity)
            except Exception:
                self.clear_preproof()
                raise SnapshotError() from None
            self._qt_preproof = None
            return proof
        try:
            from src.native.a11y_gtk_identity import GtkIdentity
            return GtkIdentity(app, frame, [node for node, _ in pairs], self.identity, pid)
        except Exception:
            return None

    def observe(self, target):
        self.clear_preproof()
        self.deadline = target["deadlineNs"]
        self.pid = target["pid"]
        self.pump()
        self.changed = False
        self.changes = set()
        generation = process_generation(target["pid"])
        selected = target.get("selection")
        binding = (target["pid"], generation, target["title"], selected["window"]) if selected else None
        if selected and ("root" in selected or "resolve" in selected):
            try:
                node, record, entry = self.snapshots.resolve(selected.get("root", selected.get("resolve")), binding, self.epoch,
                    mutation=selected.get("mutation", False))
                self.pump()
                if self.changed or self.epoch != entry.epoch:
                    raise SnapshotError()
                if "resolve" in selected:
                    if (process_generation(target["pid"]) != generation
                            or a11y_dump.clean(node.get_role_name(), 32) != record.get("role")
                            or "name" in record and a11y_dump.clean(node.get_name(), a11y_dump.NAME_LIMIT) != record["name"]):
                        raise SnapshotError()
                    self.pump()
                    if self.changed or self.epoch != entry.epoch:
                        raise SnapshotError()
                    resolved = {"status": "ok", "node": record, "mutationIdentity": entry.mutation_identity,
                                "toolkit": getattr(entry.proof, "toolkit", "")}
                    if selected.get("mutation") and entry.proof is not None:
                        proof = entry.proof
                        interfaces, action_count = [], 0
                        try:
                            raw = node.get_interfaces()
                            if raw is not None and len(raw) <= 64 and all(type(item) is str for item in raw):
                                interfaces = [item.rsplit(".", 1)[-1] for item in raw]
                            count = self.atspi.Action.get_n_actions(node) if "Action" in interfaces else 0
                            action_count = min(count, 64) if type(count) is int and count >= 0 else 0
                        except Exception:
                            pass
                        resolved["semanticTarget"] = proof.target(self.identity(node)[1])
                        resolved["interfaces"], resolved["actionCount"] = interfaces, action_count
                        self.pump()
                        if self.changed or self.epoch != entry.epoch or process_generation(target["pid"]) != generation:
                            raise SnapshotError()
                    self.snapshots.assert_current(entry)
                    return resolved
                self.begin_qualification(entry.root.get_application(), entry.root, target["pid"])
                origin = a11y_dump.box_of(entry.root, self.atspi)
                if origin is None:
                    raise SnapshotError()
                pairs, contexts = [], []
                def retained(native, item, context):
                    pairs.append((native, item))
                    contexts.append(context)
                index = int(REF.fullmatch(selected["root"])[2])
                initial = entry.contexts[index] if entry.contexts is not None else None
                nodes, stats = a11y_dump.walk(node, self.atspi, 300,
                    min(self.deadline / 1e9, time.monotonic() + 1.5), self.refresh,
                    retained, selected.get("skeleton", False), origin[:2], initial)
                self.pump()
                if self.changed or self.epoch != entry.epoch or process_generation(target["pid"]) != generation:
                    raise SnapshotError()
                self.snapshots.assert_current(entry)
                nodes, cut = trim_refs(nodes)
                pairs = pairs[:len(nodes)]
                if stats["truncated"] or cut:
                    self.clear_preproof()
                    return {"status": "ok", "nodes": nodes, "toolkit": "", "truncated": stats["truncated"] or cut,
                            "root": selected["root"], "refStatus": "not-published-incomplete", "ms": 0}
                # Publish only after bounded replacement is ready. Earlier snapshots survive failure.
                self.snapshots.assert_current(entry)
                proof = self.qualify(entry.root.get_application(), entry.root, pairs, target["pid"])
                try:
                    self.pump()
                    self.snapshots.assert_current(entry)
                    if self.changed or self.epoch != entry.epoch or process_generation(target["pid"]) != generation:
                        raise SnapshotError()
                except BaseException:
                    if proof is not None:
                        proof.close()
                    raise
                nodes, snapshot = self.snapshots.publish(binding, self.epoch, entry.root, pairs, walked_from_root=True,
                    proof=proof, mutation_identity=proof is not None, contexts=contexts[:len(nodes)])
                return {"status": "ok", "nodes": nodes, "toolkit": "", "truncated": stats["truncated"] or cut,
                        "snapshot": snapshot, "root": selected["root"], "ms": 0}
            except SnapshotError as error:
                self.clear_preproof()
                return {"status": "ref-error", "code": error.code}
        pairs, picked, contexts = [], [], []
        remaining_ms = max(1, (self.deadline - time.monotonic_ns()) // 1_000_000)
        budget = min(target["budgetMs"], remaining_ms)
        args = [str(target["pid"]), target["title"], str(target["maxNodes"]), str(budget)]
        def selection(app, frame):
            owner = self.identity(frame)[0]
            self.select_owner(owner)
            if selected:
                self.begin_qualification(app, frame, target["pid"])
            picked.append((app, frame))
        if selected:
            def retained(node, record, context):
                pairs.append((node, record))
                contexts.append(context)
            result = a11y_dump.main(args, refresh=self.refresh,
                retain=retained,
                selection=selection, skeleton=selected.get("skeleton", False))
        else:
            result = a11y_dump.main(args, refresh=self.refresh, selection=selection)
        self.pump()
        if self.changed or process_generation(target["pid"]) != generation:
            self.clear_preproof()
            detail = " (" + ",".join(sorted(self.changes)) + ")" if self.changes else ""
            return {"status": "unavailable", "reason": "accessibility changed during observation" + detail}
        if result.get("status") == "ok":
            result["nodes"], cut = trim_refs(result["nodes"]) if selected else _trim(result["nodes"])
            result["truncated"] = result.get("truncated") or cut
            if selected and picked:
                try:
                    pairs = pairs[:len(result["nodes"])]
                    proof = self.qualify(picked[0][0], picked[0][1], pairs, target["pid"])
                    records, snapshot = self.snapshots.publish(binding, self.epoch, picked[0][1], pairs,
                        mutation_identity=proof is not None, proof=proof, walked_from_root=True, contexts=contexts[:len(pairs)])
                    self.pump()
                    if self.changed:
                        raise SnapshotError()
                    result["nodes"], result["snapshot"] = records, snapshot
                except SnapshotError as error:
                    self.clear_preproof()
                    return {"status": "ref-error", "code": error.code}
        self.clear_preproof()
        return result


def serve(connection, generation, provider_factory=ReadOnlyProvider):
    if type(generation) is not str or not TOKEN.fullmatch(generation):
        raise ValueError("Invalid generation")
    provider = None
    connection.settimeout(60)  # Idle helpers exit, and the parent detects EOF on its next call.
    send(connection, {"protocol": PROTOCOL, "generation": generation, "kind": "ready"})
    try:
        while True:
            request = receive(connection)
            target = parse_request(request, generation)
            try:
                if provider is None:
                    provider = provider_factory()
                result = provider.observe(target)
                if time.monotonic_ns() >= target["deadlineNs"]:
                    raise TimeoutError()
            except Exception:
                result = {"status": "unavailable", "reason": "accessibility helper query failed"}
            send(connection, {"protocol": PROTOCOL, "generation": generation,
                              "requestId": request["requestId"], "ok": True, "result": result})
            gc.collect()
    except (EOFError, OSError, ValueError, UnicodeError):
        return
    finally:
        connection.close()


def main(argv):
    if len(argv) != 6 or set(argv[::2]) != {"--fd", "--expected-parent", "--generation"}:
        return 1
    arguments = dict(zip(argv[::2], argv[1::2]))
    descriptor, parent = int(arguments["--fd"]), int(arguments["--expected-parent"])
    arm_parent_death(parent)
    resource_limits()
    serve(socket.socket(fileno=descriptor), arguments["--generation"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(1)
