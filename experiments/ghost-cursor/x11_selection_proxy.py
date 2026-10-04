"""Bounded private-lab X11 transport experiment, not an owner-session proxy."""
import argparse
import array
import json
import os
from pathlib import Path
import random
import re
import select
import signal
import socket
import stat
import struct
import sys
import threading
import time
import uuid

import lab
from x11_selection_namespace import SelectionNamespace

MAX_FRAME = 16 * 1024 * 1024
MAX_FDS = 64


def close_fds(descriptors):
    failures = []
    for descriptor in descriptors:
        try:
            os.close(descriptor)
        except OSError as error:
            failures.append(error)
    if failures:
        raise ExceptionGroup("X11 descriptor cleanup failed", failures)


def release_fds(descriptors):
    owned = descriptors[:]
    descriptors.clear()
    close_fds(owned)


def receive(sock, size, descriptors, allow_eof=False):
    if not 0 <= size <= MAX_FRAME:
        raise ValueError("X11 frame exceeds experimental transport bound")
    data = bytearray()
    while len(data) < size:
        chunk, ancillary, flags, address = sock.recvmsg(size - len(data), socket.CMSG_SPACE(MAX_FDS * 4), socket.MSG_CMSG_CLOEXEC)
        unsupported = False
        for level, kind, payload in ancillary:
            if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
                unsupported = True
                continue
            values = array.array("i")
            values.frombytes(payload[:len(payload) - len(payload) % values.itemsize])
            descriptors.extend(values)
        if unsupported:
            raise ValueError("unsupported ancillary message")
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(descriptors) > MAX_FDS:
            raise ValueError("truncated or excessive X11 ancillary data")
        if not chunk:
            if data or not allow_eof:
                raise ValueError("truncated X11 stream frame")
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def send(sock, frame, descriptors):
    ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", descriptors))] if descriptors else []
    count = sock.sendmsg([frame], ancillary)
    if count <= 0:
        raise OSError("X11 send made no progress")
    if count < len(frame):
        sock.sendall(frame[count:])


class Proxy:
    def __init__(self, directory, server_pid, peer_pid, display, namespace, output, duration):
        self.lab = lab.lab_path(directory)
        self.env = lab.lab_env(self.lab)
        lab.guard(self.env)
        if not re.fullmatch(r":[0-9]+", display):
            raise ValueError("expected a local private X11 display")
        self.endpoint = Path("/tmp/.X11-unix") / ("X" + display[1:])
        if server_pid not in lab.members(self.lab):
            raise ValueError("Xwayland does not belong to lab")
        self.server_pid = server_pid
        self.server_identity = Path(f"/proc/{server_pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        command = Path(f"/proc/{server_pid}/cmdline").read_bytes().split(b"\0")
        if Path(os.fsdecode(command[0])).name != "Xwayland" or os.fsdecode(command[1]) != display:
            raise ValueError("private Xwayland identity mismatch")
        inodes = set()
        for fd in Path(f"/proc/{server_pid}/fd").iterdir():
            try:
                link = os.readlink(fd)
                if link.startswith("socket:["):
                    inodes.add(link[8:-1])
            except OSError:
                pass
        rows = [row.split() for row in Path("/proc/net/unix").read_text().splitlines()[1:]]
        if not any(len(row) > 7 and row[6] in inodes and row[7] == str(self.endpoint) for row in rows):
            raise ValueError("Xwayland endpoint inode mismatch")
        self.peer_pid = peer_pid
        self.namespace = namespace
        self.output = Path(output)
        if self.output.parent.resolve() != (self.lab / "run").resolve():
            raise ValueError("proxy state must live in the private lab runtime")
        self.deadline = time.monotonic() + duration
        self.stop = threading.Event()
        self.listeners = []
        self.connections = []
        self.threads = []
        self.lock = threading.Lock()
        self.state = {"ready": False, "closed": False, "pid": os.getpid(), "clients": [], "errors": [],
            "request_remaps": 0, "event_remaps": 0, "forwarded_fds": 0}
        self.path = None
        self.path_identity = None
        self.output_identity = None

    def write_state(self):
        with self.lock:
            content = json.dumps(self.state, indent=2) + "\n"
        lab.guard(self.env)
        run = os.open(self.output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temporary = ".proxy-state-" + uuid.uuid4().hex
        created = False
        try:
            info = os.fstat(run)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("proxy state directory must remain private")
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=run)
            created = True
            info = os.fstat(descriptor)
            identity = (info.st_dev, info.st_ino)
            with os.fdopen(descriptor, "w") as stream:
                stream.write(content)
            if self.output_identity is None:
                os.link(temporary, self.output.name, src_dir_fd=run, dst_dir_fd=run, follow_symlinks=False)
            else:
                current = os.stat(self.output.name, dir_fd=run, follow_symlinks=False)
                if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != self.output_identity:
                    raise ValueError("proxy state publication target changed")
                os.replace(temporary, self.output.name, src_dir_fd=run, dst_dir_fd=run)
                created = False
            self.output_identity = identity
        finally:
            try:
                if created:
                    current = os.stat(temporary, dir_fd=run, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) != identity:
                        raise ValueError("proxy temporary state inode changed")
                    os.unlink(temporary, dir_fd=run)
            finally:
                os.close(run)

    def connect_server(self):
        lab.guard(self.env)
        identity = Path(f"/proc/{self.server_pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        if identity != self.server_identity:
            raise ValueError("Xwayland identity changed")
        sock = socket.socket(socket.AF_UNIX)
        try:
            with self.lock:
                if self.stop.is_set():
                    raise OSError("proxy is stopping")
                self.connections.append(sock)
            sock.settimeout(max(0.1, self.deadline - time.monotonic()))
            sock.connect(str(self.endpoint))
            pid, uid, gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if pid != self.peer_pid or uid != os.getuid() or pid not in lab.members(self.lab):
                raise ValueError("Xwayland peer credentials changed")
            return sock
        except BaseException:
            sock.close()
            raise

    def bind(self):
        parent = Path("/tmp/.X11-unix")
        info = parent.lstat()
        if parent.resolve() != parent or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise ValueError("unexpected X11 socket directory")
        for attempt in range(20):
            number = random.SystemRandom().randrange(10000, 60000)
            path = parent / ("X" + str(number))
            filesystem = socket.socket(socket.AF_UNIX)
            abstract = socket.socket(socket.AF_UNIX)
            created = None
            try:
                filesystem.bind(str(path))
                created = path.lstat()
                abstract.bind("\0" + str(path))
                os.chmod(path, 0o600)
                filesystem.listen(8)
                abstract.listen(8)
                self.listeners = [filesystem, abstract]
                self.path = path
                self.path_identity = (created.st_dev, created.st_ino)
                self.state.update(ready=True, display=":" + str(number), socket=str(path))
                return
            except OSError:
                filesystem.close()
                abstract.close()
                if created is not None:
                    current = path.lstat()
                    if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                        path.unlink()
        raise OSError("could not reserve a private X11 listener")

    def relay(self, source, target, order, client_direction, done):
        descriptors = []
        try:
            while not self.stop.is_set() and not done.is_set():
                descriptors = []
                try:
                    if client_direction:
                        header = receive(source, 4, descriptors, allow_eof=True)
                        units = struct.unpack_from(order + "H", header, 2)[0]
                        if not units:
                            header += receive(source, 4, descriptors)
                            units = struct.unpack_from(order + "I", header, 4)[0]
                        size = units * 4
                    else:
                        header = receive(source, 32, descriptors, allow_eof=True)
                        size = 32
                        if (header[0] & 127) in (1, 35):
                            size += struct.unpack_from(order + "I", header, 4)[0] * 4
                    if size < len(header) or size > MAX_FRAME:
                        raise ValueError("invalid or excessive X11 frame length")
                    frame = header + receive(source, size - len(header), descriptors)
                    mapped = self.namespace.request(frame, order) if client_direction else self.namespace.server(frame, order)
                    send(target, mapped, descriptors)
                    with self.lock:
                        self.state["forwarded_fds"] += len(descriptors)
                        if mapped != frame:
                            self.state["request_remaps" if client_direction else "event_remaps"] += 1
                finally:
                    release_fds(descriptors)
        except EOFError:
            pass
        except BaseException as error:
            if not self.stop.is_set() and not done.is_set():
                with self.lock:
                    self.state["errors"].append(repr(error))
        finally:
            done.set()
            for sock in (source, target):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def client(self, client):
        upstream = None
        descriptors = []
        downstream_thread = None
        done = threading.Event()
        try:
            pid, uid, gid = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            runtime = f"XDG_RUNTIME_DIR={self.lab}/run".encode()
            if uid != os.getuid() or runtime not in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
                raise ValueError("refusing client outside private lab")
            upstream = self.connect_server()
            with self.lock:
                self.state["clients"].append({"application_pid": pid, "xres_connection_pid": os.getpid()})
            client.settimeout(max(0.1, self.deadline - time.monotonic()))
            header = receive(client, 12, descriptors)
            order = "<" if header[0] == ord("l") else ">" if header[0] == ord("B") else None
            if order is None or struct.unpack_from(order + "H", header, 2)[0] != 11:
                raise ValueError("unsupported X11 setup")
            auth_name, auth_data = struct.unpack_from(order + "HH", header, 6)
            auth_size = ((auth_name + 3) & ~3) + ((auth_data + 3) & ~3)
            send(upstream, header + receive(client, auth_size, descriptors), descriptors)
            release_fds(descriptors)
            header = receive(upstream, 8, descriptors)
            length = struct.unpack_from(order + "H", header, 6)[0] * 4
            send(client, header + receive(upstream, length, descriptors), descriptors)
            release_fds(descriptors)
            if header[0] != 1:
                raise ValueError("X11 setup did not succeed")
            downstream_thread = threading.Thread(target=self.relay, args=(upstream, client, order, False, done))
            downstream_thread.start()
            self.relay(client, upstream, order, True, done)
        except BaseException as error:
            if not self.stop.is_set():
                with self.lock:
                    self.state["errors"].append(repr(error))
        finally:
            cleanup = []
            try:
                release_fds(descriptors)
            except BaseException as error:
                cleanup.append(repr(error))
            done.set()
            for sock in (client, upstream):
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    try:
                        sock.close()
                    except OSError as error:
                        cleanup.append(repr(error))
            if downstream_thread is not None:
                downstream_thread.join(2)
                if downstream_thread.is_alive():
                    cleanup.append("downstream thread did not stop")
            with self.lock:
                self.state["errors"].extend(cleanup)

    def run(self):
        try:
            self.bind()
            while not self.stop.is_set() and time.monotonic() < self.deadline:
                self.write_state()
                ready, _, _ = select.select(self.listeners, [], [], 0.1)
                for listener in ready:
                    if self.stop.is_set():
                        break
                    client, address = listener.accept()
                    if len(self.threads) >= 8:
                        client.close()
                        raise ValueError("private proxy connection limit exceeded")
                    self.connections.append(client)
                    worker = threading.Thread(target=self.client, args=(client,))
                    self.threads.append(worker)
                    worker.start()
        finally:
            self.stop.set()
            with self.lock:
                sockets = [*self.listeners, *self.connections]
            for sock in sockets:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    sock.close()
                except OSError as error:
                    self.state["errors"].append(repr(error))
            for worker in self.threads:
                worker.join(3)
                if worker.is_alive():
                    self.state["errors"].append("client worker did not stop")
            if self.path is not None:
                info = self.path.lstat()
                if (info.st_dev, info.st_ino) != self.path_identity:
                    raise ValueError("refusing changed private listener inode cleanup")
                self.path.unlink()
            self.state.update(ready=False, closed=True)
            self.write_state()
        return 1 if self.state["errors"] else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", required=True)
    parser.add_argument("--server-pid", type=int, required=True)
    parser.add_argument("--peer-pid", type=int, required=True)
    parser.add_argument("--display", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--duration", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.duration <= 60:
        raise ValueError("invalid experiment deadline")
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from src.native.budget import require_budget
    require_budget()
    namespace = SelectionNamespace(**json.loads(args.namespace))
    proxy = Proxy(args.lab, args.server_pid, args.peer_pid, args.display, namespace, args.output, args.duration)
    signal.signal(signal.SIGTERM, lambda number, frame: proxy.stop.set())
    signal.signal(signal.SIGINT, lambda number, frame: proxy.stop.set())
    return proxy.run()


if __name__ == "__main__":
    sys.exit(main())
