import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, symlink, rename, link } from "node:fs/promises";
import { join, resolve } from "node:path";

test("supervised file reservations survive replacement and parent EOF until cleanup", async () => {
  const root = await mkdtemp("/tmp/orbit-file-test-");
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
