import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { brokerTaskXml } from "../src/windows-autostart";
import { fixtureRoot } from "./platform-support";

const windowsTest = process.platform === "win32" ? test : test.skip;
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? ""));

// cmd.exe consumes its own quoting grammar. CRT escaping would turn the task's
// quoted launcher into a literal backslash plus quote before cmd can run it.
async function runCmd(argv: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(argv[0] ?? "cmd.exe", argv.slice(1), {
    env, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === null ? reject(new Error("Owned cmd child exited without a code")) : resolve(code));
  });
  return { code, out, err };
}

async function launcherDiagnostic(caseName: string, argv: string[], env: NodeJS.ProcessEnv, launcher: string, pin: string, result: { code: number; out: string; err: string }) {
  const selected = Object.fromEntries(["ORBIT_BUN", "SystemRoot", "USERPROFILE", "LOCALAPPDATA", "PATH"].map(key => [key, env[key] ?? null]));
  const launcherBytes = await readFile(launcher);
  const pinExists = await stat(pin).then(value => ({ exists: true, file: value.isFile(), bytes: value.size }), error => ({ exists: false, code: (error as NodeJS.ErrnoException).code ?? "unknown" }));
  console.log(JSON.stringify({ windowsLauncherDiagnostic: { caseName, argv, selectedEnvironment: selected,
    launcherSha256: new Bun.CryptoHasher("sha256").update(launcherBytes).digest("hex"),
    pin, pinExists, code: result.code, out: result.out.slice(0, 16384), err: result.err.slice(0, 16384),
    outputLengths: { out: result.out.length, err: result.err.length }, outputLimit: 16384 } }));
}

windowsTest("Windows launcher refuses a missing pinned Bun even when PATH has Bun", async () => {
  const root = await fixtureRoot("orbit-win-pin-missing-");
  try {
    const missing = join(root, "missing-runtime", "bun.exe");
    const launcher = join(import.meta.dir, "../bin/sbar-orbit.cmd");
    const argv = ["cmd.exe", "/d", "/v:off", "/s", "/c", `""${launcher}" help"`];
    const env = { ...process.env, ORBIT_BUN: missing };
    const { code, out, err } = await runCmd(argv, env);
    await launcherDiagnostic("missing-pin", argv, env, launcher, missing, { code, out, err });
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
      const argv = ["cmd.exe", "/d", "/v:off", "/s", "/c", `"${argumentsText.slice(3)}"`];
      const env = { SystemRoot: process.env.SystemRoot, USERPROFILE: root,
        LOCALAPPDATA: join(root, "appdata"), PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32") };
      const { code, out, err } = await runCmd(argv, env);
      await launcherDiagnostic(location, argv, env, launcher, runtime, { code, out, err });
      console.log(JSON.stringify({ windowsTaskArgumentsDiagnostic: { location, argumentsText } }));
      expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
      const selected = JSON.parse(await readFile(record, "utf8"));
      expect(selected.runtime.toLowerCase()).toBe(runtime.toLowerCase());
      expect(selected.args).toEqual([runtime, "run", join(source, "src/cli.ts"), "serve", "--managed-socket"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
