"""Generated owned PNG fixtures only, no renderer, raster library or desktop."""
import struct
import sys
import unittest
import zlib
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_png as subject

MAGIC = b"\x89PNG\r\n\x1a\n"


def chunk(kind, body=b""):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)


def ihdr(width=2, height=2, color=2, depth=8, compression=0, filtering=0, interlace=0):
    return chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color, compression, filtering, interlace))


def rows(width=2, height=2, color=2, filters=None):
    channels = 3 if color == 2 else 4
    return b"".join(bytes([0 if filters is None else filters[index]]) + b"\x19" * (width * channels) for index in range(height))


def png(width=2, height=2, color=2, raw=None, before=(), after=()):
    payload = zlib.compress(rows(width, height, color) if raw is None else raw)
    return MAGIC + ihdr(width, height, color) + b"".join(before) + chunk(b"IDAT", payload) + b"".join(after) + chunk(b"IEND")


class ReaderPngTests(unittest.TestCase):
    def assert_code(self, code, data, width=2, height=2, **kwargs):
        with self.assertRaises(subject.ReaderPngError) as caught:
            subject.validate_reader_png(data, width, height, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_default_limits_and_result_are_frozen(self):
        limits = subject.ReaderPngLimits()
        self.assertEqual((limits.max_width, limits.max_height, limits.max_bytes, limits.max_chunks), (1280, 960, 1048576, 4096))
        info = subject.validate_reader_png(png(), 2, 2)
        self.assertEqual((info.width, info.height, info.color_type), (2, 2, 2))
        with self.assertRaises(FrozenInstanceError):
            limits.max_width = 2000
        with self.assertRaises(FrozenInstanceError):
            info.width = 2000

    def test_limits_only_accept_stricter_positive_integers(self):
        for key, maximum in (("max_width", 1280), ("max_height", 960), ("max_bytes", 1048576), ("max_chunks", 4096)):
            for value in (0, -1, True, 1.5, "1", maximum + 1):
                with self.subTest(key=key, value=value):
                    with self.assertRaises(subject.ReaderPngError) as caught:
                        subject.ReaderPngLimits(**{key: value})
                    self.assertEqual(caught.exception.code, "INVALID")
            self.assertEqual(getattr(subject.ReaderPngLimits(**{key: 1}), key), 1)

    def test_legitimate_rgb_and_rgba_accept_every_scanline_filter(self):
        for color in (2, 6):
            info = subject.validate_reader_png(png(2, 5, color, rows(2, 5, color, [0, 1, 2, 3, 4])), 2, 5)
            self.assertEqual(info.color_type, color)

    def test_contiguous_split_and_empty_idat_chunks_are_legal(self):
        payload = zlib.compress(rows())
        data = MAGIC + ihdr() + chunk(b"IDAT") + chunk(b"IDAT", payload[:3]) + chunk(b"IDAT", payload[3:]) + chunk(b"IEND")
        self.assertEqual(subject.validate_reader_png(data, 2, 2).width, 2)

    def test_safe_ancillary_and_optional_truecolor_palette_are_legal(self):
        before = (chunk(b"gAMA", struct.pack(">I", 45455)), chunk(b"PLTE", b"\x00\x01\x02"),
                  chunk(b"tRNS", struct.pack(">HHH", 1, 2, 3)), chunk(b"pHYs", struct.pack(">IIB", 1, 1, 1)))
        after = (chunk(b"tEXt", b"Label\0owned fixture"), chunk(b"vpAg", b"opaque ancillary"))
        self.assertEqual(subject.validate_reader_png(png(before=before, after=after), 2, 2).color_type, 2)

    def test_data_type_dimensions_and_check_arguments_are_strict(self):
        for data in (bytearray(png()), memoryview(png()), "secret-image", None):
            self.assert_code("INVALID", data)
        for width, height in ((True, 2), (2, False), (0, 2), (2, -1), (2.0, 2), (2, "2")):
            self.assert_code("INVALID", png(), width, height)
        self.assert_code("INVALID", png(), check=1)
        self.assert_code("INVALID", png(), limits={})

    def test_encoded_bytes_dimension_and_chunk_caps_are_enforced(self):
        data = png()
        self.assert_code("LIMIT", data, limits=subject.ReaderPngLimits(max_bytes=len(data) - 1))
        self.assert_code("LIMIT", data, limits=subject.ReaderPngLimits(max_width=1))
        self.assert_code("LIMIT", data, limits=subject.ReaderPngLimits(max_height=1))
        self.assert_code("LIMIT", data, limits=subject.ReaderPngLimits(max_chunks=2))
        self.assert_code("LIMIT", png(1281, 1), 1281, 1)
        self.assert_code("LIMIT", png(1, 961), 1, 961)

    def test_magic_crc_and_chunk_name_reserved_bit_are_strict(self):
        self.assert_code("FORMAT", b"private-secret" + png()[8:])
        damaged = bytearray(png())
        damaged[29] ^= 1
        self.assert_code("FORMAT", bytes(damaged))
        for kind in (b"abca", b"ab1D", b"ABCD"):
            self.assert_code("FORMAT", png(before=(chunk(kind, b"private-secret"),)))

    def test_ihdr_must_be_first_exactly_once_and_exact_length(self):
        self.assert_code("FORMAT", MAGIC + chunk(b"tEXt", b"a\0b") + png()[8:])
        self.assert_code("FORMAT", png(before=(ihdr(),)))
        self.assert_code("FORMAT", MAGIC + chunk(b"IHDR", b"x" * 12) + chunk(b"IEND"))

    def test_dimensions_must_match_without_downscale_or_fallback(self):
        self.assert_code("FORMAT", png(3, 2), 2, 2)
        self.assert_code("FORMAT", png(2, 3), 2, 2)
        self.assert_code("FORMAT", MAGIC + ihdr(0, 2) + chunk(b"IDAT", zlib.compress(rows())) + chunk(b"IEND"))

    def test_unsupported_depth_color_compression_filter_and_interlace_refuse(self):
        for kwargs in ({"depth": 16}, {"depth": 1}, {"color": 0}, {"color": 3}, {"color": 4}, {"compression": 1}, {"filtering": 1}, {"interlace": 1}):
            data = MAGIC + ihdr(**kwargs) + chunk(b"IDAT", zlib.compress(rows())) + chunk(b"IEND")
            self.assert_code("FORMAT", data)

    def test_missing_idat_or_iend_and_nonempty_iend_refuse(self):
        self.assert_code("FORMAT", MAGIC + ihdr() + chunk(b"IEND"))
        self.assert_code("FORMAT", png()[:-12])
        self.assert_code("FORMAT", png()[:-12] + chunk(b"IEND", b"x"))

    def test_truncated_headers_chunk_lengths_payloads_and_crcs_refuse(self):
        data = png()
        for length in (0, 7, 8, 10, 20, 32, len(data) - 1, len(data) - 5):
            self.assert_code("FORMAT", data[:length])
        self.assert_code("FORMAT", MAGIC + struct.pack(">I", 0xffffffff) + b"IHDR" + b"x" * 13)
        self.assert_code("FORMAT", MAGIC + ihdr() + struct.pack(">I", 1000) + b"IDAT" + b"x")

    def test_bytes_after_terminal_iend_or_second_png_are_not_accepted(self):
        self.assert_code("FORMAT", png() + b"private-secret")
        self.assert_code("FORMAT", png() + png())
        self.assert_code("FORMAT", png() + chunk(b"IEND"))

    def test_idat_must_remain_contiguous(self):
        payload = zlib.compress(rows())
        data = MAGIC + ihdr() + chunk(b"IDAT", payload[:3]) + chunk(b"tEXt", b"a\0b") + chunk(b"IDAT", payload[3:]) + chunk(b"IEND")
        self.assert_code("FORMAT", data)

    def test_zlib_truncation_checksum_and_invalid_compressed_bytes_refuse(self):
        payload = zlib.compress(rows())
        bad_checksum = payload[:-1] + bytes([payload[-1] ^ 1])
        for invalid in (payload[:-1], payload[:-4], b"not-zlib-private-secret", bad_checksum):
            self.assert_code("FORMAT", MAGIC + ihdr() + chunk(b"IDAT", invalid) + chunk(b"IEND"))

    def test_concatenated_zlib_streams_and_compressed_trailing_bytes_refuse(self):
        payload = zlib.compress(rows())
        for tail in (payload, b"private-secret", b"\x00"):
            self.assert_code("FORMAT", MAGIC + ihdr() + chunk(b"IDAT", payload + tail) + chunk(b"IEND"))

    def test_decoded_length_is_exact_and_compression_bomb_is_stopped(self):
        raw = rows()
        for decoded in (raw[:-1], raw + b"\x00", b"\x00" * (1024 * 1024)):
            self.assert_code("FORMAT", png(raw=decoded))

    def test_invalid_filter_at_any_row_boundary_refuses(self):
        for filters in ([5, 0], [0, 255]):
            self.assert_code("FORMAT", png(raw=rows(filters=filters)))
        # The second row begins beyond a 64 KiB inflater output boundary.
        raw = bytearray(rows(1280, 20))
        raw[18 * (1 + 1280 * 3)] = 5
        self.assert_code("FORMAT", png(1280, 20, raw=bytes(raw)), 1280, 20)

    def test_inflater_output_blocks_are_bounded_and_flush_is_never_used(self):
        factory = zlib.decompressobj
        calls = []
        class BoundedInflater:
            def __init__(self):
                self.inner = factory()
            def decompress(self, data, max_length=0):
                if not 0 < max_length <= 65536:
                    raise AssertionError("Unbounded PNG decode")
                result = self.inner.decompress(data, max_length)
                calls.append((max_length, len(result)))
                return result
            def flush(self, *args):
                raise AssertionError("PNG decoder must not flush unbounded output")
            def __getattr__(self, name):
                return getattr(self.inner, name)
        with patch.object(subject.zlib, "decompressobj", side_effect=BoundedInflater):
            subject.validate_reader_png(png(1280, 40), 1280, 40)
        self.assertGreater(len(calls), 2)
        self.assertTrue(all(produced <= bound for bound, produced in calls))

    def test_check_callback_runs_between_chunks_and_propagates_cancellation_unchanged(self):
        marker = RuntimeError("trusted-cancel-marker")
        calls = 0
        def check():
            nonlocal calls
            calls += 1
            if calls == 5:
                raise marker
        with self.assertRaises(RuntimeError) as caught:
            subject.validate_reader_png(png(1280, 40), 1280, 40, check=check)
        self.assertIs(caught.exception, marker)
        self.assertEqual(calls, 5)

    def test_check_callback_is_not_ignored_at_terminal_validation(self):
        calls = []
        info = subject.validate_reader_png(png(), 2, 2, check=lambda: calls.append(True))
        self.assertEqual(info.width, 2)
        self.assertGreaterEqual(len(calls), 6)

    def test_unsupported_animation_and_compressed_metadata_refuse(self):
        for kind in (b"acTL", b"fcTL", b"fdAT", b"iCCP", b"zTXt", b"iTXt"):
            self.assert_code("FORMAT", png(before=(chunk(kind, b"private-secret"),)))

    def test_known_unique_ancillary_chunks_reject_duplicates_and_bad_order(self):
        gamma = chunk(b"gAMA", struct.pack(">I", 45455))
        self.assert_code("FORMAT", png(before=(gamma, gamma)))
        self.assert_code("FORMAT", png(after=(gamma,)))
        self.assert_code("FORMAT", png(before=(chunk(b"PLTE", b"abc"), gamma)))
        self.assert_code("FORMAT", png(after=(chunk(b"pHYs", struct.pack(">IIB", 1, 1, 1)),)))

    def test_palette_histogram_and_transparency_constraints_are_strict(self):
        for body in (b"", b"ab", b"abcd", b"x" * 771):
            self.assert_code("FORMAT", png(before=(chunk(b"PLTE", body),)))
        self.assert_code("FORMAT", png(before=(chunk(b"hIST", b"\0\0"),)))
        self.assert_code("FORMAT", png(2, 2, 6, before=(chunk(b"tRNS", struct.pack(">HHH", 1, 2, 3)),)))
        self.assert_code("FORMAT", png(before=(chunk(b"tRNS", struct.pack(">HHH", 256, 0, 0)),)))

    def test_known_ancillary_payload_lengths_and_values_are_validated(self):
        for kind, body in ((b"cHRM", b"short"), (b"gAMA", b"\0" * 4), (b"sRGB", b"\x04"),
                           (b"sBIT", b"\x08\x08\x09"), (b"pHYs", struct.pack(">IIB", 1, 1, 2)),
                           (b"bKGD", struct.pack(">HHH", 0, 0, 256)),
                           (b"tIME", struct.pack(">HBBBBB", 2026, 2, 30, 1, 1, 1))):
            self.assert_code("FORMAT", png(before=(chunk(kind, body),)))

    def test_text_keyword_rules_reject_unsafe_or_malformed_text_chunks(self):
        for body in (b"\0secret", b"no-delimiter", b" leading\0secret", b"double  space\0secret", b"a\0b\0c"):
            self.assert_code("FORMAT", png(before=(chunk(b"tEXt", body),)))

    def test_validation_errors_never_include_private_encoded_or_decoded_content(self):
        secret = b"private-request-image-secret"
        for data in (secret, png(raw=secret), png(before=(chunk(b"ABCD", secret),))):
            error = self.assert_code("FORMAT", data)
            self.assertNotIn(secret.decode(), str(error))
            self.assertEqual(str(error), "Reader PNG encoding is unsupported or invalid")


if __name__ == "__main__":
    unittest.main()
