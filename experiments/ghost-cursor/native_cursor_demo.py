#!/usr/bin/python3
"""Record a measured visible native lab demo, with two independent actors."""
import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from PIL import Image
from lab import guard
from ghost import window_for
from harness import StandIn, Pointer, Events, snapshot, judge_events, client_events, hj, hypr

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
pids = [int(v) for v in sys.argv[1:3]]
assert len(pids) == 2
windows = [window_for(pid) for pid in pids]
assert all(w["workspace"]["name"] == "special:ghost" for w in windows)


def dispatch(value):
    result = hypr("dispatch " + value).strip()
    assert result == "ok", (value, result)


for c in hj("clients"):
    if c["workspace"]["name"] == "special:ghost" and c["pid"] not in pids:
        dispatch("movetoworkspacesilent special:archive,address:" + c["address"])
for w, pos in zip(windows, [(30, 150), (900, 20)]):
    dispatch(f"movewindowpixel exact {pos[0]} {pos[1]},address:{w['address']}")
person = StandIn()
frames = []
record_errors = []
record_stop = threading.Event()
ptr, events = None, None
actors = []
typist = None


def capture_loop():
    try:
        while not record_stop.is_set():
            data = subprocess.check_output(["grim", "-"], timeout=10)
            frames.append((time.monotonic(), data))
            record_stop.wait(0.2)
    except Exception as error:
        record_errors.append(repr(error))


def measured_snapshot():
    value = snapshot("special:ghost")
    # The visible demo deliberately places the simulated person on the same
    # workspace. Include its window explicitly so no owner geometry is omitted.
    c = person.window()
    assert c
    value["windows"][c["address"]] = {k: c.get(k) for k in (
        "at", "size", "workspace", "hidden", "mapped", "fullscreen", "pinned",
        "floating", "monitor", "focusHistoryID", "class", "title")}
    return value


try:
    c = person.wait_mapped()
    address = c["address"]
    dispatch("movetoworkspacesilent special:ghost,address:" + address)
    dispatch("setfloating address:" + address)
    dispatch("resizewindowpixel exact 600 180,address:" + address)
    dispatch("movewindowpixel exact 650 1000,address:" + address)
    if not hj("monitors")[0]["specialWorkspace"]["name"]:
        dispatch("togglespecialworkspace ghost")
    dispatch("focuswindow address:" + address)
    dispatch("movecursor 950 1080")
    time.sleep(0.5)
    assert hj("monitors")[0]["specialWorkspace"]["name"] == "special:ghost"
    before = measured_snapshot()
    with person.lock:
        before_text = person.states[-1]["text"]
        state_offset, event_offset = len(person.states), len(person.events)
        group = next((args.split(",")[-1].strip() for interface, event, args in reversed(person.events)
                      if interface == "wl_keyboard" and event == "modifiers"), "0")
    ptr, events = Pointer(), Events()
    ptr.start()
    events.start()
    recorder = threading.Thread(target=capture_loop)
    recorder.start()
    typed = "person keeps typing 0123456789 " * 10
    typist = subprocess.Popen(["wtype", "-d", "12", typed])
    commands = [["/usr/bin/python3", str(root / "qt_task.py"), str(pids[0])],
                ["/usr/bin/python3", str(root / "writer_task.py"), str(pids[1])]]
    started = []
    for command in commands:
        started.append(time.monotonic())
        actors.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       env=dict(os.environ, ORBIT_WRITER_CHUNK="16")))
    concurrent_seen = all(p.poll() is None for p in actors)
    results = []
    for command, process, start in zip(commands, actors, started):
        stdout, stderr = process.communicate(timeout=30)
        results.append({"command": command, "exit": process.returncode, "started": start,
                        "finished": time.monotonic(), "stdout": stdout.decode(), "stderr": stderr.decode()})
    typist.wait(timeout=10)
    time.sleep(0.5)
    record_stop.set()
    recorder.join(timeout=12)
    assert not recorder.is_alive()
    ptr.stop = events.stop = True
    ptr.join()
    events.join()
    after = measured_snapshot()
    with person.lock:
        received = list(person.events[event_offset:])
        states = list(person.states[state_offset:])
    final = states[-1]
    positions = sorted(set(ptr.samples))
    violations, noise = judge_events(events.lines, before["active"].removeprefix("0x"),
                                    set(before["windows"]), "special:ghost")
    focus_events = client_events(received, group)
    overlap = min(r["finished"] for r in results) - max(r["started"] for r in results)
    report = {"scope": "Visible private lab; not owner-session acceptance",
              "actors": results, "actor_overlap_seconds": overlap, "concurrent_processes_seen": concurrent_seen,
              "B1": {"pass": len(positions) == 1, "positions": positions, "samples": len(ptr.samples)},
              "B2": {"pass": not focus_events, "events": focus_events},
              "B3": {"pass": final["text"] == before_text + typed
                     and all(s["selection"][0] == s["selection"][1] for s in states),
                     "expected": typed, "received": final["text"]},
              "B4": {"pass": before == after and not violations, "events": violations,
                     "noise": noise, "changed": [k for k in before if before[k] != after[k]]},
              "recording": {"frames": len(frames), "errors": record_errors}}
    report["pass"] = all(report[k]["pass"] for k in ("B1", "B2", "B3", "B4")) and \
        all(r["exit"] == 0 for r in results) and concurrent_seen and overlap > 0 and len(frames) >= 5 and not record_errors
    (lab / "native-cursor-demo-report.json").write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n")
    if frames:
        images = [Image.open(io.BytesIO(data)).convert("RGB") for _, data in frames]
        durations = [max(1, round((frames[i + 1][0] - frames[i][0]) * 1000))
                     for i in range(len(frames) - 1)] + [200]
        unique, unique_durations = [], []
        previous_pixels = None
        for original, duration in zip(images, durations):
            pixels = original.tobytes()
            if pixels == previous_pixels:
                unique_durations[-1] += duration
            else:
                unique.append(original)
                unique_durations.append(duration)
            previous_pixels = pixels
        images, durations = unique, unique_durations
        output = lab / "native-cursor-demo.png"
        images[0].save(output, save_all=True, append_images=images[1:], duration=durations, loop=0)
        with Image.open(output) as saved:
            assert saved.n_frames == len(images)
            for index, original in enumerate(images):
                saved.seek(index)
                assert saved.convert("RGB").tobytes() == original.tobytes(), index
        report["recording"]["path"] = str(output)
        report["recording"]["pixels_preserved"] = True
        report["recording"]["encoded_frames"] = len(images)
    (lab / "native-cursor-demo-report.json").write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("pass", "actor_overlap_seconds", "B1", "B2", "B3", "B4", "recording")}, ensure_ascii=True))
    sys.exit(0 if report["pass"] else 1)
finally:
    record_stop.set()
    if ptr:
        ptr.stop = True
    if events:
        events.stop = True
    for process in actors:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    if typist and typist.poll() is None:
        typist.terminate()
        typist.wait(timeout=5)
    person.stop()
    if hj("monitors")[0]["specialWorkspace"]["name"] == "special:ghost":
        dispatch("togglespecialworkspace ghost")
