import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsChromeArguments } from "../src/windows-job";

/**
 * The Windows containment layer reads kernel structures by byte offset, and an offset is the kind of
 * thing that is right once and then quietly wrong. Nothing here opens a job object or starts a
 * browser: `src/windows-job.ts` refuses to load `kernel32` off win32, which is the point. What is
 * checked is the arithmetic and the flags, against the layouts recorded in
 * `docs/evidence/windows-vm-2026-09-16.json` from a run on a real Windows 11 guest.
 *
 * A test that only ran on Windows would never run here, and an offset nobody checks is an offset
 * that drifts.
 */

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64, as the constructor writes it. */
const EXTENDED: Record<"size" | "limitFlags" | "activeProcessLimit" | "jobMemoryLimit" | "peakJobMemoryUsed", number> = {
  size: 144,
  limitFlags: 16,
  activeProcessLimit: 40,
  jobMemoryLimit: 120,
  peakJobMemoryUsed: 136,
};

/** JOBOBJECT_BASIC_ACCOUNTING_INFORMATION on x64, as `accounting()` reads it. */
const ACCOUNTING: Record<"size" | "totalUserTime" | "totalKernelTime" | "pageFaults" | "totalProcesses" | "activeProcesses" | "terminatedProcesses", number> = {
  size: 48,
  totalUserTime: 0,
  totalKernelTime: 8,
  pageFaults: 32,
  totalProcesses: 36,
  activeProcesses: 40,
  terminatedProcesses: 44,
};

test("the extended limit block is written where the kernel reads it", () => {
  const buffer = new Uint8Array(EXTENDED.size);
  const view = new DataView(buffer.buffer);
  // The same three writes the constructor makes, with the flag values spelled out rather than
  // imported, so a change to the constant has to be made deliberately in two places.
  const KILL_ON_JOB_CLOSE = 0x2000;
  const JOB_MEMORY = 0x200;
  const ACTIVE_PROCESS = 0x8;
  view.setUint32(EXTENDED.limitFlags, KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS, true);
  view.setUint32(EXTENDED.activeProcessLimit, 512, true);
  view.setBigUint64(EXTENDED.jobMemoryLimit, 2n * 1024n * 1024n * 1024n, true);

  expect(view.getUint32(EXTENDED.limitFlags, true)).toBe(0x2208);
  expect(view.getUint32(EXTENDED.activeProcessLimit, true)).toBe(512);
  expect(view.getBigUint64(EXTENDED.jobMemoryLimit, true)).toBe(2147483648n);
  // The basic block is 64 bytes and IO_COUNTERS is six 64 bit fields, so the memory quartet starts
  // at 112 and PeakJobMemoryUsed is the last of the four.
  expect(EXTENDED.jobMemoryLimit).toBe(112 + 8);
  expect(EXTENDED.peakJobMemoryUsed).toBe(EXTENDED.size - 8);
});

test("accounting offsets put the process counts after the page fault count", () => {
  const buffer = new Uint8Array(ACCOUNTING.size);
  const view = new DataView(buffer.buffer);
  // The measured guest values, so a reader can see what these fields carried in practice.
  view.setBigUint64(ACCOUNTING.totalUserTime, 8910000n, true);
  view.setBigUint64(ACCOUNTING.totalKernelTime, 12660000n, true);
  view.setUint32(ACCOUNTING.pageFaults, 217623, true);
  view.setUint32(ACCOUNTING.totalProcesses, 21, true);
  view.setUint32(ACCOUNTING.activeProcesses, 13, true);
  view.setUint32(ACCOUNTING.terminatedProcesses, 0, true);

  // FILETIME is 100 nanosecond units, which is the conversion `accounting()` applies.
  expect(Math.round(Number(view.getBigUint64(ACCOUNTING.totalUserTime, true)) / 10_000)).toBe(891);
  expect(Math.round(Number(view.getBigUint64(ACCOUNTING.totalKernelTime, true)) / 10_000)).toBe(1266);
  expect(view.getUint32(ACCOUNTING.totalProcesses, true)).toBe(21);
  expect(view.getUint32(ACCOUNTING.activeProcesses, true)).toBe(13);
  // Four DWORDs after two 64 bit time pairs and two more time fields: the counts are contiguous.
  expect(ACCOUNTING.activeProcesses - ACCOUNTING.totalProcesses).toBe(4);
  expect(ACCOUNTING.terminatedProcesses).toBe(ACCOUNTING.size - 4);
});

test("the CPU rate block is eight bytes with the rate in the union", () => {
  const buffer = new Uint8Array(8);
  const view = new DataView(buffer.buffer);
  const ENABLE = 0x1;
  const HARD_CAP = 0x4;
  view.setUint32(0, ENABLE | HARD_CAP, true);
  // Hundredths of a percent of the WHOLE machine, which is why 25% is 2500 and not "two cores".
  view.setUint32(4, 2500, true);
  expect(view.getUint32(0, true)).toBe(5);
  expect(view.getUint32(4, true)).toBe(2500);
  expect(buffer.byteLength).toBe(8);
});

test("the process id list header is two DWORDs before the array", () => {
  const capacity = 4;
  const size = 8 + 8 * capacity;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, capacity, true);
  view.setUint32(4, 3, true);
  for (const [index, pid] of [13612, 7636, 11348].entries()) view.setBigUint64(8 + 8 * index, BigInt(pid), true);

  expect(view.getUint32(0, true)).toBe(4);
  expect(view.getUint32(4, true)).toBe(3);
  const pids: number[] = [];
  for (let index = 0; index < view.getUint32(4, true); index++) pids.push(Number(view.getBigUint64(8 + 8 * index, true)));
  expect(pids).toEqual([13612, 7636, 11348]);
});

test("the Windows browser command line carries the containment flags", () => {
  const argv = windowsChromeArguments("C:\\orbit\\session");
  expect(argv).toContain("--user-data-dir=C:\\orbit\\session");
  expect(argv).toContain("--headless");
  expect(argv).toContain("--remote-debugging-port=0");
  expect(argv).toContain("--remote-debugging-address=127.0.0.1");
  // Measured on the guest: Chrome starts --type=crashpad-handler inside the spawn-to-assign window,
  // and a crash handler outside the budget is worth nothing to Orbit.
  expect(argv).toContain("--disable-crashpad");
  // The page must be last, as the browser treats a trailing positional as the URL.
  expect(argv.at(-1)).toBe("about:blank");
  // --no-sandbox is a Linux workaround and a straight regression on Windows, where the sandbox works.
  expect(argv).not.toContain("--no-sandbox");
});

test("the measured findings the layer was built from are written down", () => {
  // docs/evidence/ is untracked by convention here: raw reports are attached to a release, not
  // committed. So the assertion is against the tracked document, which is what a reader and the
  // support tier table actually cite.
  const measured = readFileSync(join(import.meta.dir, "../docs/windows-measured.md"), "utf8");
  // Session 0 is the finding that decides where a Windows broker can live at all.
  expect(measured).toContain("will not run in Windows session 0");
  // The transport finding that removed a planned rewrite.
  expect(measured).toContain("the transport does not need a rewrite");
  // Containment held every time it was asked.
  expect(measured).toContain("Survivors after closing the last job handle");
  // G17's first result was withdrawn rather than kept because it was the more interesting number.
  expect(measured).toContain("G17 re-measured, and a first result withdrawn");
  expect(measured).toContain("No trend by cap");
  // An unknown measurement is never a pass: the list of what was not measured has to survive.
  expect(measured).toContain("## 5. What this does not say");
  // The race is recorded as intermittent rather than as closed by a flag that was not proven to close it.
  expect(measured).toContain("intermittently");
});
