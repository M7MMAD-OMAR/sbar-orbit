"""Private two-phase semantic dispatch. Preparation never mutates an application."""
import copy
import hashlib
import json
import math
import re
import time
import uuid

from .budget import require_budget
from .host import verify_host
from .transport import action_request, action_response

KINDS = frozenset({"invoke-ref", "edit-ref", "value-ref", "ref-click"})


class SemanticError(RuntimeError):
    def __init__(self, code="SEMANTIC_UNKNOWN", delivery="unknown"):
        self.code = code if code in {"SEMANTIC_UNKNOWN", "SEMANTIC_NOT_DELIVERED", "SEMANTIC_UNSUPPORTED", "SEMANTIC_PREPARATION_REQUIRED"} else "SEMANTIC_UNKNOWN"
        self.delivery = delivery if delivery in {"not-delivered", "unknown", "delivered"} else "unknown"
        super().__init__(self.code + ": inspect the exact target before choosing another action; no fallback was attempted")


def digest(action):
    return hashlib.sha256(json.dumps(action, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def control_request(action):
    # The exact original normalized public action, including text/value, is bound
    # without putting text or private provider routing into the owner journal.
    return "native-semantic " + digest(action)


class SemanticActions:
    def __init__(self, session):
        self.session = session
        self.entries = {}

    def _prune(self):
        now = time.monotonic()
        for token, entry in list(self.entries.items()):
            if not entry["consumed"] and now >= entry["deadline"]:
                self.cancel(token)
            if entry["consumed"] and now - entry["created"] > 60:
                del self.entries[token]

    def _resolve(self, action, deadline):
        session = self.session
        if session.closed:
            raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
        target = session._target(action["appId"], action["windowId"])
        resolved = session._tree(target, deadline=deadline, selection={"resolve": action["ref"], "mutation": True})
        if not isinstance(resolved, dict) or resolved.get("status") != "ok" or resolved.get("mutationIdentity") is not True:
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        proof = resolved.get("semanticTarget")
        if (not isinstance(proof, dict) or set(proof) != {"owner", "path", "address", "busId", "pid"}
                or type(proof["owner"]) is not str or not re.fullmatch(r":[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", proof["owner"])
                or type(proof["path"]) is not str or not re.fullmatch(r"/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+", proof["path"])
                or type(proof["address"]) is not str or not proof["address"].startswith(("unix:path=", "unix:abstract="))
                or len(proof["address"].encode()) > 1024 or "\0" in proof["address"]
                or type(proof["busId"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", proof["busId"])
                or type(proof["pid"]) is not int or not 0 < proof["pid"] <= 2147483647):
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        required = {"invoke-ref": "Action", "edit-ref": "EditableText", "value-ref": "Value"}.get(action["type"])
        interfaces = resolved.get("interfaces")
        if required is not None and (not isinstance(interfaces, list) or required not in interfaces):
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        if action["type"] == "invoke-ref":
            count = resolved.get("actionCount")
            if type(count) is not int or not 0 <= action["index"] < count <= 64:
                raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        box = resolved.get("node", {}).get("box")
        if (not isinstance(box, list) or len(box) != 4
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in box)
                or box[2] <= 0 or box[3] <= 0):
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        point = (box[0] + box[2] / 2, box[1] + box[3] / 2)
        if not 0 <= point[0] < target["size"][0] or not 0 <= point[1] < target["size"][1]:
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        guarded = target["address"] + "@" + target["key"][1] + "@" + session._app(action["appId"]).unit
        return guarded, copy.deepcopy(proof), point

    def _plugin(self, command, token, deadline):
        require_budget()
        value = json.loads(action_response(action_request(command), self.session.transport._exchange(command, deadline=deadline)))
        if value.get("requestId") != token:
            raise SemanticError()
        return value

    def prepare(self, value):
        require_budget()
        action = self.session.parse(value)
        if action["type"] not in KINDS:
            raise SemanticError("SEMANTIC_UNSUPPORTED", "not-delivered")
        self._prune()
        if len(self.entries) >= 64 or sum(not entry["consumed"] for entry in self.entries.values()) >= 8:
            raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
        deadline = time.monotonic() + (5 if action["type"] == "ref-click" else 3)
        guarded, proof, point = self._resolve(action, deadline)
        source_point = point
        if action["type"] == "ref-click":
            target = self.session._target(action["appId"], action["windowId"])
            pointer = self.session._reference_point(action, target, guarded, deadline=deadline)
            token = uuid.uuid4().hex
            self.entries[token] = {"digest": digest(action), "guarded": guarded, "proof": proof, "point": pointer["point"],
                "surface": pointer["surface"], "geometry": pointer["geometry"],
                "source_point": source_point, "pointer": True, "created": time.monotonic(), "deadline": deadline,
                "consumed": False, "result": None, "error": None}
            return {"token": token}
        verb = {"invoke-ref": "invoke", "edit-ref": "edit", "value-ref": "value"}[action["type"]]
        payload = str(action["index"]) if verb == "invoke" else action["text"] if verb == "edit" else repr(action["value"])
        token = uuid.uuid4().hex
        command = " ".join(("ghost-semantic-prepare", guarded, token, proof["owner"], proof["path"], proof["address"].encode().hex(),
                            proof["busId"], str(proof["pid"]), verb, payload.encode().hex() or "-", str(point[0]), str(point[1])))
        entry = {"digest": digest(action), "guarded": guarded, "proof": proof, "point": point, "created": time.monotonic(),
                 "source_point": source_point, "pointer": False, "deadline": deadline, "consumed": False, "result": None, "error": None}
        self.entries[token] = entry
        try:
            receipt = self._plugin(command, token, deadline)
            while receipt["state"] == "preparing" and time.monotonic() < deadline:
                time.sleep(min(0.01, max(0, deadline - time.monotonic())))
                receipt = self._plugin("ghost-semantic-status " + guarded + " " + token, token, deadline)
            if receipt["state"] != "ready":
                raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
            return {"token": token}
        except BaseException:
            self.cancel(token)
            raise

    def cancel(self, token):
        entry = self.entries.get(token)
        if entry is None or entry["consumed"]:
            return {"cancelled": False}
        entry["consumed"] = True
        entry["error"] = ("SEMANTIC_NOT_DELIVERED", "not-delivered")
        if entry["pointer"]:
            return {"cancelled": True}
        try:
            self._plugin("ghost-semantic-cancel " + entry["guarded"] + " " + token, token, time.monotonic() + 0.3)
        except Exception:
            # The bounded read-only preparation expires in the compositor. It
            # cannot dispatch a mutation without a separate final SEND.
            pass
        return {"cancelled": True}

    def close(self):
        for token in list(self.entries):
            self.cancel(token)

    def send(self, token, value):
        require_budget()
        action = self.session.parse(value)
        if type(token) is not str or not re.fullmatch(r"[0-9a-f]{32}", token):
            raise SemanticError("SEMANTIC_PREPARATION_REQUIRED", "not-delivered")
        entry = self.entries.get(token)
        if entry is None or entry["digest"] != digest(action):
            raise SemanticError("SEMANTIC_PREPARATION_REQUIRED", "not-delivered")
        if entry["consumed"]:
            if entry["error"] is not None:
                raise SemanticError(*entry["error"])
            return entry["result"]
        entry["consumed"] = True
        try:
            deadline = entry["deadline"]
            guarded, proof, point = self._resolve(action, deadline)
            if guarded != entry["guarded"] or proof != entry["proof"] or point != entry["source_point"] or time.monotonic() >= deadline:
                raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
            def dispatch():
                verify_host(self.session.plan, deadline=deadline)
                current = self.session._target(action["appId"], action["windowId"])
                if current["address"] + "@" + current["key"][1] + "@" + self.session._app(action["appId"]).unit != guarded:
                    raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
                if entry["pointer"]:
                    x, y = entry["point"]
                    geometry = self.session._geometry(guarded)
                    if (tuple(current["size"]) != entry["surface"] or geometry != entry["geometry"]
                            or not 0 <= x < current["size"][0] or not 0 <= y < current["size"][1]
                            or time.monotonic() >= deadline):
                        raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
                    button = {"left": 1, "right": 2, "middle": 3}[action["button"]]
                    try:
                        command = f"ghost-click {guarded} {x} {y} {button}"
                        # A ref must not reuse coordinates after an owner-paused
                        # refusal, so do not enter the ordinary retrying transport.
                        response = action_response(action_request(command),
                            self.session.transport._exchange(command, deadline=deadline))
                        self.session._await_drag(guarded)
                    except Exception as error:
                        raise SemanticError() from error
                    current["pointer"] = {"x": x, "y": y}
                    return {"response": response}
                try:
                    receipt = self._plugin("ghost-semantic-send " + guarded + " " + token, token, deadline)
                    while receipt["state"] == "pending" and time.monotonic() < deadline:
                        time.sleep(min(0.01, max(0, deadline - time.monotonic())))
                        receipt = self._plugin("ghost-semantic-status " + guarded + " " + token, token, deadline)
                except SemanticError:
                    raise
                except Exception as error:
                    # SEND may already have reached the application. A lost
                    # status reply cannot become a retryable transport error.
                    raise SemanticError() from error
                if receipt["state"] != "settled" or receipt["delivery"] == "unknown":
                    raise SemanticError()
                if receipt["delivery"] != "delivered":
                    raise SemanticError("SEMANTIC_NOT_DELIVERED", "not-delivered")
                return {"semantic": {"delivery": "delivered", "accepted": receipt["accepted"],
                                     "outcome": "accepted" if receipt["accepted"] else "refused"}}
            entry["result"] = self.session.control.execute(control_request(action), dispatch)
            return entry["result"]
        except BaseException as error:
            entry["error"] = (error.code, error.delivery) if isinstance(error, SemanticError) else ("SEMANTIC_UNKNOWN", "unknown")
            # Best-effort close of an outstanding response; never another SEND.
            if not entry["pointer"]:
                try:
                    self._plugin("ghost-semantic-cancel " + entry["guarded"] + " " + token, token, time.monotonic() + 0.3)
                except Exception:
                    pass
            raise


def for_session(session):
    manager = getattr(session, "_semantic_actions", None)
    if manager is None:
        manager = session._semantic_actions = SemanticActions(session)
    return manager
