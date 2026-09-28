import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const modulePath = join(dirname(import.meta.dir), "src/native");
const portalProbe = process.platform === "linux" && existsSync("/usr/bin/bwrap") &&
  spawnSync("/usr/bin/busctl", ["--user", "get-property", "org.freedesktop.portal.Documents",
    "/org/freedesktop/portal/documents", "org.freedesktop.portal.Documents", "version"],
  { encoding: "utf8", timeout: 5_000 }).status === 0;
const portalTest = portalProbe ? test : test.skip;

function python(source: string) {
  const result = spawnSync("/usr/bin/python3", ["-c", source, modulePath], {
    encoding: "utf8", timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(`Document portal fixture failed: ${result.stderr}`);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

portalTest("one document portal subtree supports direct and atomic saves without host siblings", () => {
  const result = python(`
import os, pathlib, subprocess, sys, tempfile
sys.path.insert(0, sys.argv[1])
from document_portal import prepare_document_portal_mounts
with tempfile.TemporaryDirectory(prefix='orbit-document-portal-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    selected = data / 'shared.txt'; selected.write_text('before')
    sibling = data / 'hidden.txt'; sibling.write_text('secret')
    original_inode = selected.stat().st_ino
    with prepare_document_portal_mounts([str(selected)], [str(profile), str(runtime)]) as lease:
        def run(code):
            command = ['/usr/bin/bwrap', '--unshare-net', '--unshare-pid', '--unshare-ipc',
                       '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
                       '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                       '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
                       '--dir', '/orbit', *lease.options, '--clearenv',
                       '/usr/bin/python3', '-c', code]
            return subprocess.run(command, pass_fds=lease.descriptors,
                                  capture_output=True, text=True, timeout=10)
        direct = run("from pathlib import Path; p=Path('/orbit/shared/1/shared.txt'); p.write_text('direct'); print(Path('/orbit/shared/1/hidden.txt').exists(), Path('/home').exists(), Path('/run/user').exists())")
        direct_ok = direct.returncode == 0 and selected.read_text() == 'direct' and selected.stat().st_ino == original_inode
        atomic = run("import os; from pathlib import Path; p=Path('/orbit/shared/1/shared.txt'); q=p.with_name('.shared.txt.tmp'); q.write_text('atomic'); os.replace(q,p); print(p.read_text())")
        atomic_ok = atomic.returncode == 0 and selected.read_text() == 'atomic' and selected.stat().st_ino != original_inode
        doc_id = lease.doc_ids[0]
        visible = lease.visible[0]
    portal_gone = not (pathlib.Path('/run/user') / str(os.getuid()) / 'doc' / doc_id).exists()
    print(direct_ok, direct.stdout.strip(), atomic_ok, atomic.stdout.strip(),
          sibling.read_text(), visible, portal_gone)
`);
  expect(result).toBe("True False False False True atomic secret /orbit/shared/1/shared.txt True");
});

portalTest("document portal tracks host pathname replacement, including an unsafe hardlink", () => {
  const result = python(`
import os, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
from document_portal import prepare_document_portal_mounts
with tempfile.TemporaryDirectory(prefix='orbit-document-portal-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    selected = data / 'shared.txt'; selected.write_text('initial')
    secret = base / 'unexported.txt'; secret.write_text('unexported content')
    with prepare_document_portal_mounts([str(selected)], [str(profile), str(runtime)]) as lease:
        portal = pathlib.Path('/run/user') / str(os.getuid()) / 'doc' / lease.doc_ids[0] / selected.name
        replacement = data / 'replacement.tmp'; replacement.write_text('new version')
        os.replace(replacement, selected)
        replaced = portal.read_text()
        selected.unlink(); os.link(secret, selected)
        hardlink = portal.read_text()
    print(replaced, hardlink, secret.stat().st_nlink)
`);
  expect(result).toBe("new version unexported content 2");
});

portalTest("a unique temporary grant does not delete another grant for the same host file", () => {
  const result = python(`
import os, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
from document_portal import prepare_document_portal_mounts
with tempfile.TemporaryDirectory(prefix='orbit-document-portal-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    source = data / 'shared.txt'; source.write_text('shared')
    with prepare_document_portal_mounts([str(source)], [str(profile), str(runtime)]) as first:
        with prepare_document_portal_mounts([str(source)], [str(profile), str(runtime)]) as second:
            first_id = first.doc_ids[0]
            second_id = second.doc_ids[0]
            first.close()
            second_path = pathlib.Path('/run/user') / str(os.getuid()) / 'doc' / second_id / source.name
            print(first_id != second_id, second_path.read_text(),
                  not (second_path.parent.parent / first_id).exists())
`);
  expect(result).toBe("True shared True");
});

portalTest("document portal rejects protected and linked files and deletes a partial grant", () => {
  const result = python(`
import pathlib, sys, tempfile
from gi.repository import Gio, GLib
sys.path.insert(0, sys.argv[1])
from document_portal import DocumentPortalError, prepare_document_portal_mounts
with tempfile.TemporaryDirectory(prefix='orbit-document-portal-') as root:
    base = pathlib.Path(root)
    profile = base / 'profile'; profile.mkdir()
    runtime = base / 'runtime'; runtime.mkdir()
    data = base / 'data'; data.mkdir()
    allowed = data / 'allowed.txt'; allowed.write_text('allowed')
    forbidden = profile / 'secret.txt'; forbidden.write_text('secret')
    alias = data / 'alias.txt'; alias.symlink_to(allowed)
    denied = 0
    for paths in ([str(forbidden)], [str(alias)], [str(allowed), str(forbidden)]):
        try:
            lease = prepare_document_portal_mounts(paths, [str(profile), str(runtime)])
        except DocumentPortalError:
            denied += 1
        else:
            lease.close()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    result = bus.call_sync('org.freedesktop.portal.Documents', '/org/freedesktop/portal/documents',
                           'org.freedesktop.portal.Documents', 'Lookup',
                           GLib.Variant('(ay)', (bytes(str(allowed), 'utf8') + b'\\0',)),
                           GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 5000, None)
    print(denied, result.unpack()[0] == '')
`);
  expect(result).toBe("3 True");
});
