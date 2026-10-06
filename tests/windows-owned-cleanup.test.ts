import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { confirmedWindowsStop, type StopEvidence } from "../src/owned-cleanup";

const { WindowsJob } = await import(process.env.ORBIT_WINDOWS_JOB_SOURCE || "../src/windows-job");

function fixture() {
  let now = 0, code: number | null = null, members: number[] = [], closed = false;
  const evidence: StopEvidence = { rootExitCode: null, confirmed: false, handleClosed: false };
  const job = { terminate() {}, processIds: () => members, close() { closed = true; } };
  return { job, evidence, get closed() { return closed; }, root: { exitCode: () => code },
    confirm() { code = 1; members = []; }, descendants() { code = 1; members = [123]; },
    clock: () => now, sleep: async (ms: number) => { now += ms; } };
}

async function stopFor(box: ReturnType<typeof fixture>) {
  const baseline = process.env.ORBIT_WINDOWS_STOP_SOURCE;
  if (!baseline) return confirmedWindowsStop(box.job, box.root, box.evidence, box.clock, box.sleep);
  // Run the original method itself against the same owned-only mock dependencies.
  const source = await readFile(baseline, "utf8");
  const windows = source.slice(source.indexOf("async function launchOnWindows"));
  const body = /    async stop\(\) \{([\s\S]*?)\n    \},\n    async assertContained/.exec(windows)?.[1];
  if (!body?.includes("Promise.race([child.exited")) throw new Error("Original Windows stop method was not found");
  return new Function("job", "child", "Bun", `let stopped = false; return async () => {${body}}`)(box.job,
    { exited: new Promise(() => {}) }, { sleep: async () => {} }) as () => Promise<void>;
}

test("owned job CloseHandle failure retains its handle for retry", () => {
  let success = false, calls = 0;
  const job = Object.create(WindowsJob.prototype) as InstanceType<typeof WindowsJob>;
  Object.assign(job, { api: { CloseHandle() { calls++; return success; }, GetLastError: () => 5 }, handle: 123,
    closed: false, accounting: () => ({ activeProcesses: 0 }) });
  expect(() => job.close()).toThrow("CloseHandle");
  expect((job as unknown as { closed: boolean }).closed).toBe(false);
  success = true;
  job.close();
  expect(calls).toBe(2);
  expect((job as unknown as { closed: boolean }).closed).toBe(true);
});

test("unobserved root exit retains the job and permits confirmed cleanup retry", async () => {
  const box = fixture(), stop = await stopFor(box);
  await expect(stop()).rejects.toThrow("exit is unconfirmed");
  expect(box.closed).toBe(false);
  box.confirm();
  await stop();
  expect(box.closed).toBe(true);
});

test("root exit alone cannot release a job with owned descendants", async () => {
  const box = fixture(); box.descendants();
  const stop = await stopFor(box);
  await expect(stop()).rejects.toThrow("exit is unconfirmed");
  expect(box.closed).toBe(false);
  box.confirm(); await stop();
  expect(box.closed).toBe(true);
});

test("membership query failure is uncertainty, never an empty job", async () => {
  const box = fixture(); box.confirm();
  box.job.processIds = () => { throw new Error("fixture membership unavailable"); };
  const stop = await stopFor(box);
  await expect(stop()).rejects.toThrow("membership unavailable");
  expect(box.closed).toBe(false);
});

test("late observations cannot claim cleanup confirmation after the deadline", async () => {
  const box = fixture(); box.confirm();
  const clock = box.clock;
  let delayed = false;
  box.clock = () => clock() + (delayed ? 4001 : 0);
  box.job.processIds = () => { delayed = true; return []; };
  const stop = await stopFor(box);
  await expect(stop()).rejects.toThrow("exit is unconfirmed");
  expect(box.closed).toBe(false);
});

test("job handle close failure does not poison a confirmed stop retry", async () => {
  const box = fixture(); box.confirm();
  const finish = box.job.close;
  let calls = 0;
  box.job.close = () => { if (++calls === 1) throw new Error("fixture handle close failed"); finish(); };
  const stop = await stopFor(box);
  await expect(stop()).rejects.toThrow("handle close failed");
  expect(box.closed).toBe(false);
  await stop();
  expect(box.closed).toBe(true);
  expect(calls).toBe(2);
});
