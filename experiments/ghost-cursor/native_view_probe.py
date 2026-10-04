#!/usr/bin/python3
"""Actual GTK view of supplied native session frames, private lab only."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

from ghost import hypr
from lab import guard
from native_application_probe import wait


def prove_view(frames, directory, evidence):
    guard(os.environ)
    root = Path(__file__).resolve().parents[2]
    log = open(directory / "view.log", "xb")
    child = subprocess.Popen(["/usr/bin/python3", str(root / "src/native/view.py"), "--acknowledgements"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                             env=dict(os.environ))
    primary, cleanup = None, []
    captures = []
    try:
        def mapped():
            return [window for window in json.loads(hypr("j/clients")) if window["pid"] == child.pid]
        wait(mapped, "Native GTK viewer did not map")
        window = mapped()[0]
        for index, frame in enumerate(frames):
            child.stdin.write(json.dumps(frame).encode() + b"\n")
            child.stdin.flush()
            with selectors.DefaultSelector() as ready:
                ready.register(child.stdout, selectors.EVENT_READ)
                assert ready.select(10), "Native viewer did not acknowledge a draw"
            reply = json.loads(child.stdout.readline(1024))
            assert reply["rendered"] and reply["pointer"] == [frame["pointer"]["x"], frame["pointer"]["y"]]
            # Wait for the compositor to commit the GTK draw, then capture only this private window.
            time.sleep(.1)
            capture = subprocess.run(["/usr/bin/grim", "-T", window["stableId"], "-"],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
            captures.append(capture.stdout)
            (evidence / f"native-view-{index}.png").write_bytes(capture.stdout)
        assert len(set(captures)) == len(frames), "Native view did not visibly update"
        child.stdin.close()
        child.wait(timeout=5)
        assert child.returncode == 0, "Native viewer failed on source EOF"
        child.stdout.close()
        child = subprocess.Popen(["/usr/bin/python3", str(root / "src/native/view.py"), "--acknowledgements"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                 env=dict(os.environ))
        child.stdin.write(json.dumps(frames[-1]).encode() + b"\n")
        child.stdin.close()
        child.wait(timeout=10)
        reply = json.loads(child.stdout.readline(1024))
        assert reply["rendered"] and child.returncode == 0, "Immediate EOF discarded the final GTK draw"
    except BaseException as error:
        primary = error
    finally:
        try:
            if not child.stdin.closed:
                child.stdin.close()
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
        except BaseException as error:
            cleanup.append(error)
        child.stdout.close()
        log.close()
        (evidence / f"native-view-{os.getpid()}.log").write_bytes((directory / "view.log").read_bytes())
    if primary is not None or cleanup:
        raise BaseExceptionGroup("Native view proof or cleanup failed", ([primary] if primary else []) + cleanup)
    return {"frames": len(captures), "source_eof_exit": child.returncode, "immediate_eof_draw": True,
            "owner_activation": "not performed", "comparative_performance": "not measured"}
