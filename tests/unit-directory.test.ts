import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as service from "../src/service";
import * as autostart from "../src/autostart";
import { runInstall } from "../src/install";
import { Sessions } from "../src/session";

const linuxTest = test.skipIf(process.platform !== "linux");
const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ORBIT_UNIT_DIR", "APPDATA"] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-unit-directory-"));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.APPDATA = join(root, "config");
  delete process.env.ORBIT_UNIT_DIR;
  return { root, async close() {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  } };
}

for (const mode of ["XDG_CONFIG_HOME", "HOME", "ORBIT_UNIT_DIR", "option"] as const) {
  linuxTest(`installer resolves systemd units from ${mode}`, async () => {
    const box = await fixture();
    const expected = mode === "HOME" ? join(box.root, "home/.config/systemd/user")
      : mode === "XDG_CONFIG_HOME" ? join(box.root, "config/systemd/user") : join(box.root, "chosen-units");
    if (mode === "HOME") delete process.env.XDG_CONFIG_HOME;
    if (mode === "ORBIT_UNIT_DIR") process.env.ORBIT_UNIT_DIR = expected;
    if (mode === "option") process.env.ORBIT_UNIT_DIR = join(box.root, "environment-units");
    let received: string | undefined;
    // Stop at the writer boundary, before autostart can register anything with the user manager.
    const writer = spyOn(service, "installService").mockImplementation(async (_launcher, directory) => {
      received = directory;
      throw new Error("fixture stops before registering services");
    });
    try {
      const report = await runInstall({ prefix: join(box.root, "prefix"),
        unitDirectory: mode === "option" ? expected : undefined,
        install: async () => { throw new Error("fixture must not install packages"); } });
      expect(report.steps.find(step => step.id === "service")?.state).toBe("failed");
      expect(received).toBe(expected);
    } finally { writer.mockRestore(); await box.close(); }
  }, 20000);
}

linuxTest("installer passes its explicit unit directory to panel autostart", async () => {
  const box = await fixture();
  const directory = join(box.root, "chosen-units");
  let received: autostart.AutostartPaths | undefined;
  const writer = spyOn(service, "installService").mockImplementation(async launcher =>
    ({ written: [], launcher, enabled: false, started: false }));
  const enable = spyOn(autostart, "enableAutostart").mockImplementation(async (_launcher, paths) => {
    received = paths;
    throw new Error("fixture stops before registering services");
  });
  try {
    await runInstall({ prefix: join(box.root, "prefix"), unitDirectory: directory,
      install: async () => { throw new Error("fixture must not install packages"); } });
    expect(received?.units).toBe(directory);
    expect(received?.xdgAutostart).toBe(join(box.root, "config/autostart"));
  } finally { enable.mockRestore(); writer.mockRestore(); await box.close(); }
}, 20000);

for (const mode of ["XDG_CONFIG_HOME", "HOME", "ORBIT_UNIT_DIR"] as const) {
  linuxTest(`doctor inspects the installed units under ${mode}`, async () => {
    const box = await fixture();
    const directory = mode === "HOME" ? join(box.root, "home/.config/systemd/user")
      : mode === "XDG_CONFIG_HOME" ? join(box.root, "config/systemd/user") : join(box.root, "chosen-units");
    if (mode === "HOME") delete process.env.XDG_CONFIG_HOME;
    if (mode === "ORBIT_UNIT_DIR") process.env.ORBIT_UNIT_DIR = directory;
    try {
      await service.installService(resolve("bin/sbar-orbit"), directory);
      const sessions = new Sessions(join(box.root, "sessions"));
      const doctor = await sessions.dispatch({ method: "doctor" }) as { units: unknown };
      expect(doctor.units).toMatchObject({ managed: true, current: true, missing: [], drifted: [] });
      await rm(join(directory, "sbar-orbit.service"));
      const stale = await sessions.dispatch({ method: "doctor" }) as { units: unknown };
      expect(stale.units).toMatchObject({ managed: true, current: false, missing: ["sbar-orbit.service"] });
    } finally { await box.close(); }
  }, 20000);
}

linuxTest("service command writes units under XDG_CONFIG_HOME without registering services", async () => {
  const box = await fixture();
  try {
    const child = Bun.spawn([process.execPath, "scripts/service.ts", "install", resolve("bin/sbar-orbit"), "--no-autostart"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: await child.exited, err }).toEqual({ code: 0, err: "" });
    const report = JSON.parse(out) as { written: string[] };
    expect(report.written).toHaveLength(4);
    expect(report.written.every(path => path.startsWith(join(box.root, "config/systemd/user") + "/"))).toBe(true);
  } finally { await box.close(); }
}, 20000);
