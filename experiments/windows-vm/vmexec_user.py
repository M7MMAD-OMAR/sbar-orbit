#!/usr/bin/env python3
"""Run a PowerShell script inside the win11 guest AS THE INTERACTIVE USER.

Why this exists: qemu-guest-agent's guest-exec runs as NT AUTHORITY\\SYSTEM in
session 0. Measured on this guest, a Chromium family browser launched from
session 0 exits immediately and never writes DevToolsActivePort, headless or
not. Windows has no session 0 desktop and the browser will not run without one.

So every probe that touches a browser is handed to the interactive session by a
scheduled task with /RU <interactive user> /IT, which is the only route from
session 0 into session 1 that does not put a window on the person's screen.

Usage:
  vmexec_user.py script.ps1 [--wait 300]
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid

from vmexec import agent, guest_write, powershell, run  # noqa: F401

REMOTE_DIR = "C:\\orbit"


def run_as_user(script: str, wait: int = 300, user: str | None = None) -> str:
    """Push a script, run it in the interactive session, return its log."""
    tag = uuid.uuid4().hex[:8]
    remote_script = f"{REMOTE_DIR}\\task-{tag}.ps1"
    remote_log = f"{REMOTE_DIR}\\task-{tag}.log"
    task = f"OrbitProbe{tag}"

    # The payload logs to a file rather than to stdout: a scheduled task's stdout
    # goes nowhere the agent can read, and the exit code alone says too little.
    wrapper = (
        '$ErrorActionPreference = "Continue"\r\n'
        f'$OrbitLog = "{remote_log}"\r\n'
        "function Say($m) { Add-Content -Path $OrbitLog -Value ([string]$m) }\r\n"
        "try {\r\n"
        + script.replace("\n", "\r\n")
        + '\r\n} catch { Say ("UNCAUGHT: " + $_.Exception.Message) }\r\n'
        'Say "___ORBIT_DONE___"\r\n'
    )
    guest_write(remote_script, wrapper.encode("utf-8"))

    selected_user = "'" + user.replace("'", "''") + "'" if user else "(Get-CimInstance Win32_ComputerSystem).UserName"
    control = f"""
$ErrorActionPreference = "Continue"
$user = {selected_user}
if (-not $user) {{ throw "No interactive account detected; specify --user from query user" }}
& schtasks.exe /Create /TN {task} /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File {remote_script}" /SC ONCE /ST 23:59 /RU $user /IT /F | Out-Null
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}
& schtasks.exe /Run /TN {task} | Out-Null
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}
"launched as $user"
"""
    result = powershell(control, wait=120)
    if result["exitcode"] != 0:
        raise RuntimeError(f"could not schedule task: {result['stderr'][:400]}")

    deadline = time.time() + wait
    body = ""
    while time.time() < deadline:
        probe = powershell(
            f'if (Test-Path "{remote_log}") {{ '
            f'$s=[IO.File]::Open("{remote_log}","Open","Read","ReadWrite"); '
            f"$r=New-Object IO.StreamReader($s); $r.ReadToEnd(); $r.Close(); $s.Close() }}",
            wait=60,
        )
        body = probe["stdout"]
        if "___ORBIT_DONE___" in body:
            break
        time.sleep(3)

    if "___ORBIT_DONE___" not in body:
        raise TimeoutError(f"No completion from {task}; inspect {remote_log} and the task before retrying")
    powershell(f"& schtasks.exe /Delete /TN {task} /F | Out-Null", wait=60)
    if "UNCAUGHT:" in body:
        raise RuntimeError(body.replace("___ORBIT_DONE___", "").rstrip())
    return body.replace("___ORBIT_DONE___", "").rstrip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("script")
    parser.add_argument("--wait", type=int, default=300)
    parser.add_argument("--user", help="Interactive test account when WMI cannot identify it")
    args = parser.parse_args()
    with open(args.script, "r", encoding="utf-8") as handle:
        body = handle.read()
    sys.stdout.write(run_as_user(body, wait=args.wait, user=args.user) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
