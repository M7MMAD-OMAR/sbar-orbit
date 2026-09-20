/**
 * The parent table is not a tree on the Windows runner, and the walk over it must survive that.
 *
 * Measured on 20 September 2026: `browser-crash.test.ts` failed with `RangeError: Maximum call stack
 * size exceeded` at its recursive walk of a `Win32_Process` snapshot. The snapshot held a cycle, a pid
 * recycled into a parent of its own ancestor, and the walk followed it until the stack ended. These
 * cases pin the shape that a real table can have, on a platform where it can be run every time.
 */
import { test, expect } from "bun:test";
import { descendantsFromTable } from "../src/process-tree";

test("a table where two processes name each other ends at the cycle", () => {
  // What a recycled pid makes: 100 names 200 as its parent and 200 names 100. A recursive walk that
  // trusts the table never returns from this.
  const table = ["100 200", "200 100", "300 100"];
  expect(descendantsFromTable(table, 100).sort((a, b) => a - b)).toEqual([200, 300]);
});

test("a process that names itself as its own parent does not loop", () => {
  // A process is never its own ancestor, but the table can still say so, and following it is a loop
  // whose next step is the same pid.
  const table = ["100 100", "300 100"];
  expect(descendantsFromTable(table, 100)).toEqual([300]);
});

test("a root that is named as a descendant of itself is not listed twice", () => {
  const table = ["100 200", "200 300", "300 100"];
  const found = descendantsFromTable(table, 100);
  expect(found).not.toContain(100);
  expect(found.sort((a, b) => a - b)).toEqual([200, 300]);
});

test("the tree is still the tree when the table is well formed", () => {
  const table = ["2 1", "3 1", "4 2", "5 4", "6 3"];
  expect(descendantsFromTable(table, 1).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
});

test("a blank line or a line with one field is skipped rather than parsed", () => {
  // `Get-CimInstance` output is split on newlines, and a trailing newline makes an empty last line.
  // `Number("")` is 0, so an unguarded parse would invent pid 0 as a child of pid 0.
  const table = ["2 1", "", "   ", "4 2", "3"];
  expect(descendantsFromTable(table, 1).sort((a, b) => a - b)).toEqual([2, 4]);
});