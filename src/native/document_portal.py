"""Research adapter for exact document portal exports into a private mount.

This is not wired into an Orbit launcher. The portal follows an exported host
pathname after the initial grant. Atomic replacement is useful for editors, but
host-side hardlink substitution can expose a different same-user file. Keep the
existing exact-file descriptor mount as the production path until that limit has
an enforceable answer.
"""

import os
import stat

from gi.repository import Gio, GLib

from zen_file_mount import ZenFileMountError, _directory_identity, _open_file, _parts


class DocumentPortalError(ValueError):
    pass


_BUS_NAME = "org.freedesktop.portal.Documents"
_OBJECT = "/org/freedesktop/portal/documents"
_DIR_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _call(connection, method, parameters, reply_type=None):
    return connection.call_sync(
        _BUS_NAME, _OBJECT, _BUS_NAME, method, parameters,
        GLib.VariantType(reply_type) if reply_type else None,
        Gio.DBusCallFlags.NONE, 5000, None,
    )


def _mount_point(connection):
    raw = _call(connection, "GetMountPoint", None, "(ay)").unpack()[0]
    path = os.fsdecode(bytes(raw).rstrip(b"\0"))
    expected = f"/run/user/{os.getuid()}/doc"
    if path != expected or os.path.realpath(path) != path or not os.path.ismount(path):
        raise DocumentPortalError("Document portal mount is unavailable")
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise DocumentPortalError("Document portal mount has unsafe ownership")
    return path


def _add(connection, source_fd):
    # The installed portal rejects O_PATH descriptors that retain O_NOFOLLOW.
    # Reopen the already validated descriptor, not its mutable host pathname.
    portal_fd = os.open(f"/proc/self/fd/{source_fd}", os.O_PATH | os.O_CLOEXEC)
    try:
        original = os.fstat(source_fd)
        reopened = os.fstat(portal_fd)
        if (original.st_dev, original.st_ino) != (reopened.st_dev, reopened.st_ino):
            raise DocumentPortalError("Selected document changed before grant")
        descriptors = Gio.UnixFDList.new()
        handle = descriptors.append(portal_fd)
        result, _ = connection.call_with_unix_fd_list_sync(
            _BUS_NAME, _OBJECT, _BUS_NAME, "Add",
            GLib.Variant("(hbb)", (handle, False, False)),
            GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 5000,
            descriptors, None,
        )
    finally:
        os.close(portal_fd)
    doc_id = result.unpack()[0]
    if (not isinstance(doc_id, str) or not doc_id or
            doc_id in (".", "..") or "/" in doc_id or "\0" in doc_id):
        raise DocumentPortalError("Document portal returned an invalid ID")
    return doc_id


def _delete(connection, doc_id):
    _call(connection, "Delete", GLib.Variant("(s)", (doc_id,)))


class DocumentPortalMounts:
    """Own temporary document grants until the mounted child has exited."""

    def __init__(self, connection, options, descriptors, visible, doc_ids):
        self.connection = connection
        self.options = options
        self.descriptors = descriptors
        self.visible = visible
        self.doc_ids = doc_ids
        self._closed = False

    def close(self):
        if self._closed:
            return
        self._closed = True
        failure = None
        for fd in self.descriptors:
            try:
                os.close(fd)
            except OSError as error:
                if failure is None:
                    failure = error
        for doc_id in reversed(self.doc_ids):
            try:
                _delete(self.connection, doc_id)
            except Exception as error:
                if failure is None:
                    failure = error
        if failure is not None:
            raise DocumentPortalError("Document portal cleanup failed") from failure

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        try:
            self.close()
        except DocumentPortalError:
            if kind is None:
                raise
        return False


def prepare_document_portal_mounts(paths, protected_directories):
    """Grant selected regular files and return one isolated FUSE subtree each.

    Pass ``descriptors`` to bubblewrap and call ``close`` after its child exits.
    Prefer ``with`` so portal Delete runs in a finally path. The caller must
    authorize selected paths and hold its existing cooperative file leases.
    """
    if (not isinstance(paths, list) or not 1 <= len(paths) <= 16 or
            not isinstance(protected_directories, list) or
            not protected_directories or any(not isinstance(path, str) for path in paths) or
            len(set(paths)) != len(paths)):
        raise DocumentPortalError("Invalid document portal file policy")
    try:
        protected = {_directory_identity(path) for path in protected_directories}
    except (ZenFileMountError, OSError) as error:
        raise DocumentPortalError("Protected file directories are unavailable") from error

    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    mount_point = _mount_point(connection)
    options = ["--dir", "/orbit/shared"]
    descriptors = []
    visible = []
    doc_ids = []
    identities = set()
    try:
        for index, path in enumerate(paths):
            try:
                source_fd = _open_file(path, protected)
            except (ZenFileMountError, OSError) as error:
                raise DocumentPortalError("Selected document is not an allowed regular file") from error
            try:
                source = os.fstat(source_fd)
                identity = source.st_dev, source.st_ino
                if identity in identities:
                    raise DocumentPortalError("Duplicate document file identity")
                identities.add(identity)
                doc_id = _add(connection, source_fd)
                doc_ids.append(doc_id)
                current = os.stat(path, follow_symlinks=False)
                if ((current.st_dev, current.st_ino) != identity or
                        not stat.S_ISREG(current.st_mode) or current.st_nlink != 1):
                    raise DocumentPortalError("Selected document changed during grant")
            finally:
                os.close(source_fd)

            portal_directory = os.path.join(mount_point, doc_id)
            portal_fd = os.open(portal_directory, _DIR_FLAGS)
            descriptors.append(portal_fd)
            name = _parts(path)[-1]
            portal_file = os.stat(name, dir_fd=portal_fd, follow_symlinks=False)
            if not stat.S_ISREG(portal_file.st_mode):
                raise DocumentPortalError("Document portal did not expose a regular file")
            destination = f"/orbit/shared/{index + 1}"
            options.extend(["--dir", destination, "--bind-fd", str(portal_fd), destination])
            visible.append(destination + "/" + name)
        return DocumentPortalMounts(connection, options, descriptors, visible, doc_ids)
    except Exception:
        lease = DocumentPortalMounts(connection, options, descriptors, visible, doc_ids)
        try:
            lease.close()
        except DocumentPortalError:
            pass
        raise
