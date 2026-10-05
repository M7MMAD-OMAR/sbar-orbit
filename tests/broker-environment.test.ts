import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installService, serviceUnit, serviceUnitDrift } from "../src/service";

const linuxTest = test.skipIf(process.platform !== "linux");
const managerAvailable = process.platform === "linux" && !!process.env.XDG_RUNTIME_DIR
  && !!Bun.which("systemctl")
  && Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

async function configuration(xdg: boolean) {
  const root = await mkdtemp(join(tmpdir(), "orbit-broker-environment-"));
  const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, units: process.env.ORBIT_UNIT_DIR };
  process.env.HOME = join(root, "home %u space");
  if (xdg) process.env.XDG_CONFIG_HOME = join(root, "config %u space");
  else delete process.env.XDG_CONFIG_HOME;
  process.env.ORBIT_UNIT_DIR = join(root, "chosen-units");
  const config = process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config");
  return { root, config, async close() {
    for (const [key, value] of [["HOME", previous.home], ["XDG_CONFIG_HOME", previous.config], ["ORBIT_UNIT_DIR", previous.units]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  } };
}

for (const xdg of [true, false]) {
  linuxTest(`broker unit reads operator configuration under ${xdg ? "XDG_CONFIG_HOME" : "HOME"}`, async () => {
    const box = await configuration(xdg);
    try {
      expect(serviceUnit("/fixture/sbar-orbit").split("\n").find(line => line.startsWith("EnvironmentFile=")))
        .toBe(`EnvironmentFile=-${join(box.config, "sbar-orbit/broker.env").replace(/%/g, "%%")}`);
    } finally { await box.close(); }
  });
}

linuxTest("installed broker preserves its configuration and explicit unit directory for doctor", async () => {
  const box = await configuration(true);
  const directory = join(box.root, "option-units");
  try {
    await installService(join(import.meta.dir, "../bin/sbar-orbit"), directory);
    const unit = await readFile(join(directory, "sbar-orbit.service"), "utf8");
    const assignment = (key: string, value: string) => `Environment=${JSON.stringify(`${key}=${value}`).replace(/%/g, "%%")}`;
    expect(unit).toContain(assignment("HOME", process.env.HOME || ""));
    expect(unit).toContain(assignment("XDG_CONFIG_HOME", box.config));
    expect(unit).toContain(assignment("ORBIT_UNIT_DIR", directory));
    expect((await serviceUnitDrift(directory)).current).toBe(true);
  } finally { await box.close(); }
});

// Only the directive under test runs in this disposable unit. No Orbit broker, compositor or user application starts.
test.skipIf(!managerAvailable)("systemd loads broker.env from a redirected configuration path with spaces and percent specifiers", async () => {
  const box = await configuration(true);
  const unit = `orbit-broker-environment-${crypto.randomUUID()}.service`;
  const unitPath = join(process.env.XDG_RUNTIME_DIR || "", "systemd/user", unit);
  const output = join(box.root, "output.json");
  const probe = join(box.root, "probe.py");
  async function command(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${err}`);
    return out;
  }
  try {
    expect(process.env.XDG_RUNTIME_DIR).toBeTruthy();
    const environmentFile = join(box.config, "sbar-orbit/broker.env");
    await mkdir(join(box.config, "sbar-orbit"), { recursive: true, mode: 0o700 });
    await writeFile(environmentFile, 'ORBIT_CAPTURE_TIMEOUT_MS=4321\nORBIT_NATIVE_PLAN="/fixture/owner plan"\nORBIT_NATIVE_CONTROL="/fixture/control"\n', { mode: 0o600 });
    await writeFile(probe, ["import json, os, sys", "with open(sys.argv[1], 'w') as stream:",
      "    json.dump({key: os.environ.get(key) for key in ('ORBIT_CAPTURE_TIMEOUT_MS', 'ORBIT_NATIVE_PLAN', 'ORBIT_NATIVE_CONTROL', 'HOME', 'XDG_CONFIG_HOME', 'ORBIT_UNIT_DIR')}, stream)"].join("\n"));
    const directive = serviceUnit("/fixture/sbar-orbit").split("\n").filter(line => line.startsWith("EnvironmentFile=") || line.startsWith("Environment=")).join("\n");
    await mkdir(join(unitPath, ".."), { recursive: true });
    await writeFile(unitPath, `[Service]\n${directive}\nType=oneshot\nSlice=sbarorbit.slice\nExecStart=/usr/bin/python3 ${probe} ${output}\n`, { mode: 0o600, flag: "wx" });
    await command(["systemctl", "--user", "daemon-reload"]);
    await command(["systemctl", "--user", "start", unit]);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      HOME: process.env.HOME, XDG_CONFIG_HOME: box.config, ORBIT_UNIT_DIR: process.env.ORBIT_UNIT_DIR,
      ORBIT_CAPTURE_TIMEOUT_MS: "4321", ORBIT_NATIVE_PLAN: "/fixture/owner plan", ORBIT_NATIVE_CONTROL: "/fixture/control",
    });
  } finally {
    const stop = Bun.spawn(["systemctl", "--user", "stop", unit], { stdout: "ignore", stderr: "ignore" });
    await stop.exited;
    await rm(unitPath, { force: true });
    await command(["systemctl", "--user", "daemon-reload"]);
    await box.close();
  }
}, 30000);
