"""Stage a pinned owner-supplied plugin artifact; never load compositor code."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct

MAX_BINARY = 64 * 1024 * 1024
FIELDS = {"schema", "binary", "binary_sha256", "source", "source_sha256",
          "abi_hash", "commit", "version"}


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def input_file(value, maximum, private=False):
    path = Path(value)
    if (not path.is_absolute() or str(path.resolve(strict=True)) != str(path)
            or any(ord(char) < 32 or ord(char) == 127 for char in str(path))):
        raise ValueError("Plugin input must be an absolute canonical path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_size > maximum
                or stat.S_IMODE(info.st_mode) & 0o022
                or (private and stat.S_IMODE(info.st_mode) != 0o600)):
            raise ValueError("Plugin input must be bounded, owned and unshared")
        if private:
            parent = path.parent.lstat()
            if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
                raise ValueError("Plugin manifest directory must be private")
        return path, fd, info
    except BaseException:
        os.close(fd)
        raise


def unchanged(path, fd, before):
    if fingerprint(os.fstat(fd)) != fingerprint(before) or fingerprint(path.lstat()) != fingerprint(before):
        raise RuntimeError("Plugin input changed while staging")


def digest(fd, maximum):
    result = hashlib.sha256()
    size = 0
    while True:
        part = os.read(fd, 65536)
        if not part:
            break
        size += len(part)
        if size > maximum:
            raise ValueError("Plugin input grew beyond its bound")
        result.update(part)
    return result.hexdigest()


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate plugin manifest field")
        result[key] = value
    return result


def verify_staged_plugin(directory_fd, artifact):
    """Recheck the staged identity and bytes immediately before publication."""
    fd = os.open("plugin.so", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1
                or before.st_size > MAX_BINARY
                or list(fingerprint(before)) != artifact["file_identity"]):
            raise RuntimeError("Staged plugin identity changed before publication")
        if before.st_size != artifact["bytes"] or digest(fd, MAX_BINARY) != artifact["binary_sha256"]:
            raise RuntimeError("Staged plugin digest changed before publication")
        if (fingerprint(os.fstat(fd)) != fingerprint(before)
                or fingerprint(os.stat("plugin.so", dir_fd=directory_fd, follow_symlinks=False)) != fingerprint(before)):
            raise RuntimeError("Staged plugin changed during publication verification")
    finally:
        os.close(fd)


def stage_plugin(directory_fd, manifest_path, plan):
    """Copy only a verified ELF; failed partial preparation remains reviewable."""
    directory = os.fstat(directory_fd)
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid()
            or stat.S_IMODE(directory.st_mode) != 0o700):
        raise ValueError("Plugin destination must be a private owned directory")
    descriptors = []
    try:
        path, manifest_fd, before = input_file(manifest_path, 65536, private=True)
        descriptors.append(manifest_fd)
        data = os.read(manifest_fd, 65537)
        if len(data) > 65536 or len(data) != before.st_size:
            raise ValueError("Plugin manifest is too large or incompletely read")
        manifest = json.loads(data, object_pairs_hook=unique_fields)
        if not isinstance(manifest, dict) or set(manifest) != FIELDS or type(manifest["schema"]) is not int or manifest["schema"] != 1:
            raise ValueError("Unknown plugin build manifest")
        if any(not isinstance(manifest[key], str) for key in FIELDS - {"schema"}):
            raise ValueError("Plugin build fields must be strings")
        for key in ("binary_sha256", "source_sha256"):
            if not re.fullmatch(r"[0-9a-f]{64}", manifest[key]):
                raise ValueError("Plugin digest must be a SHA256 hex string")
        for key in ("abi_hash", "commit", "version"):
            if manifest[key] != plan.get(key):
                raise ValueError("Plugin build identity differs from the prepared host")
        unchanged(path, manifest_fd, before)
        source, source_fd, source_info = input_file(manifest["source"], MAX_BINARY)
        descriptors.append(source_fd)
        if digest(source_fd, MAX_BINARY) != manifest["source_sha256"]:
            raise ValueError("Plugin source digest differs from its pin")
        unchanged(source, source_fd, source_info)
        binary, binary_fd, binary_info = input_file(manifest["binary"], MAX_BINARY)
        descriptors.append(binary_fd)
        if digest(binary_fd, MAX_BINARY) != manifest["binary_sha256"]:
            raise ValueError("Plugin binary digest differs from its pin")
        unchanged(binary, binary_fd, binary_info)
        os.lseek(binary_fd, 0, os.SEEK_SET)
        header = os.read(binary_fd, 64)
        if (len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01"
                or struct.unpack_from("<HHI", header, 16) != (3, 62, 1)):
            raise ValueError("Plugin must be an ELF64 little-endian x86-64 shared object")
        os.lseek(binary_fd, 0, os.SEEK_SET)
        output_fd = os.open("plugin.so", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o600, dir_fd=directory_fd)
        with os.fdopen(output_fd, "wb") as output:
            copied = hashlib.sha256()
            size = 0
            while True:
                part = os.read(binary_fd, 65536)
                if not part:
                    break
                size += len(part)
                if size > MAX_BINARY:
                    raise ValueError("Plugin binary grew during copy")
                output.write(part)
                copied.update(part)
            output.flush()
            os.fsync(output.fileno())
            if size != binary_info.st_size or copied.hexdigest() != manifest["binary_sha256"]:
                raise RuntimeError("Copied plugin differs from its pin")
            os.lseek(output.fileno(), 0, os.SEEK_SET)
            if digest(output.fileno(), MAX_BINARY) != manifest["binary_sha256"]:
                raise RuntimeError("Staged plugin readback differs from its pin")
            output_info = os.fstat(output.fileno())
        if fingerprint(os.stat("plugin.so", dir_fd=directory_fd, follow_symlinks=False)) != fingerprint(output_info):
            raise RuntimeError("Staged plugin path changed before publication")
        unchanged(binary, binary_fd, binary_info)
        unchanged(source, source_fd, source_info)
        unchanged(path, manifest_fd, before)
        return {"schema": 1, "file": "plugin.so", "bytes": size,
                "file_identity": list(fingerprint(output_info)),
                "binary_sha256": manifest["binary_sha256"],
                "source_sha256": manifest["source_sha256"],
                "build_identity": {key: manifest[key] for key in ("abi_hash", "commit", "version")},
                "manifest_sha256": hashlib.sha256(data).hexdigest(),
                "provenance": "owner-supplied build metadata, not compiler attestation",
                "compositor_loader": "not run", "owner_activation": "not performed"}
    finally:
        failures = []
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("Plugin input descriptor cleanup failed", failures)
