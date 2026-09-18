import { test, expect } from "bun:test";
import { linuxOnlySuite, needsSymlink } from "./platform-support";
import { mkdtemp, writeFile, readFile, symlink, rename, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * File leases are the Linux supervisor's feature, and this suite spawns it directly.
 *
 * `src/native/supervise.py` needs `/usr/bin/python3`, `PR_SET_CHILD_SUBREAPER` and a POSIX `flock`
 * helper, and none of the three exists on the macOS path: the darwin supervisor is
 * `supervise-darwin.ts`, holds a process group rather than a subreaper, and has no lease mechanism
 * at all. Spawning `/usr/bin/python3` on a Mac is also a thing `bin/sbar-orbit` deliberately
 * refuses, because that path can raise the Command Line Tools installer on the person's screen.
 *
 * So this is a feature that does not exist on the other platform rather than one that happens to
 * fail there, which is exactly the narrow case `linuxOnlySuite` is for. Marking it is not a way to
 * make a red number smaller: the capability it guards is unported, and `docs/support-tiers.md` must
 * not carry a macOS row for it until one is written.
 */
const supervisedLeases = linuxOnlySuite("file leases are the Python subreaper's feature; the darwin supervisor has no lease mechanism and must not spawn /usr/bin/python3");
// Both gates apply and both are real: the feature is Linux only, AND the fixture needs a symlink,
// which an unelevated Windows process cannot create. `test.skip` from either one wins.
const leaseTest = supervisedLeases === test
  ? needsSymlink("an alias beside the reserved file, so the lease is checked against a symlink to it")
  : supervisedLeases;

leaseTest("supervised file reservations survive replacement and parent EOF until cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-file-test-"));
  const file = join(root, "document.txt"), alias = join(root, "alias.txt"), other = join(root, "aaa-other.txt");
  await writeFile(file, "Original"); await writeFile(other, "Other"); await symlink(file, alias);
  const owners: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
  const start = async (files: string[], stubborn = false) => {
    const report = join(root, crypto.randomUUID() + ".json");
    const ready = report + ".ready";
    const code = `import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(${JSON.stringify(ready)}).touch();time.sleep(30)`;
    const child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report, "--selected-files", JSON.stringify(files),
      ...(stubborn ? ["/usr/bin/python3", "-c", code] : ["/usr/bin/sleep", "30"])], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    owners.push(child);
    let result: { pid?: number; selectedFiles?: string[]; error?: { code: string } } | undefined;
    for (let i = 0; i < 100; i++) {
      try { result = JSON.parse(await readFile(report, "utf8")); break; } catch {}
      if (child.exitCode !== null) throw new Error("Supervisor exited without report");
      await Bun.sleep(20);
    }
    if (!result) throw new Error("No supervisor report");
    if (stubborn && result.pid) {
      for (let i = 0; i < 100 && !await Bun.file(ready).exists(); i++) await Bun.sleep(10);
      expect(await Bun.file(ready).exists()).toBe(true);
    }
    return { child, result };
  };
  try {
    const first = await start([file], true);
    expect(first.result.selectedFiles).toEqual([file]);
    expect((await start([alias])).result.error?.code).toBe("FILE_BUSY");
    await writeFile(join(root, "new.txt"), "Replaced"); await rename(join(root, "new.txt"), file);
    expect((await start([file])).result.error?.code).toBe("FILE_BUSY");
    expect((await start([other, file])).result.error?.code).toBe("FILE_BUSY");
    const independent = await start([other]); expect(independent.result.pid).toBeGreaterThan(0);
    independent.child.stdin?.end(); await independent.child.exited;
    first.child.stdin?.end();
    await Bun.sleep(100);
    expect((await start([file])).result.error?.code).toBe("FILE_BUSY");
    await first.child.exited;
    expect(await Bun.file(`/proc/${first.result.pid}/stat`).exists()).toBe(false);
    const next = await start([file]); expect(next.result.pid).toBeGreaterThan(0);
    next.child.stdin?.end(); await next.child.exited;
    await link(file, join(root, "hard.txt"));
    expect((await start([file])).result.error?.code).toBe("INVALID_REQUEST");
    expect((await start(["relative.txt"])).result.error?.code).toBe("INVALID_REQUEST");
  } finally {
    for (const owner of owners) { owner.stdin?.end(); if (owner.exitCode === null) owner.kill("SIGTERM"); }
    await Promise.all(owners.map(owner => owner.exited));
  }
}, 15000);
