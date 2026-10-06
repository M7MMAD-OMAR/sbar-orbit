import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installService, serviceUnit, serviceUnitDrift, updateServiceUnit } from "../src/service";

const linuxTest = test.skipIf(process.platform !== "linux");
const managerAvailable = process.platform === "linux" && !!process.env.XDG_RUNTIME_DIR
  && !!Bun.which("systemctl")
  && Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function assignments(unit: string): Record<string, string> {
  return Object.fromEntries(unit.split("\n").filter(line => line.startsWith("Environment="))
    .map(line => {
      const value = JSON.parse(line.slice("Environment=".length).replace(/%%/g, "%")) as string;
      const separator = value.indexOf("=");
      return [value.slice(0, separator), value.slice(separator + 1)];
    }));
}

linuxTest("broker and updater retain selected installer paths when the manager environment differs", () => {
  const installer = {
    HOME: "/fixture/home %u space", XDG_CONFIG_HOME: "/fixture/config %u space",
    XDG_DATA_HOME: "/fixture/data space", XDG_CACHE_HOME: "/fixture/cache space", XDG_STATE_HOME: "/fixture/state space",
    FLATPAK_USER_DIR: "/fixture/user flatpak", FLATPAK_SYSTEM_DIR: "/fixture/system flatpak",
    BUN_INSTALL: "/fixture/custom bun", PATH: "/fixture/custom bun/bin:/fixture/custom apps:relative::/usr/bin:/usr/bin",
    XDG_RUNTIME_DIR: "/fixture/temporary installer runtime", PRIVATE_FIXTURE_TOKEN: "fixture-only",
    ORBIT_NATIVE_PLAN: "/fixture/unrequested operator plan",
  };
  for (const build of [serviceUnit, updateServiceUnit]) {
    const unit = build("/fixture/launcher", "/fixture/units", installer);
    const selected = assignments(unit);
    for (const key of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "FLATPAK_USER_DIR",
      "FLATPAK_SYSTEM_DIR", "BUN_INSTALL", "HOME", "XDG_CONFIG_HOME"] as const)
      expect(selected[key]).toBe(installer[key]);
    expect(selected.ORBIT_UNIT_DIR).toBe("/fixture/units");
    expect(selected.PATH?.split(":")[0]).toBe(dirname(process.execPath));
    expect(selected.PATH?.split(":")).toContain("/fixture/custom apps");
    expect(selected.PATH?.split(":")).not.toContain("relative");
    expect(selected.PATH?.split(":")).not.toContain("");
    expect(selected.XDG_RUNTIME_DIR).toBeUndefined();
    expect(selected.PRIVATE_FIXTURE_TOKEN).toBeUndefined();
    expect(selected.ORBIT_NATIVE_PLAN).toBeUndefined();
    // The shell launcher prepends its Bun directory; repeated starts must not cause unit drift.
    expect(build("/fixture/launcher", "/fixture/units", { ...installer, PATH: `${dirname(process.execPath)}:${selected.PATH}` }))
      .toBe(unit);
  }
});

linuxTest("service path selection ignores empty and relative optional directories and refuses control characters", () => {
  const installer = { HOME: "/fixture/home", XDG_DATA_HOME: "relative", XDG_CACHE_HOME: "", XDG_STATE_HOME: "../state",
    FLATPAK_USER_DIR: "relative", FLATPAK_SYSTEM_DIR: "", BUN_INSTALL: "relative" };
  for (const build of [serviceUnit, updateServiceUnit]) {
    const selected = assignments(build("/fixture/launcher", "/fixture/units", installer));
    for (const key of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "FLATPAK_USER_DIR", "FLATPAK_SYSTEM_DIR", "BUN_INSTALL"])
      expect(selected[key]).toBeUndefined();
    for (const value of ["/fixture/data\nnew-line", "/fixture/data\rreturn", "/fixture/data\0nul"])
      expect(() => build("/fixture/launcher", "/fixture/units", { ...installer, XDG_DATA_HOME: value }))
        .toThrow("Service path XDG_DATA_HOME must not contain line breaks or NUL");
  }
});

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
    await writeFile(environmentFile, 'ORBIT_CAPTURE_TIMEOUT_MS=4321\nORBIT_NATIVE_PLAN="/fixture/owner plan"\nORBIT_NATIVE_CONTROL="/fixture/control"\n'
      + `XDG_DATA_HOME="${join(box.root, "operator data")}"\n`, { mode: 0o600 });
    const installer = { HOME: process.env.HOME, XDG_CONFIG_HOME: box.config,
      XDG_DATA_HOME: join(box.root, "installer data"), XDG_CACHE_HOME: join(box.root, "installer cache"),
      XDG_STATE_HOME: join(box.root, "installer state"), FLATPAK_USER_DIR: join(box.root, "installer flatpak user"),
      FLATPAK_SYSTEM_DIR: join(box.root, "installer flatpak system"), BUN_INSTALL: join(box.root, "custom bun"),
      XDG_RUNTIME_DIR: join(box.root, "temporary runtime"), PRIVATE_FIXTURE_TOKEN: "fixture-only",
      PATH: `${join(box.root, "custom applications")}:${process.env.PATH || ""}` };
    await writeFile(probe, ["import json, os, sys", "with open(sys.argv[1], 'w') as stream:",
      "    json.dump({key: os.environ.get(key) for key in ('ORBIT_CAPTURE_TIMEOUT_MS', 'ORBIT_NATIVE_PLAN', 'ORBIT_NATIVE_CONTROL', 'HOME', 'XDG_CONFIG_HOME', 'ORBIT_UNIT_DIR', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'FLATPAK_USER_DIR', 'FLATPAK_SYSTEM_DIR', 'BUN_INSTALL', 'PATH', 'XDG_RUNTIME_DIR', 'PRIVATE_FIXTURE_TOKEN')}, stream)"].join("\n"));
    const generated = serviceUnit("/fixture/sbar-orbit", process.env.ORBIT_UNIT_DIR, installer);
    const directive = generated.split("\n").filter(line => line.startsWith("EnvironmentFile=") || line.startsWith("Environment=")).join("\n");
    await mkdir(join(unitPath, ".."), { recursive: true });
    await writeFile(unitPath, `[Service]\n${directive}\nType=oneshot\nSlice=sbarorbit.slice\nExecStart=/usr/bin/python3 ${probe} ${output}\n`, { mode: 0o600, flag: "wx" });
    await command(["systemctl", "--user", "daemon-reload"]);
    await command(["systemctl", "--user", "start", unit]);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      HOME: process.env.HOME, XDG_CONFIG_HOME: box.config, ORBIT_UNIT_DIR: process.env.ORBIT_UNIT_DIR,
      XDG_DATA_HOME: join(box.root, "operator data"), XDG_CACHE_HOME: installer.XDG_CACHE_HOME, XDG_STATE_HOME: installer.XDG_STATE_HOME,
      FLATPAK_USER_DIR: installer.FLATPAK_USER_DIR, FLATPAK_SYSTEM_DIR: installer.FLATPAK_SYSTEM_DIR, BUN_INSTALL: installer.BUN_INSTALL,
      PATH: assignments(generated).PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PRIVATE_FIXTURE_TOKEN: null,
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
