export function fixturePhases(kind: string, sink: (value: string) => void = console.error) {
  const started = performance.now();
  let calls = 0, emitted = 0;
  let finished = false;
  const pending = new Map<number, string>();
  const restore: (() => void)[] = [];
  const write = (value: object) => { try { sink(JSON.stringify(value)); } catch {} };
  const phase = (name: string, outcome: string) => {
    if (finished) return;
    if (emitted++ < 128) write({ fixturePhase: kind, name, outcome, elapsedMs: Math.round(performance.now() - started) });
  };
  const observe = <T>(name: string, operation: Promise<T>, resolved?: (value: T) => void): Promise<T> => {
    if (finished) return operation;
    const call = ++calls;
    pending.set(call, name); phase(`${call}:${name}`, "start");
    void operation.then(value => {
      pending.delete(call); phase(`${call}:${name}`, "done");
      if (!finished) { try { resolved?.(value); } catch {} }
    }, () => { pending.delete(call); phase(`${call}:${name}`, "failed"); });
    return operation;
  };
  const method = (target: object, key: string, name: string, resolved?: (value: unknown) => void) => {
    if (finished) return false;
    try {
      const methods = target as Record<string, unknown>;
      const original = methods[key];
      if (typeof original !== "function") { phase(name, "unavailable"); return false; }
      const wrapped = function(this: unknown, ...args: unknown[]) {
        try {
          const result: unknown = Reflect.apply(original, this, args);
          if (result instanceof Promise) observe(name, result, resolved);
          else phase(name, "done");
          return result;
        } catch (error) { phase(name, "failed"); throw error; }
      };
      methods[key] = wrapped;
      restore.push(() => { if (methods[key] === wrapped) methods[key] = original; });
      return true;
    } catch { phase(name, "unavailable"); return false; }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    write({ fixturePhase: kind, name: "finally", elapsedMs: Math.round(performance.now() - started),
      pending: [...pending].slice(0, 16).map(([call, name]) => ({ call, name })), pendingCount: pending.size, emitted });
    for (const undo of restore.reverse()) { try { undo(); } catch {} }
  };
  return { phase, observe, method, finish };
}
