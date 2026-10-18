import { expect, test } from "bun:test";
import { fixturePhases } from "./fixture-phases";

test("fixture diagnostics preserve receiver, arguments and original promise identity", async () => {
  const values: string[] = [];
  const trace = fixturePhases("control", value => values.push(value));
  const promise = Promise.resolve(7);
  const owner = { value: 4, run(input: number) { expect(this.value).toBe(4); expect(input).toBe(3); return promise; } };
  const original = owner.run;
  trace.method(owner, "run", "owned-operation");
  expect(owner.run(3)).toBe(promise); expect(await promise).toBe(7);
  trace.finish(); expect(owner.run).toBe(original);
  expect(values.some(value => JSON.parse(value).outcome === "done")).toBe(true);
});

test("fixture diagnostic sink failures preserve the original rejection", async () => {
  const trace = fixturePhases("control", () => { throw new Error("diagnostic sink refused"); });
  const failure = new Error("original operation refused");
  const promise = Promise.reject(failure);
  expect(trace.observe("owned-operation", promise)).toBe(promise);
  await expect(promise).rejects.toBe(failure);
  trace.finish();
});

test("fixture diagnostic output is bounded and retains unsettled operation identity", () => {
  const values: string[] = [];
  const trace = fixturePhases("control", value => values.push(value));
  trace.observe("held-operation", new Promise<void>(() => {}));
  for (let index = 0; index < 500; index++) trace.phase("fixed-boundary", "done");
  trace.finish();
  expect(values.length).toBe(129);
  const final = JSON.parse(values.at(-1) ?? "{}");
  expect(final.pendingCount).toBe(1);
  expect(final.pending).toEqual([{ call: 1, name: "held-operation" }]);
});

test("unavailable diagnostic boundaries do not throw and partial setup restores", () => {
  const values: string[] = [];
  const trace = fixturePhases("control", value => values.push(value));
  const owner = { run() { return Promise.resolve(1); } };
  const original = owner.run;
  try {
    expect(trace.method(owner, "run", "installed-operation")).toBe(true);
    expect(trace.method(owner, "missing", "unavailable-operation")).toBe(false);
    const broken = Object.defineProperty({}, "run", { get() { throw new Error("unavailable getter"); } });
    expect(trace.method(broken, "run", "unavailable-getter")).toBe(false);
  } finally { trace.finish(); }
  expect(owner.run).toBe(original);
  expect(values.filter(value => JSON.parse(value).outcome === "unavailable").length).toBe(2);
});

test("finished diagnostics refuse late resolved context registration", async () => {
  const trace = fixturePhases("control", () => {});
  let deliver: ((value: object) => void) | undefined;
  const held = new Promise<object>(resolve => { deliver = resolve; });
  const context = { run() { return Promise.resolve(1); } };
  const original = context.run;
  let registrations = 0;
  expect(trace.observe("held-create", held, value => {
    registrations++; trace.method(value, "run", "late-context");
  })).toBe(held);
  trace.finish();
  deliver?.(context);
  await held;
  expect(registrations).toBe(0);
  expect(trace.method(context, "run", "direct-after-finish")).toBe(false);
  expect(context.run).toBe(original);
});

test("fixture diagnostic finish is idempotent and restores only its own wrapper", () => {
  const values: string[] = [];
  const trace = fixturePhases("control", value => values.push(value));
  const owner = { run() { return Promise.resolve(1); } };
  trace.method(owner, "run", "owned-operation");
  const later = () => Promise.resolve(2);
  owner.run = later;
  trace.finish(); trace.finish();
  expect(owner.run).toBe(later);
  expect(values.filter(value => JSON.parse(value).name === "finally").length).toBe(1);
  const second = fixturePhases("control", () => {});
  const original = owner.run;
  second.method(owner, "run", "restored-operation");
  second.finish(); second.finish();
  expect(owner.run).toBe(original);
});
