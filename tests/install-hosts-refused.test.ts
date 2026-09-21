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
 *
 * The sandbox home is passed as an OPTION rather than exported as `HOME`, and that is the whole
 * difference between a test that passes here and one that passes anywhere. `homedir()` reads the
 * password database on POSIX, not the environment, so setting `process.env.HOME` moved nothing: on
 * the Ubuntu runner this read the runner's real `~/.claude.json`, found no entry to collide with and
 * reported `skipped`. Worse than the red test, a test that resolves the real home is a test that can
 * write to a developer's own agent configuration.
 *
 * The run is a dry run for a second reason beyond changing nothing: `hosts` skips itself outright
 * when an earlier step failed, so on a machine missing a prerequisite this would never reach the
 * behaviour it exists to pin.
 */
test("a refused host connection leaves the installation reported as installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-hosts-home-"));
  const prefix = await mkdtemp(join(tmpdir(), "orbit-hosts-prefix-"));
  try {
    // An orbit entry that is already there and says something else: exactly what a rerun meets.
    const existing = { mcpServers: { orbit: { command: "/somewhere/else", args: [] } } };
    await writeFile(join(home, ".claude.json"), JSON.stringify(existing));
    const report = await runInstall({
      source: resolve(import.meta.dir, ".."), prefix, service: false, connect: ["claude"], dryRun: true, home,
      install: async () => { throw new Error("A test must not run a package manager"); },
    });
    const hosts = report.steps.find(step => step.id === "hosts");
    // The step still fails and still says why: nothing is hidden, only the verdict changed.
    expect(hosts?.state).toBe("failed");
    expect(hosts?.detail).toContain("left unchanged");
    expect(report.installed).toBe(true);
    expect(report.hostsConnected).toBe(false);
    // And the file it refused to touch is the one it left alone.
    expect(await Bun.file(join(home, ".claude.json")).json()).toEqual(existing);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(prefix, { recursive: true, force: true });
  }
}, 20000);
