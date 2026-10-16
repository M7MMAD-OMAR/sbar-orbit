"""Derive a file's kernel mapping identity from its retained descriptor."""
import ctypes
import mmap
import os
from pathlib import Path
import stat
import sys


def kernel_file_identity(descriptor):
    """Return the device/inode used in proc maps, without executing the file.

    Btrfs can report a subvolume device from stat and a different superblock
    device from proc maps. A one-byte private mapping of the same descriptor
    asks the kernel for its own mapping identity instead of equating the two.
    ACCESS_COPY never writes the file, and the mapping is never executable.
    """
    if sys.platform != 'linux':
        raise RuntimeError('Kernel file mapping identity requires Linux procfs')
    retained = os.dup(descriptor)
    try:
        before = os.fstat(retained)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
            raise ValueError('Mapping identity requires a nonempty regular file')
        with mmap.mmap(retained, 1, access=mmap.ACCESS_COPY) as probe:
            address = ctypes.addressof(ctypes.c_char.from_buffer(probe))
            with Path('/proc/self/maps').open('rb') as stream:
                data = stream.read(8388609)
            if len(data) > 8388608:
                raise RuntimeError('Local mappings exceeded the inspection bound')
            matches = []
            for line in data.decode().splitlines():
                fields = line.split(maxsplit=5)
                start, end = (int(value, 16) for value in fields[0].split('-'))
                if start <= address < end:
                    major, minor = (int(value, 16) for value in fields[3].split(':'))
                    matches.append((os.makedev(major, minor), int(fields[4])))
            if len(matches) != 1 or matches[0][1] != before.st_ino:
                raise RuntimeError('Local file mapping identity could not be established')
        after = os.fstat(retained)
        attributes = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, name) != getattr(after, name) for name in attributes):
            raise RuntimeError('File changed while deriving mapping identity')
        return matches[0]
    finally:
        os.close(retained)
