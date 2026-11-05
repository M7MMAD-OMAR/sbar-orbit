import { expect } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rendererAccessibilityArguments } from "../src/applications/renderer-accessibility";
import { resolveInstalledApplication } from "../src/application-launch";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("Renderer accessibility preflight uses native Linux binaries and procfs");
const opt = { "X-Orbit-Accessibility": "chromium-renderer" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-renderer-")), proc = join(root, "proc"), binary = join(root, "editor");
  await mkdir(proc); await copyFile("/usr/bin/printenv", binary);
  return { root, proc, binary, options: { platform: "linux" as const, procRoot: proc }, close: () => rm(root, { recursive: true, force: true }) };
}

test("registered opening reads the explicit key while preserving owner HOME profile and working directory", async () => {
  const f = await fixture(); try {
    const registrations = join(f.root, "applications"); await mkdir(registrations);
    await writeFile(join(registrations, "editor.desktop"), `[Desktop Entry]\nType=Application\nName=Editor\nExec=${f.binary} --profile owner\nPath=${f.root}\nX-Orbit-Accessibility=chromium-renderer\n`);
    const result = await resolveInstalledApplication("editor.desktop", { ...f.options, home: f.root, env: { HOME: f.root, PATH: "/usr/bin" }, applicationDirectories: [registrations], includeRunning: false });
    expect(result).toEqual({ applicationId: "editor.desktop", argv: [f.binary, "--force-renderer-accessibility", "--profile", "owner"], cwd: f.root });
  } finally { await f.close(); }
});

test("accessibility is unchanged by default and only one fixed flag can be opted into", async () => {
  const f = await fixture(); try {
    const argv = [f.binary, "--new-window", "document with spaces"];
    expect(await rendererAccessibilityArguments({}, argv, f.options)).toBe(argv);
    expect(await rendererAccessibilityArguments({ "X-Orbit-Accessibility": "false" }, argv, f.options)).toBe(argv);
    expect(await rendererAccessibilityArguments(opt, argv, f.options)).toEqual([f.binary, "--force-renderer-accessibility", ...argv.slice(1)]);
    expect(await rendererAccessibilityArguments(opt, [f.binary, "--force-renderer-accessibility"], f.options)).toEqual([f.binary, "--force-renderer-accessibility"]);
    await expect(rendererAccessibilityArguments({ "X-Orbit-Accessibility": "arbitrary flags" }, argv, f.options)).rejects.toThrow("Unknown registered accessibility option");
    await expect(rendererAccessibilityArguments(opt, [f.binary, "--force-renderer-accessibility=complete"], f.options)).rejects.toThrow("conflict");
    await expect(rendererAccessibilityArguments(opt, [f.binary, "--disable-renderer-accessibility"], f.options)).rejects.toThrow("conflict");
  } finally { await f.close(); }
});

test("a running executable or inode alias refuses instead of forwarding accessibility flags", async () => {
  const f = await fixture(); try {
    await mkdir(join(f.proc, "321")); await symlink(f.binary, join(f.proc, "321", "exe"));
    await expect(rendererAccessibilityArguments(opt, [f.binary], f.options)).rejects.toMatchObject({ code: "APPLICATION_BUSY" });
    const alias = join(f.root, "alias"); await symlink(f.binary, alias);
    await expect(rendererAccessibilityArguments(opt, [alias], f.options)).rejects.toMatchObject({ code: "APPLICATION_BUSY" });
  } finally { await f.close(); }
});

test("an existing owner process is never signalled or changed by the refusal", async () => {
  const f = await fixture();
  await copyFile("/usr/bin/sleep", f.binary);
  const child = Bun.spawn([f.binary, "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    await expect(rendererAccessibilityArguments(opt, [f.binary], { platform: "linux" })).rejects.toMatchObject({ code: "APPLICATION_BUSY" });
    expect(child.exitCode).toBeNull();
  } finally { child.kill(); await child.exited; await f.close(); }
});

test("wrappers terminal launchers incomplete scans and unavailable procfs refuse opt-in", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.root, "wrapper"); await writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    await expect(rendererAccessibilityArguments(opt, [wrapper], f.options)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(rendererAccessibilityArguments({ ...opt, Terminal: "true" }, [f.binary], f.options)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(rendererAccessibilityArguments(opt, [f.binary], { ...f.options, procRoot: join(f.root, "missing") })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(rendererAccessibilityArguments(opt, [f.binary], { ...f.options, platform: "darwin" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    for (let index = 1; index < 4098; index++) await mkdir(join(f.proc, String(index)));
    await expect(rendererAccessibilityArguments(opt, [f.binary], f.options)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await f.close(); }
});
