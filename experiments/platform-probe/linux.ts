import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run";
import { fixture } from "./fixture";

/**
 * A real Linux host of another family (GitHub's Ubuntu runner, or any machine this runs on by hand):
 * G29 with the exact egress shape and this host's AppArmor policy, the systemd user session and cgroup
 * facts the budget needs, G5 with the family's own sway from a private prefix, and G2 with the bundled
 * Fedora runtime fetched from the release the workflow names.
 */
const release = process.env.ORBIT_PROBE_RELEASE ?? "v0.1.0-alpha.5";
const sysctl = async (name: string) => (await run(["sysctl", "-n", name], { allowFailure: true })).out;

async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-bundle-"));
  const url = `https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/${release}/runtime-sway-1.11-3.fc44.tar`;
  const fetched = await run(["curl", "-fsSL", "-o", join(dir, "runtime.tar"), url], { allowFailure: true, timeoutMs: 120000 });
  if (fetched.code !== 0) throw new Error(`no runtime asset at ${url}: ${fetched.err.slice(-160)}`);
  await run(["tar", "-xf", join(dir, "runtime.tar"), "-C", dir]);
  return { dir, sway: join(dir, "root/usr/bin/sway"), libdir: join(dir, "root/usr/lib64"), pointer: join(dir, "pointer") };
}

async function smoke(sway: string, libdir: string, pointer: string, label: string) {
  const { out, err, code } = await run(["python3", "experiments/linux-families/smoke.py", "--sway", sway, "--libdir", libdir, "--pointer", pointer, "--label", label], { allowFailure: true, timeoutMs: 180000 });
  if (code !== 0) throw new Error(`smoke.py exited ${code}: ${err.slice(-300)}`);
  const report = JSON.parse(out.trim().split("\n").at(-1)!);
  return { ok: report.ok, steps: Object.fromEntries(Object.entries(report.steps as Record<string, { ok: boolean }>).map(([k, v]) => [k, v.ok])), timingsMs: report.timingsMs, compositorArgs: report.compositorArgs, firstAttempt: report.firstAttempt ?? null, detail: report.steps?.sockets?.ok ? undefined : report.steps?.sockets?.detail };
}

export const probes = {
  "host": async () => ({ os: (await run(["sh", "-c", ". /etc/os-release; echo $PRETTY_NAME"])).out, kernel: (await run(["uname", "-r"])).out, glibc: (await run(["sh", "-c", "ldd --version | head -1"])).out,
    apparmorRestrictUserns: await sysctl("kernel.apparmor_restrict_unprivileged_userns"), maxUserNamespaces: await sysctl("user.max_user_namespaces"), unprivilegedUsernsClone: await sysctl("kernel.unprivileged_userns_clone") }),
  "systemd.user": async () => ({ running: (await run(["systemctl", "--user", "is-system-running"], { allowFailure: true })).out, runtimeDir: process.env.XDG_RUNTIME_DIR ?? null,
    controllers: existsSync(`/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/cgroup.controllers`) ? (await Bun.file(`/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/cgroup.controllers`).text()).trim() : "no user manager cgroup",
    selfCgroup: (await Bun.file("/proc/self/cgroup").text()).trim() }),
  "install.dry-run": async () => { const r = await run(["./install.sh", "--dry-run", "--json"], { allowFailure: true, timeoutMs: 120000 }); try { const j = JSON.parse(r.out.split("\n").filter(l => l.startsWith("{")).at(-1) ?? "{}"); return { exit: r.code, installed: j.installed, steps: (j.steps ?? []).map((s: { id: string; state: string }) => `${s.id}:${s.state}`) }; } catch { return { exit: r.code, out: r.out.slice(-400), err: r.err.slice(-300) }; } },
  "G29.egress": async () => {
    const probe = await run(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "--die-with-parent", "/bin/true"], { allowFailure: true, timeoutMs: 20000 });
    const page = fixture();
    const sock = join(mkdtempSync(join(tmpdir(), "orbit-egress-")), "proxy.sock");
    const relay = Bun.spawn(["socat", `UNIX-LISTEN:${sock},fork,unlink-early`, `TCP:127.0.0.1:${new URL(page.url).port}`], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(50);
    const inner = `socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${sock} </dev/null >/dev/null 2>&1 & l=$!; sleep 0.3
python3 - <<'PY'
import json, socket, urllib.request
r = {}
try: r["throughProxy"] = urllib.request.urlopen("http://127.0.0.1:18080/", timeout=5).status
except Exception as e: r["throughProxy"] = "error: " + str(e)[:100]
try: urllib.request.urlopen("${page.url}", timeout=5); r["directToHostLoopback"] = "reached"
except Exception as e: r["directToHostLoopback"] = "refused: " + str(e)[:80]
try:
    s = socket.create_connection(("1.1.1.1", 53), timeout=3); s.close(); r["directToInternet"] = "reached"
except Exception as e: r["directToInternet"] = "refused: " + str(e)[:80]
print(json.dumps(r))
PY
kill $l 2>/dev/null`;
    const shapes: Record<string, unknown> = {};
    for (const [name, flags] of [["orbit", ["--unshare-net", "--unshare-pid", "--dev-bind", "/", "/", "--proc", "/proc"]], ["network-only", ["--unshare-net", "--dev-bind", "/", "/"]]] as const) {
      const r = await run(["bwrap", ...flags, "--die-with-parent", "/bin/sh", "-c", inner], { allowFailure: true, timeoutMs: 60000 });
      try { shapes[name] = JSON.parse(r.out.trim().split("\n").at(-1)!); } catch { shapes[name] = { error: (r.err || r.out).slice(-300) }; }
    }
    relay.kill(); page.stop();
    const orbit = shapes.orbit as Record<string, unknown> | undefined;
    return { probe: probe.code === 0 ? "passes" : `refused: ${probe.err.slice(-200)}`, shapes, verdict: orbit && orbit.throughProxy === 200 && String(orbit.directToHostLoopback).startsWith("refused") && String(orbit.directToInternet).startsWith("refused") ? "confined, Orbit's exact shape" : "in-browser" };
  },
  "G5.family.sway": async () => {
    const prefix = mkdtempSync(join(tmpdir(), "orbit-distro-"));
    const deps = (await run(["apt-cache", "depends", "sway"])).out.split("\n").filter(l => /Depends: libwlroots/.test(l)).map(l => l.trim().split(/\s+/)[1]!);
    await run(["sh", "-c", `cd ${prefix} && apt-get download sway ${deps.join(" ")} && for d in *.deb; do dpkg-deb -x "$d" .; done`], { timeoutMs: 180000 });
    const versions = (await run(["sh", "-c", `dpkg-query -W -f='\${Package} \${Version}\\n' sway ${deps.join(" ")}`], { allowFailure: true })).out;
    const libdir = (await run(["sh", "-c", `find ${prefix} -name 'libwlroots*.so*' -printf '%h\\n' | sort -u | head -1`])).out;
    const bundled = await bundle().catch(() => null);
    const pointer = bundled?.pointer;
    if (!pointer) throw new Error("the pointer helper comes with the bundled runtime, and it could not be fetched");
    return { packages: versions, libdir, smoke: await smoke(join(prefix, "usr/bin/sway"), libdir, pointer, "distro") };
  },
  "G2.bundled.runtime": async () => {
    const b = await bundle();
    const missing = (await run(["sh", "-c", `LD_LIBRARY_PATH=${b.libdir} ldd -r ${b.sway} ${b.libdir}/libwlroots-0.19.so ${b.pointer} 2>&1 | awk '/not found/ {print $1} /undefined symbol/ {print $3}' | sort -u | tr '\\n' ' '`])).out;
    const dlopen = (await run(["python3", "-c", `import ctypes,os; ctypes.CDLL("${b.libdir}/libwlroots-0.19.so", mode=os.RTLD_NOW); print("loaded")`], { allowFailure: true, env: { LD_LIBRARY_PATH: b.libdir } }));
    return { lddMissing: missing || "none", dlopen: dlopen.code === 0 ? "loaded" : dlopen.err.slice(-200), smoke: missing ? "not attempted, the loader already refused" : await smoke(b.sway, b.libdir, b.pointer, "bundled") };
  },
};
