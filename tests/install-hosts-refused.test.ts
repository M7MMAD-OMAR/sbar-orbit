import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInstall } from "../src/install";

/**
 * A refused agent host is not a broken installation.
 *
 * `addHostEntry` refuses an existing `orbit` entry whose settings differ, on purpose: nothing of the
 * person's own configuration is overwritten. A second run of the installer therefore fails that step
 * every time, and the report used to call the whole installation failed, printing "Orbit is not
 * installed" under a broker that was running the whole time. People went looking for a broken
 * install that did not exist, which is the opposite of what a one-command installer is for.
 */
test("a refused host connection leaves the installation reported as installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-hosts-home-"));
  const prefix = await mkdtemp(join(tmpdir(), "orbit-hosts-prefix-"));
  const config = await mkdtemp(join(tmpdir(), "orbit-hosts-config-"));
  const previous = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, appData: process.env.APPDATA };
  // Claude's config is read from HOME, so the whole probe stays inside the sandbox and the person's
  // own .claude.json is never opened, let alone written.
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = config;
  process.env.APPDATA = config;
  try {
    // An orbit entry that is already there and says something else: exactly what a rerun meets.
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { orbit: { command: "/somewhere/else", args: [] } } }));
    const report = await runInstall({
      source: resolve(import.meta.dir, ".."), prefix, service: false, connect: ["claude"], dryRun: true,
      install: async () => { throw new Error("A test must not run a package manager"); },
    });
    const hosts = report.steps.find(step => step.id === "hosts");
    // The step still fails and still says why: nothing is hidden, only the verdict changed.
    expect(hosts?.state).toBe("failed");
    expect(hosts?.detail).toContain("left unchanged");
    expect(report.installed).toBe(true);
    expect(report.hostsConnected).toBe(false);
  } finally {
    for (const [key, value] of [["HOME", previous.home], ["XDG_CONFIG_HOME", previous.xdg], ["APPDATA", previous.appData]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(prefix, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  }
}, 20000);
