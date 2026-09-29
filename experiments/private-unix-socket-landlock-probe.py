"""Measure pathname socket grants in a disposable private mount.

Run with: bun run scripts/limited.ts /usr/bin/python3 experiments/private-unix-socket-landlock-probe.py
No personal app, profile, window, or file is used.
"""

import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile


PRE_MOUNT = r'''
import os
import stat
import sys

sys.path.insert(0, sys.argv[1])
import landlock_unix as landlock

shared, private_home = sys.argv[2:4]
allowed = shared + '/allowed.sock'
info = os.lstat(allowed)
policy = landlock.make_ruleset([{'path': allowed,
                                 'device': str(info.st_dev), 'inode': str(info.st_ino)}])
for directory in (private_home, '/tmp'):
    fd = os.open(directory, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
    landlock.add_path_rule(policy, fd, landlock.ACCESS_FS_RESOLVE_UNIX)
    os.close(fd)
landlock.restrict_child(policy)
os.execv(sys.argv[4], sys.argv[4:])
'''


CHILD = r'''
import json
import os
import socket
import sys
import time

sys.path.insert(0, '/mnt')
import landlock_unix as landlock

mode = sys.argv[1]
shared = '/mnt/shared'
private_home = '/home/fixture'
if mode == 'post-mount':
    allowed = shared + '/allowed.sock'
    info = os.lstat(allowed)
    policy = landlock.make_ruleset([{'path': allowed,
                                     'device': str(info.st_dev), 'inode': str(info.st_ino)}])
    for directory in (private_home, '/tmp'):
        fd = os.open(directory, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        landlock.add_path_rule(policy, fd, landlock.ACCESS_FS_RESOLVE_UNIX)
        os.close(fd)
    landlock.restrict_child(policy)

results = {}
for label, pathname in [('privateHome', private_home + '/self.sock'),
                        ('privateTmp', '/tmp/self.sock')]:
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(pathname)
    listener.listen(1)
    try:
        with socket.socket(socket.AF_UNIX) as client:
            try:
                client.connect(pathname)
                accepted, _ = listener.accept()
                accepted.close()
                results[label] = 'connected'
            except OSError as error:
                results[label] = {'errno': error.errno}
    finally:
        listener.close()

with open(shared + '/temporary.txt', 'w') as stream:
    stream.write('atomic-save')
os.replace(shared + '/temporary.txt', shared + '/selected.txt')
print('READY', flush=True)
deadline = time.monotonic() + 4
while not os.path.exists(shared + '/late.sock') and time.monotonic() < deadline:
    time.sleep(.02)
try:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(1)
        client.connect(shared + '/late.sock')
        results['lateHostSocket'] = 'connected'
except OSError as error:
    results['lateHostSocket'] = {'errno': error.errno}
with open(shared + '/selected.txt') as stream:
    results['selectedFile'] = stream.read()
print(json.dumps(results), flush=True)
'''


def run(mode):
    with tempfile.TemporaryDirectory(prefix='orbit-private-socket-probe-') as base:
        shared = os.path.join(base, 'shared')
        private_home = os.path.join(base, 'private-home')
        os.mkdir(shared, 0o700)
        os.mkdir(private_home, 0o700)
        Path(shared, 'selected.txt').write_text('before')
        allowed = socket.socket(socket.AF_UNIX)
        allowed.bind(os.path.join(shared, 'allowed.sock'))
        allowed.listen(1)
        shared_fd = os.open(shared, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        home_fd = os.open(private_home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        helper = Path(__file__).resolve().parents[1] / 'src/native/landlock_unix.py'
        command = ['/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--unshare-ipc',
                   '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                   '--tmpfs', '/mnt', '--ro-bind', str(helper), '/mnt/landlock_unix.py',
                   '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/fixture',
                   '--bind-fd', str(home_fd), '/home/fixture', '--dir', '/mnt/shared',
                   '--bind-fd', str(shared_fd), '/mnt/shared', '--chdir', '/',
                   '/usr/bin/python3', '-c', CHILD, mode]
        if mode == 'pre-mount':
            command = ['/usr/bin/python3', '-c', PRE_MOUNT, str(helper.parent),
                       shared, private_home, *command]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, pass_fds=(shared_fd, home_fd))
        os.close(shared_fd)
        os.close(home_fd)
        try:
            assert select.select([process.stdout], [], [], 5)[0], 'child ready timeout'
            ready = process.stdout.readline().strip()
            if ready != 'READY':
                output, error = process.communicate(timeout=5)
                if mode == 'pre-mount' and 'bwrap: Failed to make / slave: Operation not permitted' in error:
                    return {'mode': mode, 'privateMountStarted': False,
                            'failure': 'bwrap mount rejected after parent Landlock restriction'}
                raise RuntimeError(f'child did not become ready: {ready!r}; {error[:512]}')
            late = socket.socket(socket.AF_UNIX)
            late.bind(os.path.join(shared, 'late.sock'))
            late.listen(1)
            try:
                output, error = process.communicate(timeout=5)
            finally:
                late.close()
            assert process.returncode == 0, error[:512]
            result = json.loads(output)
            assert result['selectedFile'] == 'atomic-save', result
            assert Path(shared, 'selected.txt').read_text() == 'atomic-save'
            assert result['lateHostSocket'] == {'errno': 13}, result
            return {'mode': mode, **result}
        finally:
            allowed.close()
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == '__main__':
    print(json.dumps([run('pre-mount'), run('post-mount')], sort_keys=True))
