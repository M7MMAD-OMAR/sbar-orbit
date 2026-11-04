"""Owned synthetic Wayland server, never the owner's live compositor."""
import fcntl
import os
from pathlib import Path
import selectors
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]


class SyntheticCompositorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="orbit-wl-fixture-")
        cls.addClassCleanup(cls.temp.cleanup)
        tmp = Path(cls.temp.name)
        os.chmod(tmp, 0o700)
        def run(args):
            return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, text=True).stdout
        run(["/usr/bin/pkg-config", "--atleast-version=1.37", "wayland-protocols"])
        protocol_root = Path(run(["/usr/bin/pkg-config", "--variable=pkgdatadir", "wayland-protocols"]).strip())
        specs = {
            "ext-foreign-toplevel-list-v1": "staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml",
            "ext-image-capture-source-v1": "staging/ext-image-capture-source/ext-image-capture-source-v1.xml",
            "ext-image-copy-capture-v1": "staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml",
        }
        generated = []
        for name, relative in specs.items():
            xml = str(protocol_root / relative)
            for mode, suffix in (("client-header", "-client-protocol.h"),
                                 ("server-header", "-server-protocol.h"),
                                 ("private-code", "-protocol.c")):
                dest = tmp / (name + suffix)
                run(["/usr/bin/wayland-scanner", mode, xml, str(dest)])
                if mode == "private-code": generated.append(str(dest))
        client_flags = run(["/usr/bin/pkg-config", "--cflags", "--libs", "wayland-client", "libpng"]).split()
        server_flags = run(["/usr/bin/pkg-config", "--cflags", "--libs", "wayland-server"]).split()
        cls.helper = str(tmp / "helper")
        cls.server = str(tmp / "server")
        run(["/usr/bin/cc", "-std=c11", "-I", str(tmp), str(ROOT / "src/native/reader_helper.c"),
             *generated, *client_flags, "-o", cls.helper])
        run(["/usr/bin/cc", "-std=c11", "-I", str(tmp), str(ROOT / "tests/native_reader_compositor_fixture.c"),
             *generated, *server_flags, "-o", cls.server])
        cls.tmp = tmp

    def run_case(self, mode):
        with tempfile.TemporaryDirectory(prefix="runtime-", dir=self.tmp) as directory:
            os.chmod(directory, 0o700)
            env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": directory,
                   "WAYLAND_DISPLAY": "orbit-fixture"}
            server = subprocess.Popen([self.server, mode], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, env=env, close_fds=True)
            helper = None
            owned = []
            try:
                ready = selectors.DefaultSelector()
                try:
                    ready.register(server.stdout, selectors.EVENT_READ)
                    self.assertTrue(ready.select(2), "synthetic server did not start")
                    self.assertEqual(os.read(server.stdout.fileno(), 1), b"R")
                finally:
                    ready.close()
                setup_r, setup_w = os.pipe(); owned.extend((setup_r, setup_w))
                receipt_r, receipt_w = os.pipe(); owned.extend((receipt_r, receipt_w))
                png_r, png_w = os.pipe(); owned.extend((png_r, png_w))
                os.set_blocking(setup_r, False)
                os.set_blocking(receipt_w, False)
                os.set_blocking(png_w, False)
                launcher = r'''
import fcntl, os, sys
r, w = map(int, sys.argv[1:3])
a = fcntl.fcntl(r, fcntl.F_DUPFD_CLOEXEC, 5)
b = fcntl.fcntl(w, fcntl.F_DUPFD_CLOEXEC, 5)
os.dup2(a, 3, inheritable=True); os.dup2(b, 4, inheritable=True)
os.close(a); os.close(b)
os.execve(sys.argv[3], [sys.argv[3]], dict(os.environ))
'''
                helper = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", launcher,
                                           str(setup_r), str(receipt_w), self.helper],
                                          stdin=subprocess.DEVNULL, stdout=png_w, stderr=subprocess.PIPE,
                                          pass_fds=(setup_r, receipt_w), env=env, close_fds=True)
                for fd in (setup_r, receipt_w, png_w): os.close(fd); owned.remove(fd)
                size = 2 if mode == "small-damage" else 1
                setup = b"ORBSET01" + struct.pack(">IIII", 1, size, size, 1) + b"a" + bytes(31) + b"n" * 32 + b"d" * 32
                os.write(setup_w, setup); os.close(setup_w); owned.remove(setup_w)
                started = time.monotonic()
                _, err = helper.communicate(timeout=5)
                elapsed = time.monotonic() - started
                self.assertEqual(err, b"")
                def read_to_eof(fd, cap):
                    result = bytearray()
                    while True:
                        chunk = os.read(fd, min(32768, cap + 1 - len(result)))
                        if not chunk: return bytes(result)
                        result.extend(chunk)
                        if len(result) > cap: self.fail("fixture output exceeded bound")
                out = read_to_eof(png_r, 1048576)
                receipt = read_to_eof(receipt_r, 84)
                server_out, server_err = server.communicate(timeout=6)
                self.assertEqual(server_err, b"")
                self.assertEqual(server.returncode, 0)
                self.assertLess(elapsed, 4.5)
                return helper.returncode, out, receipt, server_out
            finally:
                for process in (helper, server):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait(timeout=2)
                for fd in owned:
                    os.close(fd)

    def test_ready_png_receipt_and_destroy_sync_order(self):
        code, out, receipt, events = self.run_case("ready")
        self.assertEqual(code, 0)
        self.assertEqual(events, b"11111")
        self.assertEqual(receipt, b"ORBRCP01" + bytes((1, 1, 3, 0)) + b"n" * 32 + b"d" * 32 + struct.pack(">II", 1, 1))
        self.assertTrue(out.startswith(b"\x89PNG\r\n\x1a\n"))
        pos, compressed = 8, bytearray()
        while pos < len(out):
            length = struct.unpack_from(">I", out, pos)[0]
            kind = out[pos + 4:pos + 8]
            body = out[pos + 8:pos + 8 + length]
            self.assertEqual(zlib.crc32(body, zlib.crc32(kind)) & 0xffffffff, struct.unpack_from(">I", out, pos + 8 + length)[0])
            if kind == b"IDAT": compressed.extend(body)
            pos += length + 12
            if kind == b"IEND": break
        self.assertEqual(pos, len(out))
        self.assertEqual(zlib.decompress(bytes(compressed)), b"\x00\x01\x02\x03")

    def test_withheld_post_destroy_sync_never_emits_receipt(self):
        code, out, receipt, events = self.run_case("withhold-sync")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events, b"11111")

    def test_failed_receipt_and_destroy_sync_order(self):
        code, out, receipt, events = self.run_case("failed")
        self.assertEqual(code, 70)
        self.assertEqual(out, b"")
        self.assertEqual(events, b"11111")
        self.assertEqual(receipt, b"ORBRCP01" + bytes((1, 2, 3, 0)) + b"n" * 32 + b"d" * 32 + struct.pack(">II", 1, 1))

    def test_bad_constraints_no_receipt(self):
        code, out, receipt, events = self.run_case("bad-size")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[:2], b"00")

    def test_duplicate_target_no_receipt(self):
        code, out, receipt, events = self.run_case("duplicate")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[:2], b"00")

    def test_late_duplicate_after_ready_no_receipt(self):
        code, out, receipt, events = self.run_case("late-duplicate")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[0:1], b"1")

    def test_late_malformed_duplicate_no_receipt(self):
        code, out, receipt, events = self.run_case("late-malformed")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[0:1], b"1")

    def test_partial_damage_no_ready_or_receipt(self):
        code, out, receipt, events = self.run_case("small-damage")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[0:1], b"1")

    def test_disconnect_no_receipt(self):
        code, out, receipt, events = self.run_case("drop")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[0:1], b"1")

    def test_missing_terminal_deadline_no_receipt(self):
        code, out, receipt, events = self.run_case("timeout")
        self.assertEqual((code, out, receipt), (70, b"", b""))
        self.assertEqual(events[0:1], b"1")


if __name__ == "__main__":
    unittest.main()
