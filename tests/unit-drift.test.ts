/**
 * The installed units against the ones this version writes.
 *
 * An install rewrites every unit, so drift is never permanent, and that is exactly why nothing
 * noticed it: the failure is silent and self healing on the next install, which can be months away.
 * Found on the development host on 19 September 2026. Its `sbar-orbit.service` predated
 * `EnvironmentFile=-%h/.config/sbar-orbit/broker.env`, so `ORBIT_NATIVE_RENDERER`,
 * `ORBIT_CAPTURE_TIMEOUT_MS` and every other documented operator switch reached a freshly installed
 * managed broker and silently did not reach that one. `docs/cli.md` was correct and the machine
 * disagreed with it, with no way for a person to find out short of diffing a unit by hand.
 *
 * These tests never touch the real unit directory: every one writes into a temporary directory of
 * its own. `docs/windows-measured.md` section 24 records a test that wrote a connector file into the
 * REAL roaming profile because it redirected one variable that the code under test ignored, and the
 * lesson is that a test which can reach a person's configuration eventually will.
 */
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, serviceUnitDrift, serviceUnit } from "../src/service";

/** A real install into a directory of this test's own, plus the launcher it needs to name. */
async function installed() {
  const root = await mkdtemp(join(tmpdir(), "orbit-unit-drift-"));
  const units = join(root, "units");
  const launcher = join(root, "sbar-orbit");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await mkdir(units, { recursive: true });
  await installService(launcher, units);
  return { root, units, launcher };
}

test("a fresh install reports no drift", async () => {
  const { root, units } = await installed();
  try {
    const drift = await serviceUnitDrift(units);
    expect(drift.current).toBe(true);
    expect(drift.drifted).toEqual([]);
    expect(drift.missing).toEqual([]);
    // No remedy where there is nothing to remedy: a permanent warning is a warning people stop
    // reading, which is how the drift this catches survived in the first place.
    expect(drift.remedy).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a unit missing a directive this version writes is reported, and the directive is named", async () => {
  const { root, units, launcher } = await installed();
  try {
    // Exactly the shape found on the development host: the unit as it was written before
    // EnvironmentFile existed, which is a valid unit that starts a working broker.
    const stale = serviceUnit(launcher).split("\n").filter(line => !line.startsWith("EnvironmentFile=")).join("\n");
    await writeFile(join(units, "sbar-orbit.service"), stale, { mode: 0o644 });
    const drift = await serviceUnitDrift(units);
    expect(drift.current).toBe(false);
    expect(drift.drifted.map(entry => entry.unit)).toEqual(["sbar-orbit.service"]);
    // Naming the missing directive is the whole value: "differs" tells a person nothing they can
    // act on, and this is the line whose absence changes behaviour.
    expect(drift.drifted[0]!.reason).toContain("EnvironmentFile=-%h/.config/sbar-orbit/broker.env");
    expect(drift.remedy).toContain("install.sh");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("drift in any one of the four units is caught, not only the broker's", async () => {
  // The slice carries the resource budget and the update pair carries the timer. A check that only
  // looked at sbar-orbit.service would miss a stale CPUQuota, which is the budget this whole
  // project's verification runs inside.
  for (const unit of ["sbarorbit.slice", "sbar-orbit.service", "sbar-orbit-update.service", "sbar-orbit-update.timer"]) {
    const { root, units } = await installed();
    try {
      await writeFile(join(units, unit), "[Unit]\nDescription=Sbar Orbit stale\n", { mode: 0o644 });
      const drift = await serviceUnitDrift(units);
      expect(drift.current).toBe(false);
      expect(drift.drifted.map(entry => entry.unit)).toContain(unit);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a machine with no units at all reports them missing rather than drifted", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-unit-none-"));
  try {
    const drift = await serviceUnitDrift(root);
    expect(drift.drifted).toEqual([]);
    expect(drift.missing).toHaveLength(4);
    expect(drift.current).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a unit pointing at another checkout is compared against its own launcher, not this one", async () => {
  // Without reading ExecStart back, every unit on every machine would read as drifted, since the
  // launcher path is per install. That would be a check nobody could ever satisfy, which is worse
  // than no check: it trains a person to ignore the line.
  const { root, units } = await installed();
  try {
    await writeFile(join(units, "sbar-orbit.service"), serviceUnit("/somewhere/else/sbar-orbit"), { mode: 0o644 });
    const drift = await serviceUnitDrift(units);
    expect(drift.drifted.map(entry => entry.unit)).not.toContain("sbar-orbit.service");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a caller that names a launcher gets that launcher enforced", async () => {
  // The other direction, for an installer verifying its own work: given the launcher it just wrote,
  // a unit naming a different one IS drift.
  const { root, units } = await installed();
  try {
    await writeFile(join(units, "sbar-orbit.service"), serviceUnit("/somewhere/else/sbar-orbit"), { mode: 0o644 });
    const drift = await serviceUnitDrift(units, join(root, "sbar-orbit"));
    expect(drift.drifted.map(entry => entry.unit)).toContain("sbar-orbit.service");
  } finally { await rm(root, { recursive: true, force: true }); }
});
