import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeLeases, reapWorkerLease } from "../src/native-prepare";

const source = join(import.meta.dir, "../experiments/ghost-cursor/plugin/ghostinput.cpp");

(process.platform === "linux" ? test : test.skip)("lease listing, release, reap and the busy message behave as specified", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_leases_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 30000);

test("a close with no handoff record starts no command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-reap-"));
  try {
    let calls = 0;
    expect(await reapWorkerLease(dir, "/plan", "/control", async () => { calls++; return { code: 0, reply: {} }; })).toBeUndefined();
    expect(calls).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a worker directory that still records a lease is reaped through the repair entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-reap-"));
  try {
    await writeFile(join(dir, "handoff.json"), JSON.stringify({ lease_id: "a".repeat(32) }));
    const seen: string[][] = [];
    const reply = await reapWorkerLease(dir, "/plan", "/control", async (entry, words) => { seen.push([entry, ...words]); return { code: 0, reply: { ok: true } }; });
    expect(reply).toEqual({ ok: true });
    expect(seen).toEqual([["leases.py", "/plan", "/control", "reap-worker", dir]]);
    // A failing repair is reported as no result and never throws into a session close.
    expect(await reapWorkerLease(dir, "/plan", "/control", async () => ({ code: 1, reply: {} }))).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native-leases refuses malformed requests before any command runs", async () => {
  await expect(nativeLeases("release", "../../etc")).rejects.toThrow("native-leases release LEASE_ID");
  await expect(nativeLeases("release", undefined)).rejects.toThrow("native-leases release LEASE_ID");
  await expect(nativeLeases("drop", undefined)).rejects.toThrow("native-leases");
});

test("every session close reaps its lease, and the plugin reaps a dead owner by itself", async () => {
  const backend = await Bun.file(join(import.meta.dir, "../src/hyprland.ts")).text();
  const close = backend.slice(backend.indexOf("close() {\n    return this.closing"));
  expect(close.indexOf("worker.close()")).toBeGreaterThan(-1);
  expect(close.indexOf("reapWorkerLease")).toBeGreaterThan(close.indexOf("worker.close()"));
  const plugin = await Bun.file(source).text();
  expect(plugin).toContain("reapDeadOwnerLeases");
  expect(plugin).toContain("ghost-application-list");
  expect(plugin).toMatch(/!lease_owner::alive\(lease->owner\)/);
  const worker = await Bun.file(join(import.meta.dir, "../src/native-worker.ts")).text();
  expect(worker).toContain("Application client is already leased by lease");
});

(process.platform === "linux" ? test : test.skip)("the plugin's owner liveness rules hold for a live, a dead and a recycled pid", async () => {
  const text = await Bun.file(source).text();
  const region = text.slice(text.indexOf("// BEGIN lease-owner"), text.indexOf("// END lease-owner"));
  const dir = await mkdtemp(join(tmpdir(), "orbit-owner-"));
  try {
    await writeFile(join(dir, "owner.cpp"), `
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <unistd.h>
${region}
int main(int, char** argv) {
    using namespace lease_owner;
    int failed = 0;
    auto check = [&](bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL %s\\n", what); ++failed; } };
    Owner o;
    check(parse("123:456", o) && o.pid == 123 && o.start == 456, "parse");
    for (const char* bad : {"", "12", ":5", "5:", "a:5", "5:b", "-1:5", "0:5", "1:2:3", "99999999999999999999999999999999999999999:1"}) {
        Owner x; check(!parse(bad, x), bad);
    }
    unsigned long long ticks = 0;
    check(startTicks("1 (a b) c) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0", ticks) && ticks == 777, "ticks after the last parenthesis");
    check(!startTicks("nonsense", ticks), "ticks nonsense");
    std::ifstream self("/proc/self/stat"); std::string line; std::getline(self, line);
    check(startTicks(line, ticks), "own ticks");
    Owner me{static_cast<long>(getpid()), ticks};
    check(alive(me), "self alive");
    Owner recycled{me.pid, ticks + 1};
    check(!alive(recycled), "recycled pid is dead");
    Owner gone{4194000, 1};
    check(!alive(gone), "absent pid is dead");
    check(alive(me, "/definitely/not/proc") == false, "missing proc root with no entry is dead");
    return failed;
}
`);
    const build = Bun.spawnSync(["g++", "-std=c++23", join(dir, "owner.cpp"), "-o", join(dir, "owner")], { stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const run = Bun.spawnSync([join(dir, "owner")], { stderr: "pipe" });
    expect({ code: run.exitCode, err: run.stderr.toString() }).toEqual({ code: 0, err: "" });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);
