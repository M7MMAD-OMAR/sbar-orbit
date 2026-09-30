#!/usr/bin/python3
"""Opaque CONNECT tunnel to the configured account only. No TLS termination."""
import asyncio
import configparser
import json
import os
import re
import signal
import socket
import stat
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit


def account_target(configuration):
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    fd = os.open(configuration, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid() or identity.st_size > 1048576:
            raise ValueError("Requires a bounded owned regular configuration")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(1048577)
        if len(data) != identity.st_size:
            raise ValueError("Configuration changed or exceeded its limit")
        text = data.decode("utf8")
    finally:
        os.close(fd)
    config.read_string(text)
    urls = [(key.split("\\")[0], value) for key, value in config["Accounts"].items()
            if len(key.split("\\")) == 2 and key.split("\\")[-1] == "url"]
    if len(urls) != 1:
        raise ValueError("Requires one account URL")
    account_id, value = urls[0]
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Requires a simple HTTPS account")
    return account_id, url.hostname.lower(), url.port or 443, text, identity


def configure_proxy(text, account_id, port):
    replacements = {"networkProxyType": "3", "networkProxyHostName": "127.0.0.1", "networkProxyPort": str(port),
                    "networkProxyNeedsAuth": "false", "networkProxyUser": ""}
    section = ""
    changed = set()
    result = []
    for line in text.splitlines(keepends=True):
        if line.strip().startswith("["):
            section = line.strip()
        if section == "[Accounts]" and "=" in line:
            key = line.split("=", 1)[0]
            for field, value in replacements.items():
                if key == account_id + "\\" + field:
                    line = key + "=" + value + "\n"
                    changed.add(field)
        result.append(line)
    if changed != set(replacements):
        raise ValueError("Missing observed per-account proxy fields")
    return "".join(result)


async def run(configuration, summary_path):
    account_id, hostname, remote_port, text, identity = account_target(configuration)
    loop = asyncio.get_running_loop()
    resolved = await asyncio.wait_for(loop.getaddrinfo(hostname, remote_port, family=socket.AF_INET, type=socket.SOCK_STREAM), 5)
    address = resolved[0][4][0]
    authority = f"{hostname}:{remote_port}"
    summary = {"acceptedTunnels": 0, "blockedRequests": 0, "upstreamFailures": 0, "clientBytes": 0, "serverBytes": 0, "failureStages": {}, "failureKinds": {}}
    active = set()

    def save():
        with open(summary_path, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(summary, stream)

    async def pump(reader, writer, counter):
        while data := await reader.read(65536):
            summary[counter] += len(data)
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()

    async def client(reader, writer):
        task = asyncio.current_task()
        active.add(task)
        upstream = None
        stage = "client-header"
        try:
            async with asyncio.timeout(45):
                header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                first = header.split(b"\r\n", 1)[0].decode("ascii")
                if first != f"CONNECT {authority} HTTP/1.1" or len(active) > 16 or summary["acceptedTunnels"] >= 32:
                    summary["blockedRequests"] += 1
                    writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    await writer.drain()
                    return
                stage = "upstream-connect"
                remote_reader, upstream = await asyncio.wait_for(asyncio.open_connection(address, remote_port), 5)
                summary["acceptedTunnels"] += 1
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
                save()
                stage = "tunnel-io"
                await asyncio.gather(pump(reader, upstream, "clientBytes"), pump(remote_reader, writer, "serverBytes"))
        except (OSError, UnicodeError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            summary["upstreamFailures"] += 1
            summary["failureStages"][stage] = summary["failureStages"].get(stage, 0) + 1
            kind = type(error).__name__
            summary["failureKinds"][kind] = summary["failureKinds"].get(kind, 0) + 1
        finally:
            writer.close()
            if upstream:
                upstream.close()
            active.discard(task)
            save()

    server = await asyncio.start_server(client, "127.0.0.1", 0, limit=8192)
    port = server.sockets[0].getsockname()[1]
    prepared = configure_proxy(text, account_id, port).encode()
    fd = os.open(configuration, os.O_WRONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns):
            raise ValueError("Private configuration changed before proxy setup")
        os.ftruncate(fd, 0)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(prepared)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    stopped = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    def parent():
        sys.stdin.read()
        loop.call_soon_threadsafe(stopped.set)
    threading.Thread(target=parent, daemon=True).start()
    save()
    print(json.dumps({"ready": True, "port": port}), flush=True)
    await stopped.wait()
    server.close()
    await server.wait_closed()
    for task in list(active):
        task.cancel()
    await asyncio.gather(*active, return_exceptions=True)
    save()


if __name__ == "__main__":
    configuration, summary_path = map(Path, sys.argv[1:])
    if not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+/nextcloud-config/nextcloud.cfg", str(configuration)) or not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+/tunnel-summary.json", str(summary_path)):
        raise SystemExit("Requires disposable paths")
    asyncio.run(run(configuration, summary_path))
