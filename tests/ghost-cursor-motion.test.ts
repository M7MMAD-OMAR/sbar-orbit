/**
 * The visible ghost cursor's path generator, compiled alone from the marked region of the plugin
 * source and driven with fixed seeds. The region has no compositor dependency by design.
 */
import { test, expect, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../experiments/ghost-cursor/plugin/ghostinput.cpp", import.meta.url));
let dir = "";
let binary = "";

const harness = `
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
REGION
int main(int argc, char** argv) {
    using namespace cursor_motion;
    const uint64_t seed = std::strtoull(argv[1], nullptr, 10);
    const Vec from{std::atof(argv[2]), std::atof(argv[3])}, to{std::atof(argv[4]), std::atof(argv[5])};
    const bool drift = argv[6][0] == '1';
    const double horizon = std::atof(argv[7]);
    const bool overshoot = argc < 9 || argv[8][0] != '0';
    const Move m = plan(from, to, seed, 10.0, drift, overshoot);
    std::printf("total %.9f\\n", m.total());
    for (double t = 9.0; t <= 10.0 + horizon; t += 0.004) {
        const Vec p = position(m, t);
        std::printf("%.4f %.9f %.9f\\n", t - 10.0, p.x, p.y);
    }
    const Vec end = position(m, 10.0 + m.total());
    std::printf("end %.17g %.17g\\n", end.x, end.y);
    // A follow-up action planned mid-drift starts exactly where the drawing is.
    const double cancelAt = 10.0 + m.total() + 2.5;
    const Vec shown = position(m, cancelAt);
    const Move next = plan(shown, {to.x + 90, to.y - 40}, seed + 1, cancelAt, true);
    const Vec first = position(next, cancelAt);
    std::printf("cancel %.17g %.17g %.17g %.17g\\n", shown.x, shown.y, first.x, first.y);
}
`;

beforeAll(async () => {
  const text = await Bun.file(source).text();
  const begin = text.indexOf("// BEGIN cursor-motion");
  const end = text.indexOf("// END cursor-motion");
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  dir = await mkdtemp(join(tmpdir(), "orbit-motion-"));
  await writeFile(join(dir, "motion.cpp"), harness.replace("REGION", text.slice(begin, end)));
  const build = Bun.spawnSync(["g++", "-std=c++23", "-O1", join(dir, "motion.cpp"), "-o", join(dir, "motion")], { stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  binary = join(dir, "motion");
  return async () => { await rm(dir, { recursive: true, force: true }); };
}, 120_000);

type Run = { total: number; samples: { t: number; x: number; y: number }[]; end: [number, number]; cancel: number[] };
function run(seed: number, from: [number, number], to: [number, number], drift = true, horizon = 6, overshoot = true): Run {
  const out = Bun.spawnSync([binary, String(seed), ...from.map(String), ...to.map(String), drift ? "1" : "0", String(horizon), overshoot ? "1" : "0"]);
  const lines = out.stdout.toString().trim().split("\n");
  const total = Number(lines[0]!.split(" ")[1]);
  const samples = lines.slice(1).filter((l) => /^-?[0-9]/.test(l)).map((l) => {
    const [t, x, y] = l.split(" ").map(Number);
    return { t: t!, x: x!, y: y! };
  });
  const end = lines.find((l) => l.startsWith("end"))!.split(" ").slice(1).map(Number) as [number, number];
  const cancel = lines.find((l) => l.startsWith("cancel"))!.split(" ").slice(1).map(Number);
  return { total, samples, end, cancel };
}

const seeds = Array.from({ length: 25 }, (_, i) => i * 7919 + 1);

test("the same seed gives the same path and a different seed a different one", () => {
  const a = run(5, [100, 100], [700, 400]);
  const b = run(5, [100, 100], [700, 400]);
  const c = run(6, [100, 100], [700, 400]);
  expect(b).toEqual(a);
  expect(c.samples[275]).not.toEqual(a.samples[275]);
});

test("the start and the landing point are exact for short, medium and long moves", () => {
  for (const seed of seeds) {
    for (const to of [[110, 104], [260, 190], [900, 700], [20, 780]] as [number, number][]) {
      const r = run(seed, [100, 100], to);
      expect(r.samples.find((s) => s.t <= -0.5)).toMatchObject({ x: 100, y: 100 });
      // The boundary instant is evaluated through a float round trip, so allow rounding only.
      expect(r.end[0]).toBeCloseTo(to[0], 9);
      expect(r.end[1]).toBeCloseTo(to[1], 9);
      const still = run(seed, [100, 100], to, false, r.total + 0.5).samples.at(-1)!;
      expect([still.x, still.y]).toEqual(to);
    }
  }
});

test("duration scales with distance, has a floor and a ceiling", () => {
  const near = run(1, [0, 0], [5, 0]).total, mid = run(1, [0, 0], [300, 0]).total, far = run(1, [0, 0], [3000, 0]).total;
  expect(near).toBeGreaterThanOrEqual(0.14);
  expect(mid).toBeGreaterThan(near);
  expect(far).toBeGreaterThan(mid);
  expect(far).toBeLessThanOrEqual(1.1);
  expect(run(1, [50, 50], [50, 50]).total).toBe(0);
});

test("the path is curved, bounded, and overshoots only on long moves", () => {
  for (const seed of seeds) {
    const long = run(seed, [100, 300], [900, 300], false);
    const lateral = Math.max(...long.samples.map((s) => Math.abs(s.y - 300)));
    expect(lateral).toBeGreaterThan(1);
    expect(lateral).toBeLessThanOrEqual(61);
    const past = Math.max(...long.samples.map((s) => s.x));
    expect(past).toBeGreaterThan(900);
    expect(past).toBeLessThanOrEqual(900 + 14 + 3);
    const short = run(seed, [100, 300], [220, 300], false);
    expect(Math.max(...short.samples.map((s) => s.x))).toBeLessThanOrEqual(220 + 0.001);
  }
});

test("velocity starts and ends at rest and the path never moves backwards in time-steps larger than a frame", () => {
  const r = run(3, [100, 100], [500, 100], false);
  const moving = r.samples.filter((s) => s.t >= 0 && s.t <= r.total);
  const speed = (i: number) => Math.hypot(moving[i + 1]!.x - moving[i]!.x, moving[i + 1]!.y - moving[i]!.y);
  const peak = Math.max(...moving.slice(0, -1).map((_, i) => speed(i)));
  expect(speed(0)).toBeLessThan(peak * 0.1);
  expect(speed(moving.length - 2)).toBeLessThan(peak * 0.1);
  // No frame jump larger than the peak step: motion stays continuous.
  for (let i = 0; i < moving.length - 1; i++) expect(speed(i)).toBeLessThanOrEqual(peak + 1e-9);
});

test("idle drift is small, bounded, eases in from the landing point and keeps moving", () => {
  for (const seed of seeds) {
    const r = run(seed, [100, 100], [400, 250]);
    const idle = r.samples.filter((s) => s.t >= r.total);
    expect(Math.hypot(idle[0]!.x - 400, idle[0]!.y - 250)).toBeLessThan(0.05);
    let farthest = 0;
    for (const s of idle) farthest = Math.max(farthest, Math.hypot(s.x - 400, s.y - 250));
    expect(farthest).toBeLessThanOrEqual(3 * Math.SQRT2);
    expect(farthest).toBeGreaterThan(0.3);
    const late = idle.filter((s) => s.t > r.total + 3);
    const spread = Math.max(...late.map((s) => s.x)) - Math.min(...late.map((s) => s.x));
    expect(spread).toBeGreaterThan(0.01);
    // Slow: well under a pixel per 4 ms frame.
    for (let i = 0; i < idle.length - 1; i++) {
      expect(Math.hypot(idle[i + 1]!.x - idle[i]!.x, idle[i + 1]!.y - idle[i]!.y)).toBeLessThan(0.15);
    }
  }
});

test("no drift when a button is held", () => {
  const r = run(9, [100, 100], [400, 250], false);
  for (const s of r.samples.filter((s) => s.t >= r.total)) expect([s.x, s.y]).toEqual([400, 250]);
});

test("the next action cancels drift and starts exactly where the cursor is drawn", () => {
  for (const seed of seeds) {
    const r = run(seed, [100, 100], [400, 250]);
    expect(r.cancel[2]).toBe(r.cancel[0]!);
    expect(r.cancel[3]).toBe(r.cancel[1]!);
  }
});

test("a held button never overshoots: the path stays on this side of the target and ends exactly on it", () => {
  for (const seed of seeds) {
    const r = run(seed, [100, 300], [900, 300], false, 6, false);
    expect(Math.max(...r.samples.map((s) => s.x))).toBeLessThanOrEqual(900 + 0.001);
    expect(r.end[0]).toBeCloseTo(900, 9);
  }
});
