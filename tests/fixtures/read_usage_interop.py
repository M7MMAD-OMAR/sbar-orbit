"""Test-only finite real store service. No public route, native app, or process supervisor."""
import os
from pathlib import Path
import select
import socket
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.read_usage_store_service import ReadUsageStoreService


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
    # Paths and slot order come only from the private, fixed parent test. They are
    # NOT authenticated production input or cross-process Python object identities.
    root, endpoint = sys.argv[1:]
    connection, service, root_fd = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM), None, None
    try:
        connection.settimeout(4)
        connection.connect(endpoint)
        connection.setblocking(False)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        entries = ((object(), "1" * 64), (object(), "2" * 64))
        service = ReadUsageStoreService(connection, root, entries, expected_root_fd=root_fd)
        emit("ready")  # Durable session marker exists BEFORE this fixture announcement.
        for step in range(1, 4):
            # Exactly one driver, not one new thread per client ACK. An ACK-paced
            # next request may wait in the socket while the previous call returns.
            if not select.select([connection], [], [], 8)[0]:
                raise RuntimeError("Fixture request did not arrive")
            if service.serve_one(deadline=time.monotonic() + 3) is not True:
                raise RuntimeError("Fixture commit was not confirmed")
            emit("step" + str(step))  # AFTER actual serve_one return, not just ACK send.
        # Keep the service alive so the parent can inspect records while B is on.
        if not select.select([sys.stdin.buffer], [], [], 8)[0]:
            raise RuntimeError("Fixture close instruction did not arrive")
        command = os.read(sys.stdin.fileno(), 32)
        if command not in (b"close\n", b""):
            raise RuntimeError("Fixture close instruction invalid")
        if service.close() is not True or not service.status()["localResourcesClosed"]:
            raise RuntimeError("Fixture close unconfirmed")
        emit("closed")
    finally:
        if service is not None:
            service.close()
        else:
            connection.close()
        if root_fd is not None:
            os.close(root_fd)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Never forward root paths, record bytes, traceback or arbitrary causes.
        sys.stderr.write("Owned usage interop fixture failed\n")
        sys.exit(1)
