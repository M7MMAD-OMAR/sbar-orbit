import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function poll(options: { transient?: boolean; unknown?: boolean; pidSurvives?: boolean; noWitness?: boolean } = {}) {
  // Run the production reaping loop with owned-only PID and stable-handle mocks.
  const source = await readFile(process.env.ORBIT_CRASH_POLL_SOURCE || new URL("./browser-crash.test.ts", import.meta.url), "utf8");
  const loop = /    for \(let i = 0; i < 150; i\+\+\) \{[\s\S]*?\n    \}/.exec(source)?.[0];
  if (!loop) throw new Error("Production broker crash reaping loop was not found");
  let elapsed = 0, observations = 0;
  const witnesses = options.noWitness ? undefined : { observe() {
    observations++;
    if (options.unknown) throw new Error("stable witness query unknown");
    return [{ pid: 42, state: options.transient && elapsed >= 30 ? "exited" : "alive" }];
  } };
  const result = await new Function("owned", "alive", "witnesses", "Bun",
    `return (async () => { let survivors = owned; let polls = 0; ${loop.replace(": pid is number", "")} return { survivors, measured: witnesses?.observe() ?? [] }; })();`)(
    [42], async () => options.pidSurvives ?? false, witnesses, { sleep: async (ms: number) => { elapsed += ms; } },
  ) as { survivors: number[]; measured: { pid: number; state: string }[] };
  return { ...result, elapsed, observations };
}

test("broker crash polling waits for stable handles after PID probes report no survivors", async () => {
  const result = await poll({ transient: true });
  expect(result.survivors).toEqual([]);
  expect(result.measured.filter(item => item.state === "alive")).toEqual([]);
  expect(result.elapsed).toBe(30);
});

test("persistent stable witness remains a failure after the unchanged polling budget", async () => {
  const result = await poll();
  expect(result.survivors).toEqual([]);
  expect(result.measured.filter(item => item.state === "alive").map(item => item.pid)).toEqual([42]);
  expect(result.elapsed).toBe(4500);
});

test("unknown stable witness query fails polling immediately", async () => {
  await expect(poll({ unknown: true })).rejects.toThrow("stable witness query unknown");
});

test("PID survivors still use the original budget without Windows witnesses", async () => {
  const result = await poll({ noWitness: true, pidSurvives: true });
  expect(result.survivors).toEqual([42]);
  expect(result.elapsed).toBe(4500);
});
