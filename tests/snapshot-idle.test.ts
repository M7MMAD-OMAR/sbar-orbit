import { expect, test } from "bun:test";
import { measurePostActionIdle } from "../experiments/browser-performance";

test("post-action idle retains five real samples and their median after settle", async () => {
  const waits: number[] = [];
  const values = [100, 300, 200, 500, 400];
  let read = 0;
  const result = await measurePostActionIdle(async () => `VmRSS: ${values[read++]} kB\n`, async ms => { waits.push(ms); });
  expect(waits).toEqual([200, 50, 50, 50, 50]);
  expect(result.samples.map(sample => sample.rssBytes)).toEqual(values.map(value => value * 1024));
  expect(result.rssBytes).toBe(300 * 1024);
  expect(result.samples.every(sample => Number.isFinite(sample.atUnixMs))).toBe(true);
});

test("missing, zero and nonfinite retained-worker memory cannot become a measured pass", async () => {
  for (const status of ["", "VmRSS: 0 kB\n", "VmRSS: 9999999999999999999999999 kB\n"])
    await expect(measurePostActionIdle(async () => status, async () => {})).rejects.toThrow("post-action idle RSS");
});
