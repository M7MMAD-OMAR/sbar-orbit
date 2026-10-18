#!/usr/bin/python3
"""Drive a claimed real Chrome inside the nested lab while a person window keeps focus.

Run only inside a lab, after chrome_claim_probe.py claimed Chrome with the corrected plugin:
    lab.py run LAB -- /usr/bin/python3 chrome_lease_probe.py LEASE_ID OUTPUT.json
It opens a person window on workspace 1 and focuses it, records the seat focus and pointer, then
shows the agent cursor on Chrome, clicks, and types a page title through Orbit's own prepared
keyboard path. It measures that Chrome received the input, that the person's focus and pointer
did not move, and that handback releases the lease with both clients and the compositor alive.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from lab import guard

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.keyboard import prepared_input

TITLE = "orbit-agent-typed"


def hyprctl(*args, timeout=10):
    return subprocess.run(["hyprctl", *args], capture_output=True, text=True, timeout=timeout, check=False)


def j(*args):
    result = hyprctl("-j", *args)
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else {}


def exchange(command, deadline):
    return hyprctl(*command.split(" ", 1)[0:1], *command.split(" ")[1:], timeout=max(1, deadline - time.monotonic())).stdout.strip()


def seat():
    return {"active": j("activewindow").get("address"), "cursor": j("cursorpos")}


def main():
    guard(os.environ)
    lease, output = sys.argv[1], Path(sys.argv[2])
    report = {"lease": lease, "state": "not measured", "steps": {}}
    steps = report["steps"]
    try:
        info = json.loads(hyprctl("ghost-application-info", lease).stdout)
        target = info["windows"][0]["target"]
        chrome = info["windows"][0]["address"]
        fixture = Path(__file__).resolve().parents[1] / "fedora-display" / "fixture.py"
        hyprctl("dispatch", "exec", f"[workspace 1] /usr/bin/python3 {fixture} {Path(os.environ['HOME']) / 'person.json'}")
        person = None
        for _ in range(100):
            person = next((c for c in j("clients") if c.get("workspace", {}).get("id") == 1), None)
            if person:
                break
            time.sleep(0.1)
        if not person:
            raise RuntimeError("Person window did not appear")
        hyprctl("dispatch", "focuswindow", f"address:{person['address']}")
        hyprctl("dispatch", "movecursor", "400", "300")
        time.sleep(1)
        before = seat()
        steps["before"] = before
        steps["personFocused"] = before["active"] == person["address"]
        steps["cursor"] = hyprctl("ghost-cursor", target, "200", "120").stdout.strip()
        steps["click"] = hyprctl("ghost-click", target, "300", "300").stdout.strip()
        deadline = time.monotonic() + 10
        steps["focusAddressBar"] = prepared_input(f"ghost-key {target} ctrl+l", exchange, deadline)
        url = f"data:text/html,<title>{TITLE}</title><h1>Orbit</h1>"
        steps["type"] = prepared_input(f"ghost-type {target} {url}", exchange, time.monotonic() + 10)
        steps["enter"] = prepared_input(f"ghost-key {target} Return", exchange, time.monotonic() + 10)
        title = ""
        for _ in range(100):
            title = next((c.get("title", "") for c in j("clients") if c.get("address") == chrome), "")
            if TITLE in title:
                break
            time.sleep(0.1)
        after = seat()
        steps["after"] = after
        steps["chromeTitleChanged"] = TITLE in title
        steps["personFocusKept"] = after["active"] == person["address"]
        steps["pointerUnmoved"] = after["cursor"] == before["cursor"]
        steps["handback"] = hyprctl("ghost-application-control", lease, "handback").stdout.strip()
        steps["leaseAfterHandback"] = hyprctl("ghost-application-info", lease).stdout.strip()[:200]
        steps["chromeStillOpen"] = any(c.get("address") == chrome for c in j("clients"))
        steps["compositorAlive"] = hyprctl("version").returncode == 0
        passed = all(steps[key] is True for key in ("personFocused", "chromeTitleChanged", "personFocusKept",
                                                     "pointerUnmoved", "chromeStillOpen", "compositorAlive"))
        passed = passed and steps["cursor"] == "ok" and steps["handback"] == "ok"
        report["state"] = "passed" if passed else "failed"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        report["state"] = "failed"
    finally:
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"state": report["state"]}))


if __name__ == "__main__":
    main()
