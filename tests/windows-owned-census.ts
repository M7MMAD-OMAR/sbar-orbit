import { captureProcessWitnesses, WitnessCaptureError, type WitnessApi, type WitnessIdentity } from "./windows-process-witness";

export type CensusRow = { pid: number; parentPid: number; image: string };
export type CensusScanner = (observe: (row: CensusRow) => void) => void | Promise<void>;

/** Retain witnesses when ownership becomes known, before the scanner completes. */
export async function captureOwnedCensus(root: number, api: WitnessApi, scan: CensusScanner) {
  const held = new Map<number, ReturnType<typeof captureProcessWitnesses>>();
  const parents = new Map<number, { parentPid: number; parentIdentity: WitnessIdentity }>();
  const rows = new Map<number, CensusRow>();
  const pendingCleanup = new Set<() => void>();
  let closed = false;
  const close = () => {
    const failures: unknown[] = [];
    for (const cleanup of pendingCleanup) {
      try { cleanup(); pendingCleanup.delete(cleanup); } catch (error) { failures.push(error); }
    }
    for (const [pid, witness] of held) {
      try { witness.close(); held.delete(pid); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Owned census cleanup failed");
    closed = true;
  };
  const retain = (pid: number) => {
    try {
      const witness = captureProcessWitnesses([pid], api);
      held.set(pid, witness);
      const identity = witness.observe()[0];
      if (!identity) throw new Error("Owned census identity is unmeasured");
      return identity;
    } catch (error) {
      // Failed CloseHandle stays owned by its original retryable closure.
      if (error instanceof WitnessCaptureError) {
        held.set(pid, { close: error.close, observe: () => { throw error; } });
      }
      throw error;
    }
  };
  const expand = () => {
    // Snapshot ordering need not put a parent before its children.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (held.has(row.pid) || !held.has(row.parentPid)) continue;
        if (held.size >= 513) throw new Error("Owned census exceeds its evidence bound");
        const parent = held.get(row.parentPid)?.observe()[0];
        if (!parent) throw new Error("Owned parent creation identity is unmeasured");
        const child = retain(row.pid);
        if (child.image.toLowerCase() !== row.image.toLowerCase()
          || BigInt(child.creationTicks) < BigInt(parent.creationTicks))
          throw new Error("Owned census creation or image identity changed");
        parents.set(row.pid, { parentPid: row.parentPid,
          parentIdentity: { creationTicks: parent.creationTicks, image: parent.image } });
        changed = true;
      }
    }
  };
  try {
    if (retain(root).state !== "alive") throw new Error("Owned census root is not alive");
    await scan(row => {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid)
        || row.parentPid < 0 || !row.image) throw new Error("Process census row is invalid");
      if (rows.has(row.pid)) throw new Error("Process census PID identity is ambiguous");
      if (rows.size >= 65536) throw new Error("Process census table exceeds its evidence bound");
      rows.set(row.pid, row);
      expand();
    });
    return { close, pids: [...parents.keys()], observe: () => {
      if (closed) throw new Error("Owned census witnesses are closed");
      return [...parents].map(([pid, parent]) => {
        const identity = held.get(pid)?.observe()[0];
        if (!identity) throw new Error("Owned census witness is unmeasured");
        return { ...identity, ...parent };
      });
    } };
  } catch (error) {
    if (error instanceof WitnessCaptureError && ![...held.values()].some(witness => witness.close === error.close))
      pendingCleanup.add(error.close);
    try { close(); } catch (cleanup) { throw new WitnessCaptureError(error, cleanup, close); }
    throw error;
  }
}
