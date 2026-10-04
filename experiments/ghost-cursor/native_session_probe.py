#!/usr/bin/python3
"""Private end-to-end native session worker routing and target capture proof."""
import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.host import HostError
from src.native.lease import process_identity, NativeLease
from src.native.transport import NativeTransport
from lab import guard
from harness import StandIn
from ghost import hypr
from native_application_probe import wait
from native_pre_map_probe import adopt
from cursor_cost_probe import loaded_plugin


class Worker:
    def __init__(self, directory, control, plan):
        self.directory = directory
        directory.mkdir(mode=0o700)
        self.log = open(directory / "worker.log", "xb")
        entry = ["/usr/bin/python3", str(Path(__file__).resolve().parents[2] / "src/native/session_worker.py")]
        if "--unchecked-capture" in sys.argv:
            # Deliberately omit compositor registration checks as a negative control.
            root = str(Path(__file__).resolve().parents[2])
            code = (f"import sys; sys.path.insert(0,{root!r}); from pathlib import Path; "
                    "from src.native.session_worker import main; from src.native.session import NativeSession; "
                    "NativeSession._check_target=lambda self,address:None; "
                    "main(*(Path(value) for value in sys.argv[1:]))")
            entry = ["/usr/bin/python3", "-c", code]
        self.child = subprocess.Popen([*entry, str(directory), str(control.directory), str(plan)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                                      env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    def request(self, method, params, request_id=None):
        request_id = uuid.uuid4().hex if request_id is None else request_id
        self.child.stdin.write(json.dumps({"requestId": request_id, "method": method, "params": params}).encode() + b"\n")
        self.child.stdin.flush()
        with selectors.DefaultSelector() as ready:
            ready.register(self.child.stdout, selectors.EVENT_READ)
            if not ready.select(20):
                raise TimeoutError("Native worker did not answer")
        reply = json.loads(self.child.stdout.readline(24 * 1024 * 1024))
        assert reply["requestId"] == request_id
        return reply
    def close(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            self.child.wait(timeout=15)
        self.child.stdout.close()
        self.log.close()
        assert self.child.returncode == 0, "Native worker failed during cleanup"


def main():
    guard(os.environ)
    require_budget()
    here = Path(__file__).resolve()
    evidence = here.with_name("evidence")
    workers, person, identities = [], None, set()
    errors, checks = [], []
    primary = None
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    with tempfile.TemporaryDirectory(prefix="session-", dir=lab) as work:
        work = Path(work)
        with ActionControl(work / "control") as control:
            try:
                person = StandIn()
                owner = person.wait_mapped()
                assert hypr("dispatch focuswindow address:" + owner["address"]).strip() == "ok"
                time.sleep(0.2)
                with person.lock:
                    event_start = len(person.events)
                    owner_text = person.states[-1]["text"]
                plan = work / "host.json"
                prepared = inspect_host(os.environ)
                plugin_source = hashlib.sha256((here.parent / "plugin/ghostinput.cpp").read_bytes()).hexdigest()
                build = loaded_plugin(prepared["compositor"][0], plugin_source)
                plan.write_text(json.dumps(prepared))
                probe_transport = NativeTransport(prepared)
                workers = [Worker(work / ("worker-" + str(index)), control, plan) for index in range(2)]
                argv = ["/usr/bin/python3", str(here.with_name("native_application_probe.py")), "--fixture", str(work / "fixture-0.json")]
                denied = workers[0].request("launch", {"argv": argv})
                assert not denied["ok"] and denied["error"]["code"] == "APPROVAL_REQUIRED"
                assert not list(work.glob("worker-*/native-app-*")), "Denied launch created a profile"
                checks.append("protected worker launch denial before resources")
                control.configure(mode="full")
                apps, targets = [], []
                for index, worker in enumerate(workers):
                    report = work / f"fixture-{index}.json"
                    argv[-1] = str(report)
                    reply = worker.request("launch", {"argv": list(argv)})
                    assert reply["ok"], reply
                    apps.append(reply["result"])
                    wait(report.exists, "Native worker fixture report")
                    state = json.loads(report.read_text())
                    identities.update(tuple(state[name]) for name in ("process", "child"))
                    deadline = time.monotonic() + 6
                    while True:
                        reply = worker.request("act", {"type": "windows", "appId": apps[index]["appId"]})
                        assert reply["ok"], reply
                        windows = reply["result"]["windows"]
                        if windows:
                            break
                        assert time.monotonic() < deadline, "Native target did not map"
                        time.sleep(0.02)
                    assert len(windows) == 1
                    targets.append({"appId": apps[index]["appId"], "windowId": windows[0]["windowId"]})
                checks.append("two persistent workers expose only their own generated target handles")
                assert not workers[0].request("act", {"type": "state", **targets[1]})["ok"]
                assert not workers[0].request("act", {"type": "state", "appId": targets[0]["appId"], "windowId": targets[1]["windowId"]})["ok"]
                checks.append("foreign application and foreign window handles refused")
                before = workers[0].request("act", {"type": "observe", **targets[0]})
                assert before["ok"], before
                for index, worker in enumerate(workers):
                    target = targets[index]
                    for action in ({"type": "cursor", "x": 40, "y": 30},
                                   {"type": "click", "x": 40, "y": 30},
                                   {"type": "text", "text": f"Native session {index}"}):
                        reply = worker.request("act", {**target, **action})
                        assert reply["ok"], reply
                for index in range(2):
                    wait(lambda index=index: json.loads((work / f"fixture-{index}.json").read_text())["text"] == f"Native session {index}", "Native worker text readback")
                checks.append("both guarded cursor click and text actions reach their explicit targets")
                after = workers[0].request("act", {"type": "observe", **targets[0]})
                assert after["ok"] and after["result"]["image"] != before["result"]["image"]
                assert after["result"]["pointer"] == {"x": 40, "y": 30}
                assert not any("image" in event.get("result", {}) for event in control.inspect()["events"])
                capture = base64.b64decode(after["result"]["image"])
                (evidence / "native-session-target.png").write_bytes(capture)
                checks.append("fresh target-only PNG changes after input and image bytes stay out of journal")
                request_id = uuid.uuid4().hex
                value = {"type": "text", "text": " once", **targets[0]}
                first = workers[0].request("act", value, request_id)
                assert first == workers[0].request("act", value, request_id)
                conflict = workers[0].request("act", {**value, "text": "twice"}, request_id)
                assert not conflict["ok"] and conflict["error"]["code"] == "REQUEST_CONFLICT"
                wait(lambda: json.loads((work / "fixture-0.json").read_text())["text"] == "Native session 0 once", "Deduplicated native action readback")
                checks.append("uncertain request replay does not repeat text and conflicting identity refused")
                state = json.loads((work / "fixture-1.json").read_text())
                pid = state["process"][0]
                clients = json.loads(hypr("j/clients"))
                mapped = next(client for client in clients if client["pid"] == pid)
                guarded = mapped["address"] + "@" + mapped["stableId"] + "@" + apps[1]["unit"]
                def refuse_guard(request):
                    try:
                        probe_transport.execute(request, control)
                    except HostError:
                        return
                    raise AssertionError("Compositor accepted an invalid guarded target")
                refuse_guard("ghost-target-check " + mapped["address"] + "@0@" + apps[1]["unit"])
                refuse_guard("ghost-target-check " + mapped["address"] + "@" + mapped["stableId"] + "@" + apps[0]["unit"])
                checks.append("compositor rejects wrong stable identity and wrong native scope")
                migrated = "orbit-native-" + uuid.uuid4().hex + ".scope"
                adopt(migrated, pid)
                refuse_guard("ghost-target-check " + guarded)
                destination = NativeLease(apps[1]["unit"])
                destination.verify()
                group_fd = os.open(destination.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(group_fd)
                    assert (info.st_dev, info.st_ino) == destination.directory_identity
                    descriptor = os.open("cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group_fd)
                    try:
                        os.write(descriptor, str(pid).encode())
                    finally:
                        os.close(descriptor)
                finally:
                    os.close(group_fd)
                destination.verify()
                assert destination.contains(tuple(state["process"]))
                capture_logs = list(work.glob("worker-1/native-app-*/capture-*.log"))
                revoked = workers[1].request("act", {"type": "observe", **targets[1]})
                assert not revoked["ok"], "Sticky registration revocation did not block capture"
                assert list(work.glob("worker-1/native-app-*/capture-*.log")) == capture_logs
                checks.append("migration and return cannot revive capture after sticky registration revocation")
                assert not workers[0].request("configure", {"mode": "full"})["ok"]
                control.configure(mode="protected")
                assert not workers[0].request("act", {"type": "text", "text": "denied", **targets[0]})["ok"]
                workers[0].close()
                state = json.loads((work / "fixture-0.json").read_text())
                assert all(process_identity(state[name][0]) != tuple(state[name]) for name in ("process", "child"))
                state = json.loads((work / "fixture-1.json").read_text())
                assert process_identity(state["process"][0]) == tuple(state["process"])
                checks.append("protected parent EOF cleans one worker tree and preserves its sibling")
                assert control.inspect()["unresolved"] == []
                with person.lock:
                    events = person.events[event_start:]
                    assert not [event for event in events if event[0] == "wl_keyboard" and event[1] in ("enter", "leave")], events
                    assert person.states[-1]["text"] == owner_text
                assert json.loads(hypr("j/activewindow"))["address"] == owner["address"]
                checks.append("stand-in text and keyboard focus preserved")
            except BaseException as error:
                primary = error
            finally:
                for worker in reversed(workers):
                    try:
                        worker.close()
                    except BaseException as error:
                        errors.append(error)
                if person is not None:
                    try:
                        person.stop()
                        person.p.wait(timeout=3)
                    except BaseException as error:
                        errors.append(error)
                for log in work.glob("worker-*/worker.log"):
                    try:
                        (evidence / f"session-{log.parent.name}-{os.getpid()}.log").write_bytes(log.read_bytes())
                    except BaseException as error:
                        errors.append(error)
    if any(process_identity(pid) == identity for identity in identities for pid in [identity[0]]):
        errors.append(RuntimeError("Native worker cleanup left a recorded process alive"))
    if primary is not None or errors:
        raise BaseExceptionGroup("Native session proof or cleanup failed", ([primary] if primary else []) + errors)
    root = here.parents[2]
    sources = {name: hashlib.sha256((root / "src/native" / name).read_bytes()).hexdigest()
               for name in ("session.py", "session_worker.py", "application.py", "transport.py")}
    assert loaded_plugin(prepared["compositor"][0], plugin_source) == build
    print(json.dumps({"checks": checks, "source_sha256": sources, "plugin": build, "owner_activation": "not performed",
                      "whole_system_invariants": "not measured", "comparative_performance": "not measured"}))


if __name__ == "__main__":
    main()
