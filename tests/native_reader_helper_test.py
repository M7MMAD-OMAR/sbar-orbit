"""Compile-time C fixture checks without a compositor or native applications.

The Lead-run fixture builds the actual helper and callback fixture in an owned
temporary directory. No Wayland endpoint is contacted, so protocol/server
acceptance is not established.
"""
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def setup_record():
    return (b"ORBSET01" + struct.pack(">IIII", 1, 1, 1, 1)
            + b"a" + bytes(31) + b"n" * 32 + b"d" * 32)


class HelperPreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="orbit-reader-build-")
        cls.addClassCleanup(cls.temp.cleanup)
        tmp = Path(cls.temp.name)
        subprocess.run(["/usr/bin/pkg-config", "--atleast-version=1.37", "wayland-protocols"],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        subprocess.run(["/usr/bin/pkg-config", "--atleast-version=1.22", "wayland-client"],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        flags = subprocess.run(["/usr/bin/pkg-config", "--cflags", "--libs", "wayland-client", "libpng"],
                               check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                               text=True).stdout.split()
        protocols = subprocess.run(["/usr/bin/pkg-config", "--variable=pkgdatadir", "wayland-protocols"],
                                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                                   text=True).stdout.strip()
        specs = {
            "ext-foreign-toplevel-list-v1": "staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml",
            "ext-image-capture-source-v1": "staging/ext-image-capture-source/ext-image-capture-source-v1.xml",
            "ext-image-copy-capture-v1": "staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml",
        }
        cls.sources = []
        for name, relative in specs.items():
            xml = str(Path(protocols) / relative)
            header, source = tmp / (name + "-client-protocol.h"), tmp / (name + "-protocol.c")
            for mode, destination in (("client-header", header), ("private-code", source)):
                subprocess.run(["/usr/bin/wayland-scanner", mode, xml, str(destination)], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            cls.sources.append(str(source))
        cls.tmp, cls.flags = tmp, flags
        cls.binary = str(tmp / "helper")
        subprocess.run(["/usr/bin/cc", "-std=c11", "-I", str(tmp), str(ROOT / "src/native/reader_helper.c"),
                        *cls.sources, *flags, "-o", cls.binary], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

    def invoke(self, data, extra=()):
        # Fixed inherited 3/4 without preexec_fn: owned Python launcher remaps
        # only its own already-inherited pipe descriptors then execs the helper.
        setup_r, setup_w = os.pipe()
        receipt_r, receipt_w = os.pipe()
        output_r, output_w = os.pipe()
        os.set_blocking(setup_r, False)
        os.set_blocking(receipt_w, False)
        os.set_blocking(output_w, False)
        launcher = r'''
import fcntl, os, sys
r, w = map(int, sys.argv[1:3])
# Stage duplicates above fixed descriptors to avoid accidental aliasing.
a = fcntl.fcntl(r, fcntl.F_DUPFD_CLOEXEC, 5)
b = fcntl.fcntl(w, fcntl.F_DUPFD_CLOEXEC, 5)
os.dup2(a, 3, inheritable=True); os.dup2(b, 4, inheritable=True)
os.close(a); os.close(b)
os.execve(sys.argv[3], [sys.argv[3]] + sys.argv[4:], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
'''
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", launcher,
                                  str(setup_r), str(receipt_w), self.binary, *extra],
                                 stdin=subprocess.DEVNULL, stdout=output_w, stderr=subprocess.PIPE,
                                 pass_fds=(setup_r, receipt_w))
        os.close(setup_r)
        os.close(receipt_w)
        os.close(output_w)
        try:
            try:
                os.write(setup_w, data)
            except BrokenPipeError:
                pass
            os.close(setup_w)
            setup_w = None
            _, err = child.communicate(timeout=5)
            out = os.read(output_r, 1048577)
            receipt = os.read(receipt_r, 85)
            return child.returncode, out, err, receipt
        finally:
            if setup_w is not None: os.close(setup_w)
            os.close(receipt_r)
            os.close(output_r)
            if child.poll() is None:
                child.kill()
                child.wait(timeout=2)

    def refused(self, data, extra=()):
        code, out, err, receipt = self.invoke(data, extra)
        self.assertEqual(code, 70)
        self.assertEqual((out, err, receipt), (b"", b"", b""))

    def test_empty_setup(self): self.refused(b"")
    def test_truncated_setup(self): self.refused(setup_record()[:-1])
    def test_extra_setup(self): self.refused(setup_record() + b"x")
    def test_wrong_magic(self): self.refused(b"BADMAGIC" + setup_record()[8:])
    def test_wrong_version(self): self.refused(setup_record()[:8] + struct.pack(">I", 2) + setup_record()[12:])
    def test_zero_width(self): self.refused(setup_record()[:12] + bytes(4) + setup_record()[16:])
    def test_large_height(self): self.refused(setup_record()[:16] + struct.pack(">I", 961) + setup_record()[20:])
    def test_long_identifier(self): self.refused(setup_record()[:20] + struct.pack(">I", 17) + setup_record()[24:])
    def test_invalid_identifier(self): self.refused(setup_record()[:24] + b"G" + setup_record()[25:])
    def test_nonzero_padding(self): self.refused(setup_record()[:25] + b"x" + setup_record()[26:])
    def test_reject_arguments(self): self.refused(setup_record(), ("unexpected",))
    def test_missing_wayland_display_refuses_without_output(self): self.refused(setup_record())

    def test_protocol_callback_state_and_rgb_encoding(self):
        fixture = r"""
#define main orbit_helper_main
#include "reader_helper.c"
#undef main
int main(void) {
    struct state s = {0};
    s.width = 1; s.height = 1;
    buffer_size(&s, NULL, 1, 1);
    shm_format(&s, NULL, WL_SHM_FORMAT_XRGB8888);
    constraints_done(&s, NULL);
    if (!s.constraints || s.error) return 1;
    frame_transform(&s, NULL, WL_OUTPUT_TRANSFORM_NORMAL);
    frame_damage(&s, NULL, 0, 0, 1, 1);
    frame_time(&s, NULL, 0, 0, 0);
    frame_ready(&s, NULL);
    if (!s.ready || !s.terminal || s.failed || s.error) return 2;
    uint8_t pixel[] = {3, 2, 1, 0};
    s.pixels = pixel; s.deadline = now_ms() + 1000;
    struct png_output image = {0};
    if (encode(&s, &image) || image.size < 8 || memcmp(image.bytes, "\211PNG\r\n\032\n", 8)) return 3;
    png_image decoded = { .version = PNG_IMAGE_VERSION };
    if (!png_image_begin_read_from_memory(&decoded, image.bytes, image.size)) return 4;
    decoded.format = PNG_FORMAT_RGB;
    uint8_t rgb[3] = {0};
    if (!png_image_finish_read(&decoded, NULL, rgb, 0, NULL) || rgb[0] != 1 || rgb[1] != 2 || rgb[2] != 3) return 5;
    png_image_free(&decoded); free(image.bytes);
    struct state failed = {0};
    frame_failed(&failed, NULL, 0);
    if (!failed.failed || !failed.terminal || failed.ready || failed.error) return 6;
    frame_ready(&failed, NULL);
    if (!failed.error) return 7;
    struct state malformed = { .width = 1, .height = 1 };
    buffer_size(&malformed, NULL, 2, 1);
    if (!malformed.error) return 8;
    struct state changed = { .width = 1, .height = 1, .constraints = true };
    buffer_size(&changed, NULL, 1, 1);
    if (!changed.error) return 9;
    return 0;
}
"""
        source = self.tmp / "callback.c"
        source.write_text(fixture)
        binary = self.tmp / "callback"
        subprocess.run(["/usr/bin/cc", "-std=c11", "-I", str(self.tmp), "-I", str(ROOT / "src/native"),
                        str(source), *self.sources, *self.flags, "-o", str(binary)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        child = subprocess.run([str(binary)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        self.assertEqual((child.returncode, child.stdout, child.stderr), (0, b"", b""))


if __name__ == "__main__":
    unittest.main()
