import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { OrbitError } from "./errors";

export type ZenCoreGuard = { directory: string; library: string; preloadConfig: string; release: () => Promise<void> };

export async function compileZenCoreGuard(parentDirectory: string, compiler = "/usr/bin/cc"): Promise<ZenCoreGuard> {
  const executable = await realpath(compiler).catch(() => "");
  const entry = executable ? await stat(executable).catch(() => undefined) : undefined;
  if (!entry?.isFile() || !(entry.mode & 0o111))
    throw new OrbitError("UNSUPPORTED", "Zen public web mode needs a working C compiler");

  const directory = await mkdtemp(join(await realpath(parentDirectory), "zen-core-guard-"));
  await chmod(directory, 0o700);
  const library = join(directory, "guard.so");
  const preloadConfig = join(directory, "ld.so.preload");
  const source = resolve(import.meta.dir, "native/zen_no_core.c");
  try {
    const child = Bun.spawn([executable, "-std=c11", "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
      "-o", library, source], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory, TMPDIR: directory },
      stdout: "ignore", stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    let status: number;
    try { status = await child.exited; }
    finally { clearTimeout(timer); }
    if (status !== 0 || !(await stat(library).catch(() => undefined))?.isFile())
      throw new OrbitError("BACKEND_FAILED", "Zen core guard compilation failed");
    await chmod(library, 0o500);
    await writeFile(preloadConfig, "/orbit/no-core/guard.so\n", { mode: 0o400, flag: "wx" });
    return { directory, library, preloadConfig, release: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof OrbitError) throw error;
    throw new OrbitError("BACKEND_FAILED", `Zen core guard preparation failed near ${basename(source)}`);
  }
}
