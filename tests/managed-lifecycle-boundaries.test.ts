import { releaseFixture } from "./managed-release-fixture";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { Sessions } from "../src/session";
import { NativeBackend } from "../src/hyprland";
import { OrbitError } from "../src/errors";
import { activateVersion, currentVersion, launcherName } from "../src/update";
import { installService, serviceUnit, serviceUnitDrift } from "../src/service";
import { brokerAgentPlist } from "../src/macos-autostart";
import { fixtureRoot } from "./platform-support";

async function prepared(root: string) {
  for (const version of ["0.1.0", "0.2.0"]) {
    await releaseFixture(join(root, "versions", version), version);
  }
  await activateVersion("0.1.0", { root, openSessions: async () => 0,
    restart: async () => ({ ok: true, output: "" }), healthy: async () => true });
}

for (const state of ["expired lease", "successor broker", "unknown storage"]) {
  test(`durable admission refuses session create with ${state}`, async () => {
    const root = await fixtureRoot("orbit-durable-admission-");
    const prior = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(root, "data");
    const sessions = new Sessions(join(root, "workspace"));
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      if (state === "expired lease") {
        const lease = await sessions.dispatch({ method: "update.begin" }) as { expires: number };
        clock = spyOn(Date, "now").mockReturnValue(lease.expires + 1);
      }
      if (state === "unknown storage") await fs.writeFile(join(root, "data"), "not a directory");
      else {
        await fs.mkdir(join(root, "data", "sbar-orbit"), { recursive: true });
        await fs.writeFile(join(root, "data", "sbar-orbit", "activation-recovery.json"), '{"phase":"pending"}');
      }
      await expect(sessions.dispatch({ method: "session.create", params: { backend: "unsupported" } }))
        .rejects.toMatchObject({ code: "PROFILE_BUSY" });
    } finally {
      clock?.mockRestore();
      if (prior === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prior;
      await sessions.close(); await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("durable admission refuses native.open without executing its implementation", async () => {
  const root = await fixtureRoot("orbit-native-admission-");
  const prior = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, "data");
  const sessions = new Sessions(join(root, "workspace"), undefined, undefined,
    { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" });
  let calls = 0;
  const opening = spyOn(NativeBackend, "openApplication").mockImplementation(async () => {
    calls++; throw new OrbitError("UNSUPPORTED", "fixture sentinel, no native execution");
  });
  try {
    await fs.mkdir(join(root, "data", "sbar-orbit"), { recursive: true });
    await fs.writeFile(join(root, "data", "sbar-orbit", "activation-recovery.json"), '{"phase":"pending"}');
    await expect(sessions.dispatch({ method: "native.open", params: { requestId: "blocked", workspace: 4, argv: ["fixture"] } }))
      .rejects.toMatchObject({ code: "PROFILE_BUSY" });
    expect(calls).toBe(0);
  } finally {
    opening.mockRestore();
    if (prior === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prior;
    await sessions.close(); await fs.rm(root, { recursive: true, force: true });
  }
});

for (const storageFailure of [false, true]) {
  test(`unconfirmed rollback returns both causes with evidence failure ${storageFailure}`, async () => {
    const root = await fixtureRoot("orbit-unconfirmed-causes-");
    let uuid: ReturnType<typeof spyOn> | undefined;
    try {
      await prepared(root);
      let restarts = 0;
      const result = await activateVersion("0.2.0", { root, openSessions: async () => 0, healthy: async () => true,
        restart: async () => {
          if (++restarts === 1) return { ok: false, output: "original activation cause" };
          if (storageFailure) {
            const blocked = "00000000-0000-0000-0000-000000000000";
            await fs.mkdir(join(root, `activation-recovery.json.${blocked}.tmp`));
            uuid = spyOn(crypto, "randomUUID").mockReturnValue(blocked);
          }
          return { ok: false, output: "original rollback cause", stopUnconfirmed: true };
        } });
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain("original activation cause");
      expect(reason).toContain("original rollback cause");
      if (storageFailure) expect(reason).toContain("evidence update failed");
      expect(await Bun.file(join(root, "activation-recovery.json")).exists()).toBe(true);
    } finally { uuid?.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
}

test.skipIf(process.platform === "win32")("directory sync failure before completion tombstone persistence preserves admission", async () => {
  const root = await fixtureRoot("orbit-unlink-sync-");
  try {
    await prepared(root);
    const original = fs.open;
    let directoryOpens = 0;
    const opened = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === root && ++directoryOpens === 2)
        spyOn(handle, "sync").mockRejectedValue(new Error("fixture EIO after unlink"));
      return handle;
    });
    let result;
    try { result = await activateVersion("0.2.0", { root, openSessions: async () => 0,
      restart: async () => ({ ok: true, output: "" }), healthy: async () => true }); }
    finally { opened.mockRestore(); }
    expect((result as { reason: string }).reason).toContain("fixture EIO after unlink");
    expect(await Bun.file(join(root, "activation-recovery.json")).exists()).toBe(true);
    let restarts = 0;
    await activateVersion("0.1.0", { root, openSessions: async () => 0, restart: async () => { restarts++; return { ok: true, output: "" }; } });
    expect(restarts).toBe(0);
    expect(await currentVersion(root)).toBe("0.2.0");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Unix managed launcher refuses absent exact Bun despite alternate PATH runtime", async () => {
  const root = await fixtureRoot("orbit-unix-pin-");
  try {
    const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "../bin/sbar-orbit"), "help"], {
      env: { ...process.env, ORBIT_BUN: join(root, "missing", "bun"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: out + err }).toMatchObject({ code: 127, output: expect.stringContaining("pinned ORBIT_BUN runtime") });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Unix account mechanisms record an exact managed Bun path", () => {
  expect(serviceUnit("/fixture/orbit", "/fixture/units")).toContain(`ORBIT_BUN=${process.execPath}`);
  expect(brokerAgentPlist("/fixture/orbit", "/fixture/socket")).toContain(`<string>${process.execPath}</string>`);
});

test.skipIf(process.platform === "win32")("Unix defined empty pin refuses while unset and exact pins retain launcher compatibility", async () => {
  const root = await fixtureRoot("orbit-unix-pin-compat-");
  try {
    const runtime = join(root, "bin", "bun");
    await fs.mkdir(dirname(runtime));
    await fs.writeFile(runtime, "#!/bin/sh\nprintf 'fixture Bun selected\\n'\n", { mode: 0o700 });
    for (const pin of [undefined, runtime, ""]) {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(runtime)}:/usr/bin:/bin` };
      if (pin === undefined) delete env.ORBIT_BUN; else env.ORBIT_BUN = pin;
      const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "../bin/sbar-orbit"), "status"], { env, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (pin === "") {
        expect(code).toBe(127); expect(err).toContain("pinned ORBIT_BUN runtime");
      } else {
        expect(code).toBe(0); expect(out).toContain("fixture Bun selected");
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Unix installed ownership schema refuses an omitted runtime pin", async () => {
  const root = await fixtureRoot("orbit-unit-pin-schema-");
  try {
    const launcher = join(root, "orbit");
    await fs.writeFile(launcher, "#!/bin/sh\n", { mode: 0o700 });
    await installService(launcher, root);
    expect(await serviceUnitDrift(root, launcher)).toMatchObject({ current: true });
    const path = join(root, "sbar-orbit.service");
    await fs.writeFile(path, (await fs.readFile(path, "utf8")).replace(/^Environment="ORBIT_BUN=.*"\n/m, ""));
    expect(await serviceUnitDrift(root, launcher)).toMatchObject({ current: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const command of ["status", "serve"]) {
  test.skipIf(process.platform === "win32")(`Unix differently named exact runtime executes outer and nested ${command} argv`, async () => {
    const root = await fixtureRoot("orbit-renamed-pin-");
    try {
      const directory = join(root, "runtime & tools"), pin = join(directory, "bun-pinned");
      await fs.mkdir(directory);
      for (const [path, label] of [[pin, "selected"], [join(directory, "bun"), "alternate"]]) {
        if (!path || !label) throw new Error("Missing runtime fixture");
        await fs.writeFile(path, `#!/bin/sh\nprintf '${label}\\n'\nprintf '%s\\n' "$@"\n`, { mode: 0o700 });
      }
      const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "../bin/sbar-orbit"), command], {
        env: { ...process.env, ORBIT_BUN: pin, PATH: `${directory}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const cli = join(import.meta.dir, "../src/cli.ts"), limited = join(import.meta.dir, "../scripts/limited.ts");
      expect({ code, args: out.trim().split("\n"), err }).toEqual({ code: 0, err: "", args: command === "serve"
        ? ["selected", "run", limited, pin, "run", cli, "serve"] : ["selected", "run", cli, "status"] });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const stage of ["pointer", "restart", "health"]) {
  for (const storageFailure of [false, true]) {
    test(`exceptional rollback ${stage} retains both causes with evidence failure ${storageFailure}`, async () => {
      const root = await fixtureRoot("orbit-rollback-exception-");
      let uuid: ReturnType<typeof spyOn> | undefined;
      let renamed: ReturnType<typeof spyOn> | undefined;
      try {
        await prepared(root);
        const cause = `rollback ${stage} EIO`;
        const fail = async () => {
          if (storageFailure) {
            const blocked = "00000000-0000-0000-0000-000000000000";
            await fs.mkdir(join(root, `activation-recovery.json.${blocked}.tmp`));
            uuid = spyOn(crypto, "randomUUID").mockReturnValue(blocked);
          }
          throw new Error(cause);
        };
        if (stage === "pointer") {
          const original = fs.rename;
          let currentRenames = 0;
          renamed = spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
            if (args[1] === join(root, "current") && ++currentRenames === 2) return fail();
            return original(...args);
          });
        }
        let restarts = 0;
        const result = await activateVersion("0.2.0", { root, openSessions: async () => 0,
          restart: async () => {
            if (++restarts === 1) return { ok: false, output: "initial activation EIO" };
            if (stage === "restart") return fail();
            return { ok: true, output: "" };
          }, healthy: async () => stage === "health" ? fail() : true });
        const reason = (result as { reason: string }).reason;
        expect(reason).toContain("initial activation EIO");
        expect(reason).toContain(cause);
        const marker = JSON.parse(await fs.readFile(join(root, "activation-recovery.json"), "utf8"));
        expect(marker.activationFailure).toContain("initial activation EIO");
        if (storageFailure) {
          expect(reason).toContain("evidence update failed");
          const diagnostic = JSON.parse(await fs.readFile(join(root, "activation-failure.json"), "utf8"));
          expect(diagnostic.activationFailure).toContain("initial activation EIO");
          expect(diagnostic.rollbackFailure).toContain(cause);
          expect(diagnostic.persistenceFailure).toBeString();
        } else expect(marker.rollbackFailure).toContain(cause);
      } finally { renamed?.mockRestore(); uuid?.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
    });
  }
}
