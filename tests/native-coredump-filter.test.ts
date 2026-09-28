import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

test("supervisor's zero core filter survives child exec without disabling dumpability", async () => {
  const directory = await mkdtemp("/tmp/orbit-coredump-filter-");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const code = "import ctypes,pathlib; print(pathlib.Path('/proc/self/coredump_filter').read_text().strip(), ctypes.CDLL(None).prctl(3), flush=True)";
    const child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"),
      join(directory, "report.json"), "--coredump-filter-zero", "/usr/bin/python3", "-c", code],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe("00000000 1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
