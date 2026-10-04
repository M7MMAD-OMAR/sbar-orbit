#!/usr/bin/python3
"""Private broker integration and source EOF supervision proof."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.lease import process_identity
from lab import guard
from cursor_cost_probe import loaded_plugin
from native_application_probe import wait
from native_view_probe import prove_view


def main():
    guard(os.environ)
    require_budget()
    here = Path(__file__).resolve()
    root = here.parents[2]
    evidence = here.with_name("evidence")
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    private = root / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="broker-cache-", dir=private) as cache, tempfile.TemporaryDirectory(prefix="native-broker-", dir=lab) as directory:
        work = Path(directory)
        prepared = inspect_host(os.environ)
        plugin_source = hashlib.sha256((here.parent / "plugin/ghostinput.cpp").read_bytes()).hexdigest()
        build = loaded_plugin(prepared["compositor"][0], plugin_source)
        (work / "host.json").write_text(json.dumps(prepared))
        with ActionControl(work / "control") as control, open(work / "broker.log", "xb") as log:
            child = subprocess.Popen([shutil.which("bun"), str(here.with_name("native_broker_fixture.ts")), str(work)],
                                     stdout=log, stderr=log, env=dict(os.environ, XDG_CACHE_HOME=cache))
            primary, failures = None, []
            try:
                wait(lambda: (work / "ready-for-full").exists() or child.poll() is not None, "Native broker protected phase")
                assert child.poll() is None, "Native broker failed before protected launch test"
                control.configure(mode="full")
                (work / "full-ready").write_text("ready")
                wait(lambda: (work / "native-view-visible").exists() or child.poll() is not None, "Public native GTK view")
                assert child.poll() is None, "Native broker failed before GTK viewing"
                from ghost import clients
                views = [value for value in clients() if value.get("title") == "Orbit native target"]
                assert len(views) == 1, "Native CLI did not map exactly one owned lab viewer"
                view = views[0]
                capture = evidence / "native-live-broker-view.png"
                with open(capture, "wb") as output:
                    subprocess.run(["/usr/bin/grim", "-T", view["stableId"], "-"], stdout=output, check=True, timeout=10)
                (work / "native-view-captured").write_text("ready")
                child.wait(timeout=60)
                assert child.returncode == 0, "Native broker integration failed"
                result = json.loads((work / "broker-result.json").read_text())
                for report in work.glob("app-*.json"):
                    state = json.loads(report.read_text())
                    assert all(process_identity(state[name][0]) != tuple(state[name]) for name in ("process", "child")), "Native broker left an owned process alive"
                frame = json.loads((work / "view-frame.json").read_text())
                result["native_view"] = prove_view([frame], work, evidence)
                assert control.inspect()["unresolved"] == []
                result["plugin"] = build
                result["source_sha256"] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in (
                    "src/session.ts", "src/ipc.ts", "src/hyprland.ts", "src/native-worker.ts", "src/native/session_worker.py",
                    "src/native-preview.ts", "src/cli.ts", "src/diagnostics.ts", "src/native/view.py",
                    "experiments/ghost-cursor/native_broker_fixture.ts", "experiments/ghost-cursor/native_broker_probe.py")}
            except BaseException as error:
                primary = error
            finally:
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        try: child.wait(timeout=3)
                        except BaseException as error: failures.append(error)
                log.flush()
                (evidence / f"native-broker-{os.getpid()}.log").write_bytes((work / "broker.log").read_bytes())
                diagnostics = work / "control/broker-logs"
                if diagnostics.exists():
                    destination = evidence / f"native-broker-{os.getpid()}-diagnostics"
                    shutil.copytree(diagnostics, destination)
            if primary is not None or failures:
                raise BaseExceptionGroup("Native broker proof or cleanup failed", ([primary] if primary else []) + failures)
        assert loaded_plugin(prepared["compositor"][0], plugin_source) == build
        print(json.dumps(result))


if __name__ == "__main__":
    main()
