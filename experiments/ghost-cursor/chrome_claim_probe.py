#!/usr/bin/python3
"""Claim a real Chrome client inside the nested lab, with clipboard watchers present.

Run only inside a lab: lab.py run LAB -- /usr/bin/python3 chrome_claim_probe.py PLUGIN.so OUTPUT.json
The 6 October 2026 owner crash happened during exactly this claim. The probe loads the given
plugin build into the lab's own Hyprland, starts data-control clipboard watchers and ends one of
them, opens Chrome on a workspace that does not hold focus, then claims it. The JSON records
whether the lab compositor survived. It never touches the person's session: lab.guard refuses an
environment that is not a lab.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

from lab import guard


def hyprctl(*args, timeout=10):
    return subprocess.run(["hyprctl", *args], capture_output=True, text=True, timeout=timeout, check=False)


def alive():
    try:
        return hyprctl("version", timeout=5).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def clients():
    result = hyprctl("-j", "clients")
    return json.loads(result.stdout) if result.returncode == 0 else []


def main():
    guard(os.environ)
    plugin, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    report = {"plugin": str(plugin), "state": "not measured", "events": []}
    events = report["events"]
    children = []
    try:
        # The lab has no input devices, so without the person's private virtual pointer the seat has
        # no pointer capability and Chrome binds no wl_pointer. It is left running for the lease probe;
        # lab.py down ends it with the lab.
        pointer = Path(__file__).resolve().parent / "plugin/.deps/person-pointer"
        if pointer.is_file():
            subprocess.Popen([str(pointer), "400", "300", "1920", "1200", "hold"], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            time.sleep(1)
            events.append("person pointer parked")
        loaded = hyprctl("plugin", "load", str(plugin), timeout=30)
        events.append(f"plugin load: {loaded.stdout.strip()[:200]}")
        build = hyprctl("ghost-build-info")
        report["build"] = build.stdout.strip()[:400]
        for _ in range(3):
            children.append(subprocess.Popen(["wl-paste", "--watch", "cat"], stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL))
        time.sleep(1)
        children[0].terminate()
        children[0].wait(timeout=5)
        events.append("three clipboard watchers started, one ended")
        home = Path(os.environ["HOME"])
        chrome = shutil.which("google-chrome") or shutil.which("chromium-browser")
        if not chrome:
            raise RuntimeError("No Chrome binary in the lab")
        argv = (f"{chrome} --ozone-platform=wayland --user-data-dir={home / 'chrome'} --no-first-run "
                "--no-default-browser-check --disable-gpu --password-store=basic about:blank")
        hyprctl("dispatch", "exec", f"[workspace 2 silent] {argv}")
        window = None
        for _ in range(300):
            window = next((c for c in clients() if "chrome" in str(c.get("class", "")).lower()), None)
            if window:
                break
            time.sleep(0.1)
        if not window:
            raise RuntimeError("Chrome window did not appear")
        time.sleep(2)
        events.append(f"chrome on workspace {window['workspace']['id']}")
        lease = uuid.uuid4().hex
        claim = hyprctl("ghost-application-claim", window["address"], window["stableId"], lease, timeout=15)
        report["claim"] = claim.stdout.strip()[:400]
        time.sleep(2)
        report["compositorAlive"] = alive()
        if report["compositorAlive"]:
            report["state"] = "claimed" if '"status":"claimed"' in claim.stdout.replace(" ", "") else "refused"
            info = hyprctl("ghost-application-info", lease)
            report["info"] = info.stdout.strip()[:400]
        else:
            report["state"] = "compositor ended during claim"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        report["compositorAlive"] = alive()
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"state": report["state"], "compositorAlive": report.get("compositorAlive")}))


if __name__ == "__main__":
    main()
