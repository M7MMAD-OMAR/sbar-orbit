/**
 * The processes under one process, computed from a parent table rather than from a children file.
 *
 * Windows reports a process and its parent in one snapshot of `Win32_Process`, because asking per
 * process would race a tree that is still starting. A snapshot of that table can contain a cycle: a
 * pid is recycled while the snapshot is being taken, so two processes name each other as parent, and
 * a process can name itself. A walk that trusts the table then never terminates.
 *
 * Measured on the Windows runner on 20 September 2026: a recursive walk over one such snapshot threw
 * `RangeError: Maximum call stack size exceeded` and failed `browser-crash.test.ts`, whose subject is
 * reaping a browser tree and not the shape of the process table. The walk here is iterative and each
 * pid is visited once, so a cycle terminates and a deep tree does not exhaust the stack.
 *
 * Linux does not need this: `/proc/<pid>/task/<task>/children` lists children directly and the caller
 * guards it. The same fixed-point shape is already used in `experiments/platform-probe/windows.ts`.
 */
export function descendantsFromTable(lines: Iterable<string>, root: number): number[] {
  const parents = new Map<number, number[]>();
  for (const line of lines) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined || Number.isNaN(parent)) continue;
    parents.set(parent, [...(parents.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const stack: number[] = [root];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) break;
    for (const child of parents.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}