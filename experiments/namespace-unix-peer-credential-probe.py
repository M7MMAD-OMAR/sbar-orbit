#!/usr/bin/env python3
"""Measure direct UNIX peer identity with one hidden host socket directory."""

import json
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path


SELECTED = "/tmp/orbit-probe/selected.sock"

INNER = r'''
import json, os, socket, sys

def connect(path, wait=False):
    peer = socket.socket(socket.AF_UNIX)
    try:
        peer.connect(path)
        if wait and peer.recv(1) != b"R":
            raise RuntimeError("selected server did not acknowledge the client")
        return "connected"
    except OSError as error:
        return {"errno": error.errno}
    finally:
        peer.close()

print(json.dumps({"pid": os.getpid(), "selected": connect("/tmp/orbit-probe/selected.sock", True),
                  "blocked": connect(sys.argv[1] + "/blocked.sock"),
                  "hostRoot": connect("/proc/" + sys.argv[2] + "/root" + sys.argv[1] + "/blocked.sock")}),
      flush=True)
'''

OUTER = r'''
import json, os, socket, subprocess, sys

def connect(path, wait=False):
    peer = socket.socket(socket.AF_UNIX)
    try:
        peer.connect(path)
        if wait and peer.recv(1) != b"R":
            raise RuntimeError("selected server did not acknowledge the client")
        return "connected"
    except OSError as error:
        return {"errno": error.errno}
    finally:
        peer.close()

root, host_pid = sys.argv[1], sys.argv[3]
direct = {"pid": os.getpid(), "selected": connect("/tmp/orbit-probe/selected.sock", True),
          "blocked": connect(root + "/blocked.sock"),
          "hostRoot": connect("/proc/" + host_pid + "/root" + root + "/blocked.sock")}
nested = subprocess.run(["/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                         "--proc", "/proc", "--", "/usr/bin/python3", "-c", sys.argv[2], root, host_pid],
                        capture_output=True, text=True, timeout=5)
print(json.dumps({"direct": direct, "nestedExit": nested.returncode,
                  "nested": json.loads(nested.stdout) if nested.returncode == 0 else None,
                  "nestedError": nested.stderr[:256]}), flush=True)
'''


def server(path):
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(path))
    listener.listen(4)
    listener.settimeout(3)
    return listener


def main():
    with tempfile.TemporaryDirectory(prefix="orbit-namespace-unix-") as root:
        selected = server(Path(root, "selected.sock"))
        blocked = server(Path(root, "blocked.sock"))
        selected_fd = os.open(Path(root, "selected.sock"), os.O_PATH | os.O_NOFOLLOW)
        try:
            command = ["/usr/bin/bwrap", "--unshare-pid", "--bind", "/", "/", "--dev", "/dev",
                       "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/tmp/orbit-probe",
                       "--bind-fd", str(selected_fd), SELECTED,
                       "--tmpfs", root, "--", "/usr/bin/python3", "-c", OUTER, root, INNER,
                       str(os.getpid())]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, pass_fds=(selected_fd,))
            peers = []
            namespace_pids = []
            try:
                for _ in range(2):
                    connection, _ = selected.accept()
                    try:
                        credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                        peer_pid = int.from_bytes(credentials[:4], sys.byteorder, signed=True)
                        peers.append(peer_pid)
                        status = Path(f"/proc/{peer_pid}/status").read_text()
                        namespace_line = next(line for line in status.splitlines()
                                              if line.startswith("NSpid:"))
                        namespace_pids.append(int(namespace_line.split()[-1]))
                        connection.sendall(b"R")
                    finally:
                        connection.close()
                output, error = process.communicate(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            if process.returncode != 0:
                raise RuntimeError(f"outer mount failed: {error[:512]}")
            result = json.loads(output)
            direct = result["direct"]
            nested = result["nested"]
            result["selectedPeerPids"] = peers
            result["selectedPeerNamespacePids"] = namespace_pids
            result["selectedPeerPidsMatchClients"] = namespace_pids == [
                direct["pid"], nested["pid"]] if nested else False
            blocked.settimeout(0.1)
            try:
                connection, _ = blocked.accept()
            except TimeoutError:
                result["blockedAccepts"] = 0
            else:
                connection.close()
                result["blockedAccepts"] = 1
            print(json.dumps(result, sort_keys=True))
            if (direct["selected"] != "connected" or direct["blocked"] != {"errno": 2}
                    or direct["hostRoot"] != {"errno": 2}
                    or result["nestedExit"] != 0 or nested["selected"] != "connected"
                    or nested["blocked"] != {"errno": 2} or nested["hostRoot"] != {"errno": 2}
                    or not result["selectedPeerPidsMatchClients"] or result["blockedAccepts"]):
                raise RuntimeError("private namespace socket and peer identity probe failed")
        finally:
            os.close(selected_fd)
            selected.close()
            blocked.close()


if __name__ == "__main__":
    main()
