"""Experimental atom remapping for already-framed X11 selection messages.

This does not connect to displays or provide a complete proxy. The caller must
validate credentials, extension identifiers, framing and transport lifetime.
"""
from dataclasses import dataclass
import struct


@dataclass(frozen=True)
class SelectionNamespace:
    clipboard: int
    private_primary: int
    private_clipboard: int
    xfixes_opcode: int
    xfixes_event: int

    def __post_init__(self):
        atoms = (1, self.clipboard, self.private_primary, self.private_clipboard)
        if (len(set(atoms)) != 4 or any(type(atom) is not int or not 0 < atom <= 0xffffffff for atom in atoms)
                or any(atom <= 68 for atom in atoms[1:])):
            raise ValueError("selection namespace requires distinct valid interned atoms")
        if (type(self.xfixes_opcode) is not int or not 128 <= self.xfixes_opcode <= 255
                or type(self.xfixes_event) is not int or not 36 <= self.xfixes_event <= 127):
            raise ValueError("invalid XFixes extension identifiers")

    @staticmethod
    def _order(order):
        if order not in ("<", ">"):
            raise ValueError("invalid X11 byte order")
        return order

    def _atom(self, message, offset, order, reverse=False):
        if offset + 4 > len(message):
            raise ValueError("truncated selection atom")
        value = struct.unpack_from(order + "I", message, offset)[0]
        mapping = {1: self.private_primary, self.clipboard: self.private_clipboard}
        if reverse:
            mapping = {private: public for public, private in mapping.items()}
        mapped = mapping.get(value, value)
        if mapped == value:
            return message
        result = bytearray(message)
        struct.pack_into(order + "I", result, offset, mapped)
        return bytes(result)

    def _selection_event(self, message, order, reverse, start=0):
        if len(message) < start + 32:
            raise ValueError("truncated X11 selection event")
        kind = message[start] & 0x7f
        offsets = {29: 12, 30: 16, 31: 12, self.xfixes_event: 12}
        offset = offsets.get(kind)
        if offset is None:
            return message
        return self._atom(message, start + offset, order, reverse)

    def request(self, message, order):
        """Remap app selection requests without inserting requests or sequences."""
        order = self._order(order)
        if not isinstance(message, bytes) or len(message) < 4 or len(message) % 4:
            raise ValueError("invalid X11 request frame")
        units = struct.unpack_from(order + "H", message, 2)[0]
        shift = 0
        if units == 0:
            if len(message) < 8:
                raise ValueError("truncated extended X11 request")
            units = struct.unpack_from(order + "I", message, 4)[0]
            shift = 4
        if units * 4 != len(message):
            raise ValueError("X11 request length mismatch")
        opcode = message[0]
        selection = {22: (16, 8), 23: (8, 4), 24: (24, 8)}.get(opcode)
        if opcode == self.xfixes_opcode and message[1] == 2:
            selection = (16, 8)
        if selection is not None:
            size, offset = selection
            if len(message) != size + shift:
                raise ValueError("invalid selection request size")
            return self._atom(message, offset + shift, order)
        if opcode == 25:
            if len(message) != 44 + shift:
                raise ValueError("invalid SendEvent request size")
            return self._selection_event(message, order, False, 12 + shift)
        return message

    def server(self, message, order):
        """Remap selection event atoms; preserve replies and sequence numbers."""
        order = self._order(order)
        if not isinstance(message, bytes) or len(message) < 32 or len(message) % 4:
            raise ValueError("invalid X11 server frame")
        kind = message[0] & 0x7f
        size = 32
        if kind in (1, 35):
            size += struct.unpack_from(order + "I", message, 4)[0] * 4
        if size != len(message):
            raise ValueError("X11 server length mismatch")
        if kind in (0, 1, 35):
            return message
        return self._selection_event(message, order, True)
