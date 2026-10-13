import { expect, test } from "bun:test";
import { snapshotArguments, snapshotIoctl } from "../src/snapshot-ioctl";
import { createReadOnlySnapshot } from "../src/snapshot";

test("read only ioctl has the installed Linux ABI and independent buffers", () => {
  const first = snapshotArguments(31, "000001-read");
  const second = snapshotArguments(42, "000002-resize");
  const view = new DataView(first.buffer);
  expect(first.length).toBe(4096);
  expect(snapshotIoctl).toBe(0x50009417);
  expect(view.getBigInt64(0, true)).toBe(31n);
  expect(view.getBigUint64(16, true)).toBe(2n);
  expect([...first.subarray(24, 56)]).toEqual(Array(32).fill(0));
  expect(new TextDecoder().decode(first.subarray(56, 68))).toBe("000001-read\0");
  expect(new DataView(second.buffer).getBigInt64(0, true)).toBe(42n);
  first.fill(0);
  expect(new DataView(second.buffer).getBigInt64(0, true)).toBe(42n);
});

test("snapshot names cannot select an arbitrary path or truncate into another name", () => {
  for (const name of ["", ".", "..", "../other", "bad\0name", "x".repeat(256), "é".repeat(128)])
    expect(() => snapshotArguments(3, name)).toThrow();
  expect(() => snapshotArguments(-1, "point")).toThrow();
});

test("compatibility fallback runs only before ioctl admission", async () => {
  let fallbacks = 0;
  const fallback = async () => { fallbacks++; return true; };
  expect(await createReadOnlySnapshot("/profile", "/store", "point", fallback,
    async () => ({ status: "unavailable", reason: "unsupported" }))).toBe(true);
  expect(fallbacks).toBe(1);
  for (const errno of [4, 17, 28, 122, 13, 5]) {
    expect(await createReadOnlySnapshot("/profile", "/store", "point", fallback,
      async () => ({ status: "failed", phase: "ioctl", errno, reason: "refused" }))).toBe(false);
  }
  expect(await createReadOnlySnapshot("/profile", "/store", "point", fallback,
    async () => ({ status: "failed", phase: "worker", reason: "reply lost" }))).toBe(false);
  expect(await createReadOnlySnapshot("/profile", "/store", "point", fallback,
    async () => ({ status: "created" }))).toBe(true);
  expect(fallbacks).toBe(1);
});
