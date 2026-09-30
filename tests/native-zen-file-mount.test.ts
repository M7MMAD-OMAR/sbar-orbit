import { linuxOnlySuite } from "./platform-support";
import { expect, test as bunTest } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const test = linuxOnlySuite("native Zen file mounts use Linux mount namespaces and Python helpers");

const namespaces = process.platform === "linux" && !!Bun.which("bwrap") &&
  Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--unshare-user", "/usr/bin/true"],
    { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const modulePath = join(dirname(import.meta.dir), "src/native");

function python(source: string) {
  const result = spawnSync("/usr/bin/python3", ["-c", source, modulePath], {
    encoding: "utf8", timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `Python exited ${result.status}`);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

test("Zen exact file policy rejects profile files, links, and special files", () => {
  const result = python(`
import os, pathlib, socket, sys, tempfile
sys.path.insert(0, sys.argv[1])
from zen_file_mount import ZenFileMountError, prepare_zen_file_mounts
with tempfile.TemporaryDirectory(prefix='orbit-zen-files-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    guard = base / 'guard'; guard.mkdir()
    data = base / 'data'; data.mkdir()
    good = data / 'good.txt'; good.write_text('hello')
    secret = profile / 'secret.txt'; secret.write_text('secret')
    runtime_file = runtime / 'bus-secret.txt'; runtime_file.write_text('secret')
    (data / 'link.txt').symlink_to(good)
    (base / 'alias').symlink_to(data, target_is_directory=True)
    os.link(good, data / 'hard.txt')
    os.mkfifo(data / 'pipe')
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(data / 'socket'))
    checks = [str(secret), str(runtime_file), str(data / 'link.txt'),
              str(base / 'alias' / 'good.txt'), str(good), str(data / 'pipe'),
              str(data / 'socket'), str(data / '..' / 'good.txt')]
    denied = 0
    for path in checks:
        try:
            _, fds, _ = prepare_zen_file_mounts([path], [str(profile), str(runtime), str(guard)])
        except (ZenFileMountError, OSError):
            denied += 1
        else:
            for fd in fds: os.close(fd)
    sock.close()
    print(denied)
`);
  expect(result).toBe("8");
});

bunTest.if(namespaces)("Zen exact file mount writes one selected host inode and hides its sibling", () => {
  const result = python(`
import os, pathlib, subprocess, sys, tempfile
sys.path.insert(0, sys.argv[1])
from zen_file_mount import prepare_zen_file_mounts
with tempfile.TemporaryDirectory(prefix='orbit-zen-files-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    guard = base / 'guard'; guard.mkdir()
    data = base / 'data'; data.mkdir()
    selected = data / 'shared.txt'; selected.write_text('before')
    sibling = data / 'hidden.txt'; sibling.write_text('secret')
    mounts, fds, visible = prepare_zen_file_mounts([str(selected)], [str(profile), str(runtime), str(guard)])
    try:
        code = "from pathlib import Path; p=Path('/orbit/shared/1/shared.txt'); p.write_text('after'); print(Path('/orbit/shared/1/hidden.txt').exists())"
        command = ['/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--ro-bind', '/usr', '/usr',
                   '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
                   '--symlink', 'usr/lib64', '/lib64', '--dev', '/dev', '--proc', '/proc',
                   '--tmpfs', '/tmp', '--dir', '/orbit', *mounts,
                   '/usr/bin/python3', '-c', code]
        run = subprocess.run(command, pass_fds=fds, capture_output=True, text=True, timeout=10)
        print(run.returncode, run.stdout.strip(), selected.read_text(), sibling.read_text(), visible[0])
    finally:
        for fd in fds: os.close(fd)
`);
  expect(result).toBe("0 False after secret /orbit/shared/1/shared.txt");
});

bunTest.if(namespaces)(
  "Zen supervisor leases and mounts one disposable host file", () => {
    const result = python(`
import json, os, pathlib, subprocess, sys, tempfile, time
source_dir = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='orbit-native-zen-file-') as session, \\
     tempfile.TemporaryDirectory(prefix='orbit-zen-selected-') as selected_root:
    session = pathlib.Path(session)
    selected_root = pathlib.Path(selected_root)
    profile = session / 'source-profile'; profile.mkdir()
    selected = selected_root / 'shared.txt'; selected.write_text('before')
    sibling = selected_root / 'hidden.txt'; sibling.write_text('secret')
    report = session / 'app.json'
    policy = {'paths': [str(selected)], 'protectedDirectories':
              [str(profile), str(session), f'/run/user/{os.getuid()}']}
    code = "from pathlib import Path; p=Path('/orbit/shared/1/shared.txt'); assert not Path('/orbit/shared/1/hidden.txt').exists(); p.write_text('after')"
    bwrap = ['/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--ro-bind', '/usr', '/usr',
             '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
             '--symlink', 'usr/lib64', '/lib64', '--dev', '/dev', '--proc', '/proc',
             '--tmpfs', '/tmp', '--dir', '/orbit', '--clearenv',
             '/usr/bin/python3', '-c', code]
    command = ['/usr/bin/python3', str(source_dir / 'supervise.py'), str(report),
               '--selected-files', json.dumps([str(selected)]), '--coredump-filter-zero',
               '--zen-file-policy', json.dumps(policy), *bwrap]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        stdout, stderr = child.communicate(timeout=2)
        print(child.returncode, selected.read_text(), sibling.read_text(),
              json.loads(report.read_text()).get('selectedFiles') == [str(selected)],
              not stderr.strip())
    finally:
        if child.poll() is None: child.kill(); child.communicate()
`);
    expect(result).toBe("0 after secret True True");
  },
);
