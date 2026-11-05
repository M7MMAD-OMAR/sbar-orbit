import { expect, test } from "bun:test";
import { allocateWorkspace, workspacePool } from "../src/arbitration";
import { OrbitError } from "../src/errors";

// Pure metadata selection only. No compositor calls, presentation or app launch.
function choose(used: number[] = [], shown: number[] = [], own: number[] = [], pool: [number,number] = workspacePool({})) {
  return allocateWorkspace({ pool, used: new Set(used), shown: new Set(shown), own });
}
function limit(used: number[], shown: number[], own: number[]) {
  let failure: unknown;
  try { choose(used, shown, own); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(OrbitError);
  expect(failure).toMatchObject({ code: "LIMIT_REACHED", message: "No empty, undisplayed workspace is available in the workspace pool" });
  expect(String(failure)).not.toContain("widen"); expect(String(failure)).not.toContain("stop a session");
}

test("automatic default pool is the first ten, not a hidden higher workspace range", () => {
  expect(workspacePool({})).toEqual([1,10]); expect(workspacePool({ORBIT_WORKSPACE_POOL:undefined})).toEqual([1,10]);
  expect(choose()).toBe(1);
});

test("configured automatic pool can narrow but cannot widen outside1..10", () => {
  for (const [value, expected] of [["1-10",[1,10]],["2-7",[2,7]],["1-1",[1,1]],["10-10",[10,10]]] as const)
    expect(workspacePool({ORBIT_WORKSPACE_POOL:value})).toEqual([...expected]);
  expect(choose([],[],[],workspacePool({ORBIT_WORKSPACE_POOL:"4-8"}))).toBe(4);
});

test("malformed or out-of-policy environment falls back within first ten", () => {
  for (const value of ["", "20-99", "1-11", "11-20", "0-10", "2-1", "01-10", "1-010", "-1-4", "1.5-8", "1-2-3", " 2-4", "2-4 ", "2-4\n", "2-4\r\n", "Infinity-10", "1-999999", "2"])
    expect(workspacePool({ORBIT_WORKSPACE_POOL:value})).toEqual([1,10]);
});

test("lowest candidate must be unused, undisplayed and not already reserved", () => {
  expect(choose([1,4],[2,7],[3,6])).toBe(5);
  expect(choose([1],[2],[])).toBe(3); // displayed owner workspace is never selected
  expect(choose([], [1], [])).toBe(2);
});

test("existing caller workspace is never preferred or reused for a new allocation", () => {
  expect(choose([4],[],[4])).toBe(1); // the old helper wrongly returned occupied own4
  expect(choose([],[],[1])).toBe(2); // reservation alone also excludes it
  expect(choose([1,2],[],[3,4])).toBe(5);
});

test("all ten occupied, displayed, reserved or mixed refuses without widening", () => {
  const ten=Array.from({length:10},(_,index)=>index+1);
  limit(ten,[],[]); limit([],ten,[]); limit([],[],ten);
  limit([2,4,6,8,10],[1,3,5,7],[9]);
});

test("only tenth free remains selectable but no eleventh candidate is automatic", () => {
  expect(choose([1,2,3,4,5],[6,7,8],[9])).toBe(10);
  limit([1,2,3,4,5],[6,7,8],[9,10]);
});

test("explicit internal injected pools retain compatibility without widening defaults", () => {
  expect(choose([30],[31],[],[30,32])).toBe(32);
  expect(workspacePool({ORBIT_WORKSPACE_POOL:"30-32"})).toEqual([1,10]);
});

test("selection does not mutate pool, occupancy sets or caller reservation order", () => {
  const pool:[number,number]=[1,10], own=[7,3,3], used=new Set([1,6]), shown=new Set([2,9]);
  expect(allocateWorkspace({pool,own,used,shown})).toBe(4);
  expect(pool).toEqual([1,10]);expect(own).toEqual([7,3,3]);expect([...used]).toEqual([1,6]);expect([...shown]).toEqual([2,9]);
});
