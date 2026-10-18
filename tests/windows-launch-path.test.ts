import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { brokerTaskXml } from "../src/windows-autostart";
import { fixtureRoot } from "./platform-support";

const windowsTest = process.platform === "win32" ? test : test.skip;
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? ""));

windowsTest("Windows launcher refuses a missing pinned Bun even when PATH has Bun", async () => {
  const root = await fixtureRoot("orbit-win-pin-missing-");
  try {
    const missing = join(root, "missing-runtime", "bun.exe");
    const child = Bun.spawn(["cmd.exe", "/d", "/v:off", "/c", join(import.meta.dir, "../bin/sbar-orbit.cmd"), "help"], {
      env: { ...process.env, ORBIT_BUN: missing }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(out + err).toContain("the pinned ORBIT_BUN runtime does not exist");
    expect(out + err).not.toContain("Usage:");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const location of ["custom runtime/bin", "runtime & tools/bin"]) {
  windowsTest(`Windows task retains installer runtime in ${location}`, async () => {
    const root = await fixtureRoot("orbit-win-runtime-");
    try {
      const source = join(root, "source & space"), runtime = join(root, location, "bun.exe");
      const launcher = join(source, "bin/sbar-orbit.cmd"), record = join(root, "runtime.json");
      await mkdir(join(source, "bin"), { recursive: true });
      await mkdir(join(source, "scripts"));
      await mkdir(win32.dirname(runtime), { recursive: true });
      await copyFile(process.execPath, runtime);
      await copyFile(join(import.meta.dir, "../bin/sbar-orbit.cmd"), launcher);
      await writeFile(join(source, "scripts/limited.ts"),
        "await Bun.write(process.env.ORBIT_FIXTURE_RECORD!, JSON.stringify({ runtime: process.execPath, args: process.argv.slice(2) }));\n");
      const xml = brokerTaskXml(launcher, "S-1-5-21-1-2-3-1000", { ORBIT_BUN: runtime, ORBIT_FIXTURE_RECORD: record });
      const argumentsText = decode(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? "");
      expect(argumentsText.startsWith("/c ")).toBe(true);
      const child = Bun.spawn(["cmd.exe", "/d", "/v:off", "/c", argumentsText.slice(3)], {
        env: { SystemRoot: process.env.SystemRoot, USERPROFILE: root,
          LOCALAPPDATA: join(root, "appdata"), PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32") },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
      const selected = JSON.parse(await readFile(record, "utf8"));
      expect(selected.runtime.toLowerCase()).toBe(runtime.toLowerCase());
      expect(selected.args).toEqual([runtime, "run", join(source, "src/cli.ts"), "serve", "--managed-socket"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
