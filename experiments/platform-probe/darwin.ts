import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { run } from "./run";
import { fixture } from "./fixture";

/**
 * macOS, the gates from docs/porting.md that need a Mac: G19 the profile encryption prefix census,
 * G22 clone copies on APFS, G24 proc_pid_rusage from Bun, G25 what survives launchctl bootout, G26
 * loopback under local network privacy, and the m.* probes that gate the platform at all. G20, G21
 * and G23 are attempted as far as a runner allows and report what they saw.
 */
const uid = userInfo().uid;
const sysctl = async (name: string) => (await run(["sysctl", "-n", name], { allowFailure: true })).out;

async function chromeBundle() {
  const app = "/Applications/Google Chrome.app";
  if (!existsSync(app)) return { present: false };
  const plist = await run(["plutil", "-extract", "CFBundleIdentifier", "raw", join(app, "Contents/Info.plist")], { allowFailure: true });
  const sign = await run(["codesign", "--verify", "--strict", "--verbose=2", app], { allowFailure: true, timeoutMs: 120000 });
  const details = await run(["codesign", "-dv", "--verbose=2", app], { allowFailure: true });
  const team = /TeamIdentifier=(\S+)/.exec(details.err)?.[1] ?? null;
  const version = await run(["plutil", "-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")], { allowFailure: true });
  return { present: true, bundleId: plist.out, version: version.out, codesignVerify: sign.code === 0 ? "valid" : sign.err.slice(-200), teamId: team, executable: join(app, "Contents/MacOS/Google Chrome") };
}

/** G19: launch Chrome against a fresh profile, set one cookie, read the prefix of every encrypted_value. */
async function profileScheme(executable: string, extraArgs: string[] = []) {
  const page = fixture();
  const profile = mkdtempSync(join(tmpdir(), "orbit-profile-"));
  const started = performance.now();
  const child = Bun.spawn([executable, "--headless=new", "--no-first-run", `--user-data-dir=${profile}`, ...extraArgs, "--remote-debugging-port=0", `${page.url}set-cookie`], { stdout: "ignore", stderr: "pipe" });
  await Bun.sleep(8000);
  child.kill();
  await child.exited;
  page.stop();
  const cookies = join(profile, "Default/Cookies");
  if (!existsSync(cookies)) return { cookiesFile: false, ms: Math.round(performance.now() - started), stderrTail: (await new Response(child.stderr).text()).slice(-300) };
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(cookies, { readonly: true });
  const rows = db.query("select encrypted_value from cookies").all() as { encrypted_value: Uint8Array }[];
  const census: Record<string, number> = {};
  for (const row of rows) { const prefix = new TextDecoder().decode(row.encrypted_value.slice(0, 3)); census[/^v\d\d$/.test(prefix) ? prefix : "other"] = (census[/^v\d\d$/.test(prefix) ? prefix : "other"] ?? 0) + 1; }
  db.close();
  return { cookiesFile: true, rows: rows.length, census, ms: Math.round(performance.now() - started), profile };
}

export const probes = {
  "m.version": async () => ({ product: await sysctl("kern.osproductversion"), build: (await run(["sw_vers", "-buildVersion"])).out }),
  "m.arch": async () => ({ arm64: (await run(["sysctl", "-n", "hw.optional.arm64"], { allowFailure: true })).code === 0 ? await sysctl("hw.optional.arm64") : "absent, Intel", perflevel0: await sysctl("hw.perflevel0.logicalcpu"), perflevel1: await sysctl("hw.perflevel1.logicalcpu"), chip: await sysctl("machdep.cpu.brand_string") }),
  "m.translated": async () => ({ brokerUnderRosetta: await sysctl("sysctl.proc_translated"), bunArch: process.arch }),
  "m.gui": async () => { const r = await run(["launchctl", "print", `gui/${uid}`], { allowFailure: true }); return { exit: r.code, sessionSummary: r.out.split("\n").slice(0, 6).join(" | ") }; },
  "m.tools": async () => Object.fromEntries(["/bin/cp", "/usr/bin/launchctl", "/usr/bin/plutil", "/usr/bin/codesign", "/usr/sbin/sysctl", "/usr/bin/ditto", "/usr/bin/powermetrics", "/usr/sbin/taskpolicy"].map(p => [p, existsSync(p)])),
  "m.clt": async () => { const r = await run(["/usr/bin/python3", "-V"], { allowFailure: true, timeoutMs: 20000 }); return { exit: r.code, version: r.out || r.err }; },
  "m.socket.path": async () => { const path = join(process.env.HOME ?? "", "Library/Application Support/sbar-orbit/broker.sock"); return { path, bytes: Buffer.byteLength(path), withinLimit: Buffer.byteLength(path) <= 103 }; },
  "m.bundle": chromeBundle,
  "G22.clone.copy": async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-clone-"));
    const source = join(dir, "source"); writeFileSync(source, Buffer.alloc(64 * 1024 * 1024, 7));
    const fs = (await run(["df", "-T", "apfs", dir], { allowFailure: true })).code === 0 ? "apfs" : (await run(["diskutil", "info", "-plist", dir], { allowFailure: true })).out.includes("APFS") ? "apfs" : "other";
    const before = Number((await run(["df", "-k", dir])).out.split("\n").at(-1)!.split(/\s+/)[2]);
    const clone = await run(["cp", "-c", source, join(dir, "clone")], { allowFailure: true });
    const after = Number((await run(["df", "-k", dir])).out.split("\n").at(-1)!.split(/\s+/)[2]);
    const recursive = await run(["cp", "-Rpc", dir, `${dir}-tree`], { allowFailure: true });
    return { filesystem: fs, cpCloneExit: clone.code, cpCloneError: clone.err.slice(-160), usedKiBBefore: before, usedKiBAfter: after, sharedBlocks: after - before < 1024, cpRpcExit: recursive.code, cpRpcError: recursive.err.slice(-160) };
  },
  "G24.proc_pid_rusage": async () => {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("libSystem.B.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const buffer = new Uint8Array(1024);
    const code = lib.symbols.proc_pid_rusage(process.pid, 4, ptr(buffer));
    if (code !== 0) throw new Error(`proc_pid_rusage returned ${code}`);
    const view = new DataView(buffer.buffer);
    const footprint = Number(view.getBigUint64(72, true)), resident = Number(view.getBigUint64(64, true));
    const rssKiB = Number((await run(["ps", "-o", "rss=", "-p", String(process.pid)])).out);
    return { reachable: true, physFootprintMiB: Number((footprint / 2 ** 20).toFixed(1)), residentMiB: Number((resident / 2 ** 20).toFixed(1)), psRssMiB: Number((rssKiB / 1024).toFixed(1)) };
  },
  "G25.launchd.bootout": async () => {
    const label = `orbit.probe.${crypto.randomUUID().slice(0, 8)}`;
    const plist = join(mkdtempSync(join(tmpdir(), "orbit-launchd-")), `${label}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>/bin/sleep 300 &amp; exec /bin/sleep 301</string></array><key>RunAtLoad</key><true/></dict></plist>`);
    const bootstrap = await run(["launchctl", "bootstrap", `gui/${uid}`, plist], { allowFailure: true });
    await Bun.sleep(1500);
    const before = (await run(["pgrep", "-f", "sleep 30[01]"], { allowFailure: true })).out.split("\n").filter(Boolean);
    const bootout = await run(["launchctl", "bootout", `gui/${uid}/${label}`], { allowFailure: true });
    await Bun.sleep(1500);
    const survivors = (await run(["pgrep", "-f", "sleep 30[01]"], { allowFailure: true })).out.split("\n").filter(Boolean);
    for (const pid of survivors) await run(["kill", pid], { allowFailure: true });
    return { bootstrapExit: bootstrap.code, bootstrapError: bootstrap.err.slice(-160), processesWhileLoaded: before.length, bootoutExit: bootout.code, survivorsAfterBootout: survivors.length };
  },
  "G19.profile.scheme": async () => { const b = await chromeBundle(); if (!b.present) throw new Error("no Chrome"); return profileScheme(b.executable!); },
  "G19.profile.scheme.basic": async () => { const b = await chromeBundle(); if (!b.present) throw new Error("no Chrome"); return profileScheme(b.executable!, ["--password-store=basic"]); },
  "G20.keychain.copy": async () => {
    const b = await chromeBundle(); if (!b.present) throw new Error("no Chrome");
    const copy = join(mkdtempSync(join(tmpdir(), "orbit-copy-")), "Google Chrome.app");
    await run(["ditto", "/Applications/Google Chrome.app", copy], { timeoutMs: 300000 });
    const verify = await run(["codesign", "--verify", "--strict", copy], { allowFailure: true, timeoutMs: 120000 });
    // The copy against a fresh profile: it asks the Keychain for the same "Chrome Safe Storage" item the
    // original made, and a dialog here is a hang, which the timeout turns into a reading.
    const original = await profileScheme(b.executable!);
    const copied = await Promise.race([profileScheme(join(copy, "Contents/MacOS/Google Chrome")), new Promise<string>(r => setTimeout(() => r("timed out at 90 s, a dialog or a lock"), 90000))]);
    return { copyVerify: verify.code === 0 ? "valid" : verify.err.slice(-160), original, copied };
  },
  "G21.tcc.gui.job": async () => {
    const b = await chromeBundle(); if (!b.present) throw new Error("no Chrome");
    const made = await profileScheme(b.executable!);
    if (!made.profile) throw new Error("no profile to read");
    const label = `orbit.tcc.${crypto.randomUUID().slice(0, 8)}`;
    const dir = mkdtempSync(join(tmpdir(), "orbit-tcc-"));
    const plist = join(dir, `${label}.plist`), out = join(dir, "result.txt");
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>if head -c 16 "${made.profile}/Default/Cookies" > /dev/null 2>"${out}.err"; then echo allowed > "${out}"; else echo denied >> "${out}"; cat "${out}.err" >> "${out}"; fi</string></array><key>RunAtLoad</key><true/></dict></plist>`);
    const bootstrap = await run(["launchctl", "bootstrap", `gui/${uid}`, plist], { allowFailure: true });
    await Bun.sleep(3000);
    await run(["launchctl", "bootout", `gui/${uid}/${label}`], { allowFailure: true });
    return { bootstrapExit: bootstrap.code, verdict: existsSync(out) ? (await Bun.file(out).text()).trim() : "no result written, a prompt or a silent denial" };
  },
  "G23.qos.background": async () => {
    const b = await chromeBundle(); if (!b.present) throw new Error("no Chrome");
    const page = fixture();
    const profile = mkdtempSync(join(tmpdir(), "orbit-qos-"));
    const child = Bun.spawn(["/usr/sbin/taskpolicy", "-b", b.executable!, "--headless=new", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", page.url], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(2000);
    const metrics = await run(["sudo", "-n", "powermetrics", "--samplers", "tasks,cpu_power", "-i", "1000", "-n", "2"], { allowFailure: true, timeoutMs: 30000 });
    child.kill(); page.stop();
    const lines = metrics.out.split("\n");
    return { powermetricsExit: metrics.code, error: metrics.err.slice(-160), chromeRows: lines.filter(l => /Chrome/.test(l)).slice(0, 6), clusterRows: lines.filter(l => /cluster|residency|E-Cluster|P-Cluster/i.test(l)).slice(0, 8) };
  },
  "G26.loopback": async () => {
    const page = fixture();
    const started = performance.now();
    const status = (await fetch(page.url)).status;
    page.stop();
    return { status, ms: Math.round(performance.now() - started), product: await sysctl("kern.osproductversion"), note: "an alert cannot be seen from here; a loopback fetch that answers at once with no entry is the evidence available" };
  },
};
