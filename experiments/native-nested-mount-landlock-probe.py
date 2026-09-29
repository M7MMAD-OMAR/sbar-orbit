"""Measure host socket access against nested mount compatibility in a fake app."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile


CHILD = r'''
import json
import os
import socket
import subprocess
import sys

mode, selected, host = sys.argv[1:]
if mode == 'strict':
    sys.path.insert(0, '/tmp/orbit-policy')
    import landlock_unix
    info = os.lstat(selected)
    fd = landlock_unix.make_ruleset([{
        'path': selected, 'device': str(info.st_dev), 'inode': str(info.st_ino),
    }])
    landlock_unix.restrict_child(fd)
try:
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(host)
    host_result = 'connected'
except OSError as error:
    host_result = error.errno
nested = subprocess.run(['/usr/bin/bwrap', '--bind', '/', '/', '/usr/bin/true'],
                        capture_output=True, text=True, timeout=5)
print(json.dumps({'mode': mode, 'hostSocket': host_result,
                  'nestedExit': nested.returncode,
                  'nestedMountDenied': 'Failed to make / slave' in nested.stderr}))
'''


def run(mode):
    with tempfile.TemporaryDirectory(prefix='orbit-nested-socket-') as root:
        session = Path(root, 'session')
        session.mkdir(mode=0o700)
        host_dir = Path('/var/tmp', 'orbit-host-socket-' + session.parent.name.rsplit('-', 1)[-1])
        host_dir.mkdir(mode=0o700)
        selected = session / 'selected.sock'
        host = host_dir / 'host.sock'
        selected_server = socket.socket(socket.AF_UNIX)
        host_server = socket.socket(socket.AF_UNIX)
        selected_server.bind(str(selected))
        host_server.bind(str(host))
        selected_server.listen(1)
        host_server.listen(1)
        helper = Path(__file__).resolve().parents[1] / 'src/native/landlock_unix.py'
        try:
            command = [
                '/usr/bin/bwrap', '--unshare-pid', '--unshare-ipc', '--die-with-parent',
                '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                '--tmpfs', '/tmp', '--bind', str(session), str(session),
                '--dir', '/tmp/orbit-policy', '--ro-bind', str(helper),
                '/tmp/orbit-policy/landlock_unix.py', '--clearenv',
                '--setenv', 'PATH', '/usr/bin:/bin', '--',
                '/usr/bin/python3', '-I', '-S', '-c', CHILD,
                mode, str(selected), str(host),
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            assert result.returncode == 0, result.stderr[-400:]
            measured = json.loads(result.stdout)
            if mode == 'baseline':
                assert measured['hostSocket'] == 'connected', measured
                assert measured['nestedExit'] == 0, measured
            else:
                assert measured['hostSocket'] == 13, measured
                assert measured['nestedExit'] != 0 and measured['nestedMountDenied'], measured
            return measured
        finally:
            selected_server.close()
            host_server.close()
            selected.unlink(missing_ok=True)
            host.unlink(missing_ok=True)
            host_dir.rmdir()


if __name__ == '__main__':
    print(json.dumps([run('baseline'), run('strict')], sort_keys=True))
