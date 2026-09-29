"""Test a sealed post-mount Landlock bootstrap with disposable app data.

Run with: bun run scripts/limited.ts timeout 30s /usr/bin/python3 experiments/private-socket-bootstrap-probe.py
The production supervisor and personal applications are not changed.
"""

import fcntl
import json
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import tempfile


BOOTSTRAP = r'''
import json
import os
import stat
import sys

sys.path.insert(0, '/mnt/orbit-bootstrap')
import landlock_unix as landlock

try:
    with open('/mnt/orbit-bootstrap/policy.json', encoding='utf8') as stream:
        policy = json.load(stream)
    if set(policy) != {'privateHome', 'sharedAlias', 'sharedTarget', 'sockets'}:
        raise ValueError('invalid policy fields')
    home = policy['privateHome']
    alias = policy['sharedAlias']
    target = policy['sharedTarget']
    if (home != '/home/example' or alias != home + '/project'
            or target != '/mnt/shared' or os.path.realpath(alias) != target
            or not stat.S_ISLNK(os.lstat(alias).st_mode)
            or os.path.commonpath([home, target]) == home):
        raise ValueError('unsafe shared mount layout')
    info = os.lstat(home)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise ValueError('unsafe private home')
    landlock_fd = landlock.make_ruleset(policy['sockets'])
    for directory in (home, '/tmp'):
        fd = os.open(directory, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            landlock.add_path_rule(landlock_fd, fd, landlock.ACCESS_FS_RESOLVE_UNIX)
        finally:
            os.close(fd)
    landlock.restrict_child(landlock_fd)
except Exception as error:
    print('BOOTSTRAP_DENIED:' + str(error), file=sys.stderr, flush=True)
    sys.exit(78)
os.execv(sys.argv[1], sys.argv[1:])
'''


SYNTHETIC_APP = r'''
import json
import os
import socket
import time

home = '/home/example'
shared = home + '/project'
with open(home + '/app-started', 'w') as marker:
    marker.write('after-policy')
results = {'canonicalProject': os.path.realpath(shared)}
with socket.socket(socket.AF_UNIX) as client:
    client.connect(shared + '/allowed.sock')
    results['allowedHostSocket'] = 'connected'
for label, pathname in [('privateHome', home + '/self.sock'),
                        ('privateTmp', '/tmp/self.sock')]:
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(pathname)
    listener.listen(1)
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(pathname)
            accepted, _ = listener.accept()
            accepted.close()
            results[label] = 'connected'
    finally:
        listener.close()
with open(shared + '/temporary.txt', 'w') as stream:
    stream.write('after-policy-save')
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
print(json.dumps(results), flush=True)
'''


def sealed_memfd(name, content):
    fd = os.memfd_create(name, os.MFD_ALLOW_SEALING)
    os.write(fd, content)
    os.lseek(fd, 0, os.SEEK_SET)
    seals = (fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK
             | fcntl.F_SEAL_SEAL)
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
    assert fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals
    return fd


def run(layout):
    with tempfile.TemporaryDirectory(prefix='orbit-bootstrap-probe-') as base:
        shared = os.path.join(base, 'shared')
        private_home = os.path.join(base, 'private-home')
        os.mkdir(shared, 0o700)
        os.mkdir(private_home, 0o700)
        Path(shared, 'selected.txt').write_text('before')
        allowed = socket.socket(socket.AF_UNIX)
        allowed.bind(os.path.join(shared, 'allowed.sock'))
        allowed.listen(1)
        info = os.lstat(os.path.join(shared, 'allowed.sock'))
        socket_path = ('/mnt/shared/allowed.sock' if layout == 'symlink'
                       else '/home/example/project/allowed.sock')
        policy = {'privateHome': '/home/example', 'sharedAlias': '/home/example/project',
                  'sharedTarget': '/mnt/shared',
                  'sockets': [{'path': socket_path, 'device': str(info.st_dev),
                               'inode': str(info.st_ino)}]}
        helper_path = Path(__file__).resolve().parents[1] / 'src/native/landlock_unix.py'
        helper_fd = sealed_memfd('fixture-landlock-helper', helper_path.read_bytes())
        bootstrap_fd = sealed_memfd('fixture-bootstrap', BOOTSTRAP.encode())
        policy_fd = sealed_memfd('fixture-policy', json.dumps(policy).encode())
        shared_fd = os.open(shared, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        home_fd = os.open(private_home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        mount = (['--dir', '/mnt/shared', '--bind-fd', str(shared_fd), '/mnt/shared',
                  '--symlink', '/mnt/shared', '/home/example/project'] if layout == 'symlink'
                 else ['--dir', '/home/example/project', '--bind-fd', str(shared_fd),
                       '/home/example/project'])
        command = ['/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--unshare-ipc',
                   '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                   '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/example',
                   '--bind-fd', str(home_fd), '/home/example', '--tmpfs', '/mnt',
                   '--dir', '/mnt/orbit-bootstrap',
                   '--ro-bind-data', str(helper_fd), '/mnt/orbit-bootstrap/landlock_unix.py',
                   '--ro-bind-data', str(bootstrap_fd), '/mnt/orbit-bootstrap/bootstrap.py',
                   '--ro-bind-data', str(policy_fd), '/mnt/orbit-bootstrap/policy.json',
                   *mount, '--chdir', '/', '/usr/bin/python3', '-I', '-S',
                   '/mnt/orbit-bootstrap/bootstrap.py', '/usr/bin/python3', '-I', '-S',
                   '-c', SYNTHETIC_APP]
        descriptors = (helper_fd, bootstrap_fd, policy_fd, shared_fd, home_fd)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, pass_fds=descriptors)
        for fd in descriptors:
            os.close(fd)
        try:
            assert select.select([process.stdout], [], [], 5)[0], 'child timeout'
            first = process.stdout.readline().strip()
            if layout == 'nested':
                output, error = process.communicate(timeout=5)
                assert process.returncode == 78, (process.returncode, error)
                assert 'BOOTSTRAP_DENIED:unsafe shared mount layout' in error, error
                assert not Path(private_home, 'app-started').exists()
                assert Path(shared, 'selected.txt').read_text() == 'before'
                return {'layout': layout, 'bootstrapDenied': True, 'appStarted': False}
            assert first == 'READY', (first, process.stderr.read()[:512])
            late = socket.socket(socket.AF_UNIX)
            late.bind(os.path.join(shared, 'late.sock'))
            late.listen(1)
            try:
                output, error = process.communicate(timeout=5)
            finally:
                late.close()
            assert process.returncode == 0, error[:512]
            result = json.loads(output)
            assert result == {'canonicalProject': '/mnt/shared',
                              'allowedHostSocket': 'connected',
                              'privateHome': 'connected', 'privateTmp': 'connected',
                              'lateHostSocket': {'errno': 13}}, result
            assert Path(private_home, 'app-started').read_text() == 'after-policy'
            assert Path(shared, 'selected.txt').read_text() == 'after-policy-save'
            return {'layout': layout, 'bootstrapDenied': False, 'appStarted': True,
                    'atomicSaveVisibleOnHost': True, **result}
        finally:
            allowed.close()
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == '__main__':
    print(json.dumps([run('nested'), run('symlink')], sort_keys=True))
