#!/usr/bin/env python3
"""Push a local file into the win11 guest over the qemu-guest-agent channel.

base64 through guest-file-write, chunked. Slow but it needs no network, no share
and no SSH, which is the point: the guest has user mode slirp networking and the
host cannot reach into it.

Usage: vmpush.py <local path> <guest path> [--chunk 262144]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import sys
import time

from vmexec import agent, powershell


def push(local: str, remote: str, chunk: int) -> None:
    size = os.path.getsize(local)
    digest = hashlib.sha256()
    handle = agent({"execute": "guest-file-open", "arguments": {"path": remote, "mode": "wb"}})
    sent = 0
    started = time.time()
    try:
        with open(local, "rb") as source:
            while True:
                block = source.read(chunk)
                if not block:
                    break
                digest.update(block)
                agent(
                    {
                        "execute": "guest-file-write",
                        "arguments": {"handle": handle, "buf-b64": base64.b64encode(block).decode()},
                    },
                    timeout=180,
                )
                sent += len(block)
                elapsed = max(time.time() - started, 0.001)
                sys.stderr.write(
                    f"\r{sent / 1048576:.1f} / {size / 1048576:.1f} MiB "
                    f"({sent * 100 // size}%) at {sent / elapsed / 1048576:.2f} MiB/s"
                )
                sys.stderr.flush()
    finally:
        agent({"execute": "guest-file-close", "arguments": {"handle": handle}})
    sys.stderr.write("\n")

    want = digest.hexdigest()
    got = powershell(f'(Get-FileHash -Algorithm SHA256 "{remote}").Hash.ToLower()', wait=600)
    remote_hash = got["stdout"].strip()
    print(f"local  sha256 {want}")
    print(f"guest  sha256 {remote_hash}")
    print("MATCH" if remote_hash == want else "MISMATCH")
    if remote_hash != want:
        raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("local")
    parser.add_argument("remote")
    # 90000 raw bytes is 120000 base64 characters, which keeps the whole JSON payload under the
    # kernel's 128 KiB MAX_ARG_STRLEN ceiling on one argv entry.
    parser.add_argument("--chunk", type=int, default=90000)
    args = parser.parse_args()
    push(args.local, args.remote, args.chunk)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
