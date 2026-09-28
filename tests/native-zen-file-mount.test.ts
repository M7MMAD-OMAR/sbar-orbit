import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const modulePath = join(dirname(import.meta.dir), "src/native");

function python(source: string) {
  const result = spawnSync("/usr/bin/python3", ["-c", source, modulePath], {
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

test("Zen exact file policy rejects profile files, links, and special files", () => {
  const result = python(`
import os, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
from zen_file_mount import ZenFileMountError, prepare_zen_file_mounts
with tempfile.TemporaryDirectory(prefix='orbit-zen-files-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    good = data / 'good.txt'; good.write_text('hello')
    secret = profile / 'secret.txt'; secret.write_text('secret')
    (data / 'link.txt').symlink_to(good)
    (base / 'alias').symlink_to(data, target_is_directory=True)
    os.link(good, data / 'hard.txt')
    os.mkfifo(data / 'pipe')
    checks = [str(secret), str(data / 'link.txt'), str(base / 'alias' / 'good.txt'),
              str(good), str(data / 'pipe'), str(data / '..' / 'good.txt')]
    denied = 0
    for path in checks:
        try:
            _, fds, _ = prepare_zen_file_mounts([path], [str(profile), str(runtime)])
        except (ZenFileMountError, OSError):
            denied += 1
        else:
            for fd in fds: os.close(fd)
    print(denied)
`);
  expect(result).toBe("6");
});

test("Zen exact file mount writes one selected host inode and hides its sibling", () => {
  const result = python(`
import os, pathlib, subprocess, sys, tempfile
sys.path.insert(0, sys.argv[1])
from zen_file_mount import prepare_zen_file_mounts
with tempfile.TemporaryDirectory(prefix='orbit-zen-files-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    selected = data / 'shared.txt'; selected.write_text('before')
    sibling = data / 'hidden.txt'; sibling.write_text('secret')
    mounts, fds, visible = prepare_zen_file_mounts([str(selected)], [str(profile), str(runtime)])
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
