#!/usr/bin/env python3
"""Run a PowerShell command inside the win11 libvirt guest through qemu-guest-agent.

No network, no screen, no SSH: the virtio-serial channel only. Reads stdout and
stderr back through guest-exec-status.

Usage:
  vmexec.py 'Get-ComputerInfo | Select OsName'
  vmexec.py --file script.ps1            # push the file and run it
  vmexec.py --raw prog arg1 arg2         # run a program directly, no shell
"""

from __future__ import annotations

import argparse
import base64
import json

import subprocess
import sys

import time

DOMAIN = "win11"
URI = "qemu:///session"


def agent(payload: dict, timeout: int = 60) -> dict:
    # Straight argv, deliberately. A single argument on Linux is capped at MAX_ARG_STRLEN, 128 KiB,
    # independently of the 2 MiB ARG_MAX, and neither a shell nor a temporary file gets around it:
    # the JSON still has to arrive as one argv entry. So the payload is kept under the ceiling by the
    # caller instead, which is why vmpush uses a 90000 byte chunk, 120000 base64 characters.
    body = json.dumps(payload)
    if len(body) > 130000:
        raise ValueError(f"agent payload is {len(body)} bytes, over the 128 KiB single argument limit")
    proc = subprocess.run(
        ["virsh", "-c", URI, "qemu-agent-command", DOMAIN, body],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"agent call failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)["return"]


def guest_write(path: str, data: bytes) -> None:
    handle = agent({"execute": "guest-file-open", "arguments": {"path": path, "mode": "wb"}})
    try:
        step = 128 * 1024
        for offset in range(0, len(data), step):
            agent(
                {
                    "execute": "guest-file-write",
                    "arguments": {
                        "handle": handle,
                        "buf-b64": base64.b64encode(data[offset : offset + step]).decode(),
                    },
                }
            )
    finally:
        agent({"execute": "guest-file-close", "arguments": {"handle": handle}})


def guest_read(path: str) -> bytes:
    handle = agent({"execute": "guest-file-open", "arguments": {"path": path, "mode": "rb"}})
    chunks: list[bytes] = []
    try:
        while True:
            res = agent(
                {"execute": "guest-file-read", "arguments": {"handle": handle, "count": 1024 * 1024}}
            )
            chunks.append(base64.b64decode(res["buf-b64"]))
            if res["eof"]:
                break
    finally:
        agent({"execute": "guest-file-close", "arguments": {"handle": handle}})
    return b"".join(chunks)


def run(argv: list[str], wait: int = 900) -> dict:
    pid = agent(
        {
            "execute": "guest-exec",
            "arguments": {
                "path": argv[0],
                "arg": argv[1:],
                "capture-output": True,
            },
        }
    )["pid"]
    deadline = time.time() + wait
    delay = 0.3
    while True:
        status = agent({"execute": "guest-exec-status", "arguments": {"pid": pid}})
        if status.get("exited"):
            break
        if time.time() > deadline:
            return {"exitcode": None, "stdout": "", "stderr": f"timeout after {wait}s", "pid": pid}
        time.sleep(delay)
        delay = min(delay * 1.4, 3.0)
    out = base64.b64decode(status.get("out-data", "")).decode("utf-8", "replace")
    err = base64.b64decode(status.get("err-data", "")).decode("utf-8", "replace")
    return {"exitcode": status.get("exitcode"), "stdout": out, "stderr": err, "pid": pid}


def powershell(script: str, wait: int = 900) -> dict:
    encoded = base64.b64encode(script.encode("utf-16-le")).decode()
    return run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        wait=wait,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="*")
    parser.add_argument("--file", help="local .ps1 file to push and run")
    parser.add_argument("--raw", action="store_true", help="run argv directly, no PowerShell")
    parser.add_argument("--wait", type=int, default=900)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.file:
        with open(args.file, "rb") as handle:
            body = handle.read()
        remote = "C:\\Windows\\Temp\\orbit-run.ps1"
        guest_write(remote, body)
        result = run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                remote,
            ],
            wait=args.wait,
        )
    elif args.raw:
        result = run(args.command, wait=args.wait)
    else:
        result = powershell(" ".join(args.command), wait=args.wait)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["stdout"]:
            sys.stdout.write(result["stdout"])
        if result["stderr"]:
            sys.stderr.write(result["stderr"])
        print(f"\n[exit {result['exitcode']}]", file=sys.stderr)
    return 0 if result["exitcode"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
