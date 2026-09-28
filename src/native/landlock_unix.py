"""Allow selected pathname UNIX sockets without restricting regular files."""

import ctypes
import os
import stat


CREATE_RULESET = 444
ADD_RULE = 445
RESTRICT_SELF = 446
CREATE_RULESET_VERSION = 1
RULE_PATH_BENEATH = 1
ACCESS_FS_REFER = 1 << 13
ACCESS_FS_RESOLVE_UNIX = 1 << 16
SCOPE_ABSTRACT_UNIX_SOCKET = 1
PR_SET_NO_NEW_PRIVS = 38

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class LandlockUnavailable(Exception):
    pass


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64),
                ("handled_access_net", ctypes.c_uint64),
                ("scoped", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64),
                ("parent_fd", ctypes.c_int32)]


def syscall(number, *args):
    result = libc.syscall(number, *args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def add_path_rule(ruleset_fd, path_fd, rights):
    rule = PathRule(rights, path_fd)
    syscall(ADD_RULE, ruleset_fd, RULE_PATH_BENEATH, ctypes.byref(rule), 0)


def make_ruleset(sockets):
    if not isinstance(sockets, list) or not 1 <= len(sockets) <= 8:
        raise LandlockUnavailable("Expected one to eight exact UNIX socket identities")
    try:
        abi = syscall(CREATE_RULESET, None, 0, CREATE_RULESET_VERSION)
        if abi < 9:
            raise LandlockUnavailable("Pathname UNIX socket isolation needs Landlock ABI 9")
        attr = Ruleset(ACCESS_FS_REFER | ACCESS_FS_RESOLVE_UNIX, 0,
                       SCOPE_ABSTRACT_UNIX_SOCKET)
        ruleset_fd = syscall(CREATE_RULESET, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    except OSError as error:
        raise LandlockUnavailable("Landlock pathname UNIX socket isolation is unavailable") from error
    try:
        # Every other filesystem operation remains governed by ordinary permissions.
        # REFER is special: a Landlock layer denies cross-directory rename by default.
        # Grant it at the root so existing document workflows keep their rename rights.
        root_fd = os.open("/", os.O_PATH | os.O_CLOEXEC)
        try:
            add_path_rule(ruleset_fd, root_fd, ACCESS_FS_REFER)
        finally:
            os.close(root_fd)
        for entry in sockets:
            if (not isinstance(entry, dict) or set(entry) != {"path", "device", "inode"}
                    or not isinstance(entry["path"], str)
                    or not entry["path"].startswith("/") or "\0" in entry["path"]
                    or len(entry["path"]) > 4096
                    or not isinstance(entry["device"], str) or not entry["device"].isdecimal()
                    or not isinstance(entry["inode"], str) or not entry["inode"].isdecimal()):
                raise LandlockUnavailable("Invalid UNIX socket identity")
            fd = os.open(entry["path"], os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                found = os.fstat(fd)
                if (not stat.S_ISSOCK(found.st_mode) or found.st_uid != os.getuid()
                        or found.st_dev != int(entry["device"])
                        or found.st_ino != int(entry["inode"])):
                    raise LandlockUnavailable("UNIX socket changed before launch")
                add_path_rule(ruleset_fd, fd, ACCESS_FS_RESOLVE_UNIX)
            finally:
                os.close(fd)
        return ruleset_fd
    except (OSError, ValueError) as error:
        os.close(ruleset_fd)
        raise LandlockUnavailable("UNIX socket policy could not be installed") from error
    except Exception:
        os.close(ruleset_fd)
        raise


def restrict_child(ruleset_fd):
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    syscall(RESTRICT_SELF, ruleset_fd, 0)
    os.close(ruleset_fd)
