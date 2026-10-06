import { expect, test } from "bun:test";
import { observePromise, ReferenceRegistrations, sanitizedCaptureError } from "./capture-diagnostic";

test("diagnostic promise observer preserves the original promise and real settlement value", async () => {
  let resolve: ((value: symbol) => void) | undefined;
  const actual = new Promise<symbol>(done => { resolve = done; });
  const value = Symbol("bookkeeping control"), seen: symbol[] = [];
  expect(observePromise(actual, result => seen.push(result), () => {}, () => {})).toBe(actual);
  resolve?.(value);
  expect(await actual).toBe(value);
  expect(seen).toEqual([value]);
});

test("diagnostic rejection observer preserves the real rejected promise and error identity", async () => {
  const error = new Error("promise bookkeeping control"), actual = Promise.reject(error);
  let observed: unknown;
  expect(observePromise(actual, () => {}, value => { observed = value; }, () => {})).toBe(actual);
  await expect(actual).rejects.toBe(error);
  expect(observed).toBe(error);
});

test("diagnostic observer and failure callback cannot alter settlement or leak a rejection", async () => {
  const value = Symbol("observer control"), actual = Promise.resolve(value);
  let failed = 0;
  expect(observePromise(actual, () => { throw new Error("observer control"); }, () => {}, () => {
    failed++; throw new Error("failure callback control");
  })).toBe(actual);
  expect(await actual).toBe(value);
  expect(failed).toBe(1);
});

test("diagnostic registrations restore once after the final reference and permit fresh acquisition", () => {
  const refs = new ReferenceRegistrations<object>(), owner = {};
  let installed = 0, restored = 0;
  const install = () => { installed++; return () => { restored++; }; };
  const first = refs.acquire(owner, install), second = refs.acquire(owner, install);
  expect(installed).toBe(1); expect(refs.size).toBe(1);
  first(); first(); expect(restored).toBe(0);
  second(); second(); expect(restored).toBe(1); expect(refs.size).toBe(0);
  refs.acquire(owner, install)();
  expect(installed).toBe(2); expect(restored).toBe(2);
});

test("diagnostic registration of another owner cannot restore a live registration", () => {
  const refs = new ReferenceRegistrations<object>(), firstOwner = {}, secondOwner = {};
  let firstRestored = 0, secondRestored = 0;
  const first = refs.acquire(firstOwner, () => () => { firstRestored++; });
  const second = refs.acquire(secondOwner, () => () => { secondRestored++; });
  second(); expect(refs.size).toBe(1); expect(firstRestored).toBe(0); expect(secondRestored).toBe(1);
  first(); expect(refs.size).toBe(0); expect(firstRestored).toBe(1);
});

test("actual error metadata formatter retains code and budget while omitting arbitrary message text", () => {
  const arbitrary = sanitizedCaptureError({ code: "TIMEOUT", message: "/home/example/private-token ws://private.example/endpoint" });
  expect(arbitrary.code).toBe("TIMEOUT");
  for (const secret of ["/home/example", "private-token", "private.example", "endpoint"])
    expect(JSON.stringify(arbitrary)).not.toContain(secret);
  expect(arbitrary.messageSha256).toMatch(/^[a-f0-9]{64}$/);
  const timeout = sanitizedCaptureError({ code: "TIMEOUT", message: "The page did not produce a frame within 3000 ms (capturing pixels)." });
  expect(timeout.captureBudgetMs).toBe(3000);
  expect(timeout.messageCategory).toBe("capture timeout");
});
