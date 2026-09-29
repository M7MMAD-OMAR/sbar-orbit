"""Measure a disposable directory grant and pathname UNIX socket exposure.

Run with: bun run scripts/limited.ts /usr/bin/python3 experiments/shared-directory-socket-probe.py
Only temporary files and sockets are used. No application or personal file is opened.
"""

import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile


CHILD = r'''
import json
import os
import socket
import sys
import time

root = '/mnt/fixture/project'
mode = sys.argv[1]
if mode == 'landlock':
    sys.path.insert(0, '/mnt')
    import landlock_unix
    info = os.lstat(root + '/allowed.sock')
    policy = landlock_unix.make_ruleset([{
        'path': root + '/allowed.sock',
        'device': str(info.st_dev),
        'inode': str(info.st_ino),
    }])
    landlock_unix.restrict_child(policy)
assert not os.path.exists('/mnt/fixture/unselected')
assert not os.path.exists('/tmp/orbit-shared-directory-socket-probe.py')
with open(root + '/selected.txt') as stream:
    before = stream.read()
with open(root + '/temporary.txt', 'w') as stream:
    stream.write('after-atomic-save')
os.replace(root + '/temporary.txt', root + '/selected.txt')
print('READY', flush=True)
deadline = time.monotonic() + 4
while not os.path.exists(root + '/late.sock') and time.monotonic() < deadline:
    time.sleep(.02)
try:
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(root + '/late.sock')
        socket_result = {'reply': connection.recv(128).decode()}
except OSError as error:
    socket_result = {'errno': error.errno}
with open(root + '/selected.txt') as stream:
    saved = stream.read()
print(json.dumps({'initialFile': before, 'socket': socket_result,
                  'selectedFile': saved}), flush=True)
'''


def run(mode):
    with tempfile.TemporaryDirectory(prefix='orbit-dir-probe-') as base:
        project = os.path.join(base, 'project')
        os.mkdir(project, 0o700)
        Path(project, 'selected.txt').write_text('before')
        Path(base, 'unselected').write_text('hidden')
        allowed = socket.socket(socket.AF_UNIX)
        allowed.bind(os.path.join(project, 'allowed.sock'))
        allowed.listen(1)
        fd = os.open(project, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        helper = Path(__file__).resolve().parents[1] / 'src/native/landlock_unix.py'
        command = [
            '/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--unshare-ipc',
            '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
            '--tmpfs', '/mnt', '--ro-bind', str(helper), '/mnt/landlock_unix.py',
            '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/mnt/fixture',
            '--dir', '/mnt/fixture/project', '--bind-fd', str(fd), '/mnt/fixture/project',
            '--chdir', '/', '/usr/bin/python3', '-c', CHILD, mode,
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, pass_fds=(fd,))
        os.close(fd)
        try:
            assert select.select([process.stdout], [], [], 5)[0], 'child ready timeout'
            ready = process.stdout.readline().strip()
            if ready != 'READY':
                raise RuntimeError(f'child did not become ready: {ready!r}; {process.stderr.read()[:256]}')
            late = socket.socket(socket.AF_UNIX)
            late.bind(os.path.join(project, 'late.sock'))
            late.listen(1)
            late.settimeout(3)
            try:
                if mode == 'baseline':
                    connection, _ = late.accept()
                    with connection:
                        connection.sendall(b'host-socket-reached')
                output, error = process.communicate(timeout=5)
            finally:
                late.close()
            assert process.returncode == 0, error[:256]
            child = json.loads(output)
            assert child['selectedFile'] == 'after-atomic-save'
            assert Path(project, 'selected.txt').read_text() == 'after-atomic-save'
            if mode == 'baseline':
                assert child['socket'] == {'reply': 'host-socket-reached'}, child
            else:
                assert child['socket'] == {'errno': 13}, child
            return {'mode': mode, 'atomicSaveVisibleOnHost': True,
                    'lateHostSocket': child['socket'], 'siblingHidden': True}
        finally:
            allowed.close()
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == '__main__':
    print(json.dumps([run('baseline'), run('landlock')], sort_keys=True))
