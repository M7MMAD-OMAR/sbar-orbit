"""Bounded strict PNG validation for the dormant fixed capture producer.

Validation retains no complete decoded raster and grants no target authority,
provider-completion guarantee or scope/input quiescence receipt.
"""
from dataclasses import dataclass
import datetime
import struct
import zlib


class ReaderPngError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__({"INVALID": "Invalid reader PNG validation arguments",
                          "LIMIT": "Reader PNG exceeds its configured bounds",
                          "FORMAT": "Reader PNG encoding is unsupported or invalid"}[code])


def _fail(code="FORMAT"):
    raise ReaderPngError(code)


@dataclass(frozen=True)
class ReaderPngLimits:
    max_width: int = 1280
    max_height: int = 960
    max_bytes: int = 1048576
    max_chunks: int = 4096

    def __post_init__(self):
        for value, maximum in ((self.max_width, 1280), (self.max_height, 960),
                               (self.max_bytes, 1048576), (self.max_chunks, 4096)):
            if type(value) is not int or not 1 <= value <= maximum:
                _fail("INVALID")


@dataclass(frozen=True)
class ReaderPngInfo:
    width: int
    height: int
    color_type: int


def _keyword(body):
    # PNG Latin-1 keyword: 1..79 bytes, no leading/trailing or repeated spaces.
    zero = next((index for index, value in enumerate(body) if value == 0), -1)
    if not 1 <= zero <= 79:
        _fail()
    word = bytes(body[:zero])
    if (word.startswith(b" ") or word.endswith(b" ") or b"  " in word
            or any(not (32 <= value <= 126 or 161 <= value <= 255) for value in word)):
        _fail()
    return zero


def validate_reader_png(data, expected_width, expected_height, *, limits=ReaderPngLimits(), check=None):
    """Validate one RGB/RGBA noninterlaced 8-bit PNG with bounded zlib output.

    check is a trusted cancellation/deadline callback; its exceptions propagate
    unchanged. No zlib flush or unbounded decompression is used.
    """
    if (type(data) is not bytes or type(limits) is not ReaderPngLimits
            or type(expected_width) is not int or expected_width <= 0
            or type(expected_height) is not int or expected_height <= 0
            or (check is not None and not callable(check))):
        _fail("INVALID")
    limits.__post_init__()
    if expected_width > limits.max_width or expected_height > limits.max_height or len(data) > limits.max_bytes:
        _fail("LIMIT")
    if check is not None:
        check()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        _fail()
    view = memoryview(data)
    offset, chunks, total = 8, 0, 0
    header = None
    inflater = None
    seen_idat = False
    idat_closed = False
    seen = set()
    row_bytes = expected_bytes = 0
    palette_entries = 0

    def feed(payload):
        nonlocal total
        for start in range(0, len(payload), 65536):
            pending = payload[start:start + 65536]
            while True:
                if check is not None:
                    check()
                bound = min(65536, expected_bytes - total + 1)
                if bound <= 0:
                    _fail()
                try:
                    output = inflater.decompress(pending, bound)
                except zlib.error:
                    _fail()
                if len(output) > expected_bytes - total:
                    _fail()
                # Scanline filter bytes recur at exact row boundaries, including
                # boundaries that fall across output blocks or IDAT chunks.
                for index in range((-total) % row_bytes, len(output), row_bytes):
                    if output[index] > 4:
                        _fail()
                total += len(output)
                if inflater.unused_data:
                    _fail()  # Includes a second zlib stream or bytes after EOF.
                tail = inflater.unconsumed_tail
                if tail:
                    if not output and len(tail) == len(pending):
                        _fail()
                    pending = tail
                elif len(output) == bound and not inflater.eof:
                    pending = b""  # Drain bounded pending output, not flush().
                else:
                    break

    while offset < len(data):
        if check is not None:
            check()
        chunks += 1
        if chunks > limits.max_chunks:
            _fail("LIMIT")
        if len(data) - offset < 12:
            _fail()
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        if (length > 2147483647 or end > len(data)
                or any(not (65 <= value <= 90 or 97 <= value <= 122) for value in kind)
                or not 65 <= kind[2] <= 90):
            _fail()
        body = view[offset + 8:offset + 8 + length]
        crc = zlib.crc32(body, zlib.crc32(kind)) & 0xffffffff
        if crc != struct.unpack_from(">I", data, offset + 8 + length)[0]:
            _fail()
        offset = end
        if header is None and kind != b"IHDR":
            _fail()
        if seen_idat and kind != b"IDAT":
            idat_closed = True

        if kind == b"IHDR":
            if header is not None or chunks != 1 or length != 13:
                _fail()
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if width > limits.max_width or height > limits.max_height:
                _fail("LIMIT")
            if ((width, height) != (expected_width, expected_height) or depth != 8
                    or color not in (2, 6) or compression != 0 or filtering != 0 or interlace != 0):
                _fail()
            header = ReaderPngInfo(width, height, color)
            row_bytes = 1 + width * (3 if color == 2 else 4)
            expected_bytes = row_bytes * height
        elif kind == b"IDAT":
            if idat_closed:
                _fail()
            if inflater is None:
                inflater = zlib.decompressobj()
            seen_idat = True
            feed(body)
        elif kind == b"IEND":
            if (length != 0 or not seen_idat or not inflater.eof or inflater.unused_data
                    or inflater.unconsumed_tail or total != expected_bytes or offset != len(data)):
                _fail()
            if check is not None:
                check()
            return header
        elif kind == b"PLTE":
            if (kind in seen or seen_idat or not 3 <= length <= 768 or length % 3
                    or b"tRNS" in seen or b"bKGD" in seen):
                _fail()
            palette_entries = length // 3
            seen.add(kind)
        elif not kind[0] & 32:
            _fail()  # No unknown critical chunks or alternative pixel pipelines.
        else:
            if kind in (b"acTL", b"fcTL", b"fdAT", b"iCCP", b"zTXt", b"iTXt"):
                _fail()  # No animation or compressed metadata decoder in this subset.
            unique = {b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"bKGD", b"hIST", b"tRNS", b"pHYs", b"tIME"}
            if kind in unique and kind in seen:
                _fail()
            if kind in (b"cHRM", b"gAMA", b"sBIT", b"sRGB") and (seen_idat or b"PLTE" in seen):
                _fail()
            if kind in (b"bKGD", b"hIST", b"tRNS", b"pHYs") and seen_idat:
                _fail()
            if kind == b"cHRM" and length != 32:
                _fail()
            if kind == b"gAMA" and (length != 4 or struct.unpack(">I", body)[0] == 0):
                _fail()
            if kind == b"sRGB" and (length != 1 or body[0] > 3):
                _fail()
            if kind == b"sBIT" and (length != (3 if header.color_type == 2 else 4) or any(not 1 <= value <= 8 for value in body)):
                _fail()
            if kind == b"pHYs" and (length != 9 or body[8] not in (0, 1)):
                _fail()
            if kind == b"hIST" and (not palette_entries or length != palette_entries * 2):
                _fail()
            if kind in (b"tRNS", b"bKGD"):
                if (length != 6 or (kind == b"tRNS" and header.color_type != 2)
                        or any(value > 255 for value in struct.unpack(">HHH", body))):
                    _fail()
            if kind == b"tEXt":
                zero = _keyword(body)
                if 0 in body[zero + 1:]:
                    _fail()
            if kind == b"tIME":
                if length != 7:
                    _fail()
                year, month, day, hour, minute, second = struct.unpack(">HBBBBB", body)
                try:
                    datetime.date(year, month, day)
                except ValueError:
                    _fail()
                if hour > 23 or minute > 59 or second > 60:
                    _fail()
            seen.add(kind)
    _fail()  # Missing terminal IEND, including a truncated compressed stream.
