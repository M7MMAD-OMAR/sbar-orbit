"""Disposable RENAME_EXCHANGE save and conflict preservation experiment."""
import ctypes
import os
import stat
import tempfile
from pathlib import Path

RENAME_EXCHANGE = 2
libc = ctypes.CDLL(None, use_errno=True)
libc.renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p,
                           ctypes.c_int, ctypes.c_char_p,
                           ctypes.c_uint)
libc.renameat2.restype = ctypes.c_int


def exchange(directory, a, b):
    result = libc.renameat2(directory, a.encode(), directory, b.encode(), RENAME_EXCHANGE)
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def info(directory, name):
    return os.stat(name, dir_fd=directory, follow_symlinks=False)


def identity(metadata):
    return metadata.st_dev, metadata.st_ino


def bytes_at(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        return os.read(fd, 4096)
    finally:
        os.close(fd)


def put(directory, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def host_atomic_save(directory, data, name='selected'):
    temporary = 'host-temp'
    put(directory, temporary, data)
    os.rename(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)


def make_candidate(directory, content):
    fd = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC,
                 0o600, dir_fd=directory)
    os.write(fd, content)
    os.fsync(fd)
    os.link(f'/proc/self/fd/{fd}', 'candidate', dst_dir_fd=directory,
            follow_symlinks=True)
    return fd


def preserve_original(source_fd, directory):
    os.lseek(source_fd, 0, os.SEEK_SET)
    put(directory, 'original-artifact', os.read(source_fd, 4096))


def case(root, label):
    path = root / label
    path.mkdir()
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    put(directory, 'selected', b'S: selected at grant')
    source = os.open('selected', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    expected = identity(os.fstat(source))
    agent = make_candidate(directory, b'A: private agent save')
    return directory, source, expected, agent


def main():
    with tempfile.TemporaryDirectory(prefix='orbit-exchange-probe-') as raw:
        root = Path(raw)
        red = root / 'red-unsafe-pathname'
        red.mkdir()
        red_directory = os.open(red, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            put(red_directory, 'selected', b'S: selected at grant')
            put(red_directory, 'unselected', b'X: unselected data')
            os.unlink('selected', dir_fd=red_directory)
            os.link('unselected', 'selected', src_dir_fd=red_directory,
                    dst_dir_fd=red_directory)
            vulnerable = os.open('selected', os.O_WRONLY | os.O_TRUNC,
                                 dir_fd=red_directory)
            try:
                os.write(vulnerable, b'A: private agent save')
            finally:
                os.close(vulnerable)
            assert bytes_at(red_directory, 'unselected') == b'A: private agent save'
            print('RED pathname write changes unselected hardlink bytes')
        finally:
            os.close(red_directory)
        directory, source, expected, agent = case(root, 'normal')
        try:
            exchange(directory, 'candidate', 'selected')
            assert identity(info(directory, 'candidate')) == expected
            assert bytes_at(directory, 'selected') == b'A: private agent save'
            assert bytes_at(directory, 'candidate') == b'S: selected at grant'
            print('GREEN normal exchange keeps the old selected inode at candidate')
        finally:
            os.close(agent); os.close(source); os.close(directory)

        directory, source, expected, agent = case(root, 'late-host-replacement')
        try:
            host_atomic_save(directory, b'B: newer host save')
            exchange(directory, 'candidate', 'selected')
            assert identity(info(directory, 'candidate')) != expected
            assert bytes_at(directory, 'candidate') == b'B: newer host save'
            preserve_original(source, directory)
            exchange(directory, 'candidate', 'selected')
            assert bytes_at(directory, 'selected') == b'B: newer host save'
            assert bytes_at(directory, 'candidate') == b'A: private agent save'
            assert bytes_at(directory, 'original-artifact') == b'S: selected at grant'
            print('GREEN conflict rollback preserves host, agent, and grant versions')
        finally:
            os.close(agent); os.close(source); os.close(directory)

        directory, source, expected, agent = case(root, 'host-race-before-rollback')
        try:
            host_atomic_save(directory, b'B: newer host save')
            exchange(directory, 'candidate', 'selected')
            assert identity(info(directory, 'candidate')) != expected
            host_atomic_save(directory, b'C: latest host save')
            assert identity(info(directory, 'selected')) != identity(os.fstat(agent))
            preserve_original(source, directory)
            put(directory, 'agent-artifact', os.pread(agent, 4096, 0))
            assert bytes_at(directory, 'selected') == b'C: latest host save'
            assert bytes_at(directory, 'candidate') == b'B: newer host save'
            assert bytes_at(directory, 'agent-artifact') == b'A: private agent save'
            assert bytes_at(directory, 'original-artifact') == b'S: selected at grant'
            print('GREEN skip rollback if target changed again, retain all observed versions')
        finally:
            os.close(agent); os.close(source); os.close(directory)

        directory, source, expected, agent = case(root, 'late-hardlink')
        try:
            put(directory, 'unselected', b'X: unselected data')
            os.unlink('selected', dir_fd=directory)
            os.link('unselected', 'selected', src_dir_fd=directory,
                    dst_dir_fd=directory)
            exchange(directory, 'candidate', 'selected')
            assert info(directory, 'candidate').st_nlink == 2
            assert bytes_at(directory, 'unselected') == b'X: unselected data'
            exchange(directory, 'candidate', 'selected')
            assert bytes_at(directory, 'selected') == b'X: unselected data'
            assert bytes_at(directory, 'candidate') == b'A: private agent save'
            assert bytes_at(directory, 'unselected') == b'X: unselected data'
            print('GREEN hardlink substitution keeps the unselected inode intact')
        finally:
            os.close(agent); os.close(source); os.close(directory)

        directory, source, expected, agent = case(root, 'late-symlink')
        try:
            put(directory, 'unselected', b'X: unselected data')
            os.unlink('selected', dir_fd=directory)
            os.symlink('unselected', 'selected', dir_fd=directory)
            exchange(directory, 'candidate', 'selected')
            assert stat.S_ISLNK(info(directory, 'candidate').st_mode)
            assert bytes_at(directory, 'unselected') == b'X: unselected data'
            exchange(directory, 'candidate', 'selected')
            assert stat.S_ISLNK(info(directory, 'selected').st_mode)
            assert bytes_at(directory, 'candidate') == b'A: private agent save'
            assert bytes_at(directory, 'unselected') == b'X: unselected data'
            print('GREEN symlink substitution keeps the unselected inode intact')
        finally:
            os.close(agent); os.close(source); os.close(directory)

        directory, source, expected, agent = case(root, 'rollback-race-after-check')
        try:
            host_atomic_save(directory, b'B: newer host save')
            exchange(directory, 'candidate', 'selected')
            assert identity(info(directory, 'selected')) == identity(os.fstat(agent))
            host_atomic_save(directory, b'C: latest host save')
            exchange(directory, 'candidate', 'selected')
            assert bytes_at(directory, 'selected') == b'B: newer host save'
            assert bytes_at(directory, 'candidate') == b'C: latest host save'
            assert os.pread(agent, 4096, 0) == b'A: private agent save'
            print('LIMIT rollback race moves latest host version into artifact, while bytes remain recoverable')
        finally:
            os.close(agent); os.close(source); os.close(directory)


if __name__ == '__main__':
    main()
