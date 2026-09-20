import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareManagedInstall, currentVersion } from "../src/update";

test.skipIf(process.platform !== "linux")("managed adoption preserves source, ignores unrelated files and refuses changing an active version", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orbit-managed-"));
  const source = join(temporary, "package"), root = join(temporary, "managed");
  await mkdir(join(source, "bin"), { recursive: true });
  const manifest = { name: "sbar-orbit", version: "0.1.0-alpha.8" };
  await writeFile(join(source, "package.json"), JSON.stringify(manifest));
  await writeFile(join(source, "bin/sbar-orbit"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(source, "private-unrelated"), "retain");
  let installs = 0;
  const options = { root, openSessions: async () => null, install: async () => { installs++; return { ok: true, output: "" }; } };
  try {
    await prepareManagedInstall(source, { ...options, dryRun: true });
    expect(installs).toBe(0);
    expect(await currentVersion(root)).toBeNull();
    expect(await prepareManagedInstall(source, options)).toBe(join(root, "current"));
    expect(await currentVersion(root)).toBe(manifest.version);
    expect(installs).toBe(1);
    expect(await Bun.file(join(root, "current/private-unrelated")).exists()).toBe(false);
    expect(await readFile(join(source, "private-unrelated"), "utf8")).toBe("retain");
    await prepareManagedInstall(source, options);
    expect(installs).toBe(1);
    await writeFile(join(source, "package.json"), JSON.stringify({ ...manifest, version: "0.1.0-alpha.9" }));
    await expect(prepareManagedInstall(source, options)).rejects.toThrow("already active");
    await mkdir(join(source, ".git"));
    await expect(prepareManagedInstall(source, options)).rejects.toThrow("source checkouts");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
