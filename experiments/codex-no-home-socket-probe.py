"""Launch a copied Desktop with no HOME socket grant on a disposable display.

Run with: bun run scripts/limited.ts timeout 60s /usr/bin/python3 experiments/codex-no-home-socket-probe.py
Add --gtk to use gtk3-demo as a fallback comparison. No personal profile is read.
"""

import fcntl
import json
import os
from pathlib import Path
import pwd
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

from Xlib import display as xdisplay
from Xlib.X import IsViewable


APP = Path('/var/tmp/orbit-codex-candidate-review/app/ChatGPT')
ORIGINAL = Path('/usr/lib/chatgpt/ChatGPT')
HELPER = Path(__file__).resolve().parents[1] / 'src/native/landlock_unix.py'
TRACE = Path(__file__).with_name('socket-home-trace.c')
UID = os.getuid()
HOST_HOME = pwd.getpwuid(UID).pw_dir


BOOTSTRAP = r'''
import json
import os
import sys

sys.path.insert(0, '/mnt/orbit-probe')
import landlock_unix as landlock

with open('/mnt/orbit-probe/policy.json', encoding='utf8') as stream:
    policy = json.load(stream)
if set(policy) != {'sockets', 'runtime'} or policy['runtime'] != '/run/user/' + str(os.getuid()):
    raise ValueError('invalid disposable socket policy')
landlock_fd = landlock.make_ruleset(policy['sockets'])
for directory in ('/tmp', policy['runtime']):
    fd = os.open(directory, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        landlock.add_path_rule(landlock_fd, fd, landlock.ACCESS_FS_RESOLVE_UNIX)
    finally:
        os.close(fd)
landlock.restrict_child(landlock_fd)
with open(os.environ['HOME'] + '/policy-applied', 'w') as marker:
    marker.write('yes')
os.execv(sys.argv[1], sys.argv[1:])
'''


def sealed(name, data):
    fd = os.memfd_create(name, os.MFD_ALLOW_SEALING)
    os.write(fd, data)
    os.lseek(fd, 0, os.SEEK_SET)
    seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
    assert fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals
    return fd


def stop(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    except ProcessLookupError:
        pass


def windows(display_number):
    connection = xdisplay.Display(f':{display_number}')
    try:
        root = connection.screen().root
        found = []
        pending = [(root, 0)]
        while pending:
            window, depth = pending.pop()
            if depth > 3:
                continue
            try:
                for child in window.query_tree().children:
                    pending.append((child, depth + 1))
                    if child.get_attributes().map_state == IsViewable:
                        name = child.get_wm_name()
                        window_class = child.get_wm_class() or ()
                        found.append({'id': child.id, 'name': str(name or '')[:80],
                                      'class': [str(part)[:80] for part in window_class]})
            except Exception:
                continue
        return found
    finally:
        connection.close()


def main(app_name):
    if app_name == 'codex':
        assert APP.is_file() and not APP.is_symlink() and not os.path.samefile(APP, ORIGINAL)
        assert not os.path.samefile(APP.parent / 'resources/app.asar',
                                   ORIGINAL.parent / 'resources/app.asar')
        executable = str(APP)
    else:
        executable = '/usr/bin/gtk3-demo'
    assert Path(executable).is_file()
    with tempfile.TemporaryDirectory(prefix='orbit-nohome-socket-', dir='/var/tmp') as base:
        root = Path(base)
        home = root / 'home'
        runtime = root / 'runtime'
        home.mkdir(mode=0o700)
        runtime.mkdir(mode=0o700)
        for directory in ('.codex', '.config', '.local/share', '.cache', 'user-data'):
            (home / directory).mkdir(mode=0o700, parents=True)
        trace_path = home / 'socket-trace.log'
        trace_path.touch(mode=0o600)
        tracer = root / 'socket-home-trace.so'
        subprocess.run(['gcc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(TRACE), '-o', str(tracer), '-ldl'], check=True, timeout=10)
        display_number = next(number for number in range(230, 290)
                              if not Path(f'/tmp/.X11-unix/X{number}').exists()
                              and not Path(f'/tmp/.X{number}-lock').exists())
        authority = root / 'xauth'
        subprocess.run(['/usr/bin/xauth', '-f', str(authority), 'add', f':{display_number}',
                        'MIT-MAGIC-COOKIE-1', secrets.token_hex(16)],
                       check=True, capture_output=True, timeout=5)
        authority.chmod(0o600)
        previous_authority = os.environ.get('XAUTHORITY')
        os.environ['XAUTHORITY'] = str(authority)
        xlog = (root / 'xvnc.log').open('wb')
        app_log = (root / 'app.log').open('wb')
        xvnc = None
        child = None
        try:
            xvnc = subprocess.Popen(['/usr/bin/Xvnc', f':{display_number}', '-geometry',
                                     '1024x768', '-depth', '24', '-nolisten', 'tcp', '-localhost',
                                     '-SecurityTypes', 'None', '-rfbunixpath', str(root / 'viewer.sock'),
                                     '-auth', str(authority)], stdin=subprocess.DEVNULL,
                                    stdout=xlog, stderr=subprocess.STDOUT, start_new_session=True)
            x11_path = Path(f'/tmp/.X11-unix/X{display_number}')
            for _ in range(100):
                if x11_path.is_socket():
                    break
                if xvnc.poll() is not None:
                    raise RuntimeError('disposable Xvnc exited')
                time.sleep(.05)
            assert x11_path.is_socket(), 'disposable Xvnc did not start'
            info = x11_path.lstat()
            assert stat.S_ISSOCK(info.st_mode) and info.st_uid == UID
            policy = {'runtime': f'/run/user/{UID}',
                      'sockets': [{'path': str(x11_path), 'device': str(info.st_dev),
                                   'inode': str(info.st_ino)}]}
            helper_fd = sealed('landlock-helper', HELPER.read_bytes())
            bootstrap_fd = sealed('socket-bootstrap', BOOTSTRAP.encode())
            policy_fd = sealed('socket-policy', json.dumps(policy).encode())
            home_fd = os.open(home, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            runtime_fd = os.open(runtime, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            x11_fd = os.open(x11_path, os.O_PATH | os.O_NOFOLLOW)
            if app_name == 'codex':
                app_command = ['/usr/bin/dbus-run-session', '--', executable, '--no-sandbox',
                               '--disable-gpu', '--password-store=basic',
                               f'--user-data-dir={HOST_HOME}/user-data']
            else:
                app_command = ['/usr/bin/dbus-run-session', '--', executable]
            command = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc',
                       '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/',
                       '--tmpfs', '/home', '--dir', HOST_HOME, '--bind-fd', str(home_fd),
                       HOST_HOME, '--bind-fd', str(runtime_fd), f'/run/user/{UID}',
                       '--tmpfs', '/tmp', '--dir', '/tmp/.X11-unix', '--bind-fd', str(x11_fd),
                       str(x11_path), '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/mnt',
                       '--dir', '/mnt/orbit-probe', '--ro-bind-data', str(helper_fd),
                       '/mnt/orbit-probe/landlock_unix.py', '--ro-bind-data', str(bootstrap_fd),
                       '/mnt/orbit-probe/bootstrap.py', '--ro-bind-data', str(policy_fd),
                       '/mnt/orbit-probe/policy.json', '--chdir', HOST_HOME,
                       '/usr/bin/python3', '-I', '-S', '/mnt/orbit-probe/bootstrap.py',
                       *app_command]
            environment = {'HOME': HOST_HOME, 'CODEX_HOME': HOST_HOME + '/.codex',
                           'XDG_CONFIG_HOME': HOST_HOME + '/.config',
                           'XDG_DATA_HOME': HOST_HOME + '/.local/share',
                           'XDG_CACHE_HOME': HOST_HOME + '/.cache',
                           'XDG_RUNTIME_DIR': f'/run/user/{UID}', 'DISPLAY': f':{display_number}',
                           'XAUTHORITY': str(authority), 'XDG_SESSION_TYPE': 'x11',
                           'GDK_BACKEND': 'x11', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                           'LD_PRELOAD': str(tracer),
                           'ORBIT_SOCKET_TRACE': HOST_HOME + '/socket-trace.log'}
            if app_name == 'codex':
                environment.update({'CODEX_LINUX_APP_DIR': str(APP.parent),
                                    'CODEX_CLI_PATH': str(APP.parent / 'resources/codex'),
                                    'CODEX_ELECTRON_USER_DATA_PATH': HOST_HOME + '/user-data'})
            descriptors = (home_fd, runtime_fd, x11_fd, helper_fd, bootstrap_fd, policy_fd)
            child = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL,
                                     stdout=app_log, stderr=subprocess.STDOUT,
                                     start_new_session=True, pass_fds=descriptors)
            for fd in descriptors:
                os.close(fd)
            deadline = time.monotonic() + 25
            seen = []
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    break
                seen = windows(display_number)
                if any(item['name'] or item['class'] for item in seen):
                    break
                time.sleep(.25)
            log = (root / 'app.log').read_text(errors='replace')
            trace = trace_path.read_text(errors='replace').splitlines()
            result = {'app': app_name, 'policyApplied': (home / 'policy-applied').exists(),
                      'processAlive': child.poll() is None,
                      'windowCount': len(seen), 'namedWindows': [item['name'] for item in seen
                                                               if item['name']][:6],
                      'windowClasses': [item['class'] for item in seen if item['class']][:6],
                      'homeSocketCalls': len(trace),
                      'homeSocketFailures': sum('result=-1' in line for line in trace),
                      'homeSocketEvents': [line.replace(HOST_HOME, '$HOME') for line in trace[:20]],
                      'appLogSignals': {'offline': 'ERR_INTERNET_DISCONNECTED' in log,
                                        'permissionDenied': 'Permission denied' in log}}
            print(json.dumps(result, sort_keys=True))
            return result
        finally:
            stop(child)
            stop(xvnc)
            app_log.close()
            xlog.close()
            if previous_authority is None:
                os.environ.pop('XAUTHORITY', None)
            else:
                os.environ['XAUTHORITY'] = previous_authority


if __name__ == '__main__':
    main('gtk' if '--gtk' in sys.argv[1:] else 'codex')
