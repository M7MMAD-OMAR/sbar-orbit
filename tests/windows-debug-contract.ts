export type DebugIdentity = { creationTicks: string; image: string };
export const observationRights = 0x00101000;
export const creatorRootRights = observationRights | 0x0100 | 0x0001;
export function debugDuplicateRights(purpose: "observation" | "creator-root") {
  return purpose === "creator-root" ? creatorRootRights : observationRights;
}
export type RootHandoff = { session: string; role: "creator-root"; handle: number; pid: number; rights: number; killPolicyFalse: boolean };
export function rootHandoffOwner(session: string, register: (handle: number) => void) {
  let held: RootHandoff | undefined;
  return {
    adopt(row: RootHandoff) {
      if (row.session !== session || row.role !== "creator-root" || row.rights !== creatorRootRights || row.killPolicyFalse !== true ||
        !Number.isSafeInteger(row.handle) || row.handle <= 0 || !Number.isSafeInteger(row.pid) || row.pid <= 0)
        throw new Error("Creator root handoff is unverified");
      if (held && (held.handle !== row.handle || held.pid !== row.pid)) throw new Error("Creator root ownership conflict");
      if (!held) { held = Object.freeze({ ...row }); register(row.handle); }
      return held;
    },
    held: () => held,
  };
}
export function helperDeathAuthority(rootAdopted: boolean, abortRootSafe: boolean) {
  return rootAdopted || abortRootSafe;
}
export function abortRootSafety(creationAttempted: boolean, creatorExitConfirmed: boolean, controllerAdopted: boolean) {
  if (creatorExitConfirmed) return "exact creator root exited";
  if (controllerAdopted) return "controller owns exact root";
  if (!creationAttempted) return "root creation never started";
  return "unknown";
}
export type DebugRecord = {
  sequence: number; pid: number; handle: number; identity: DebugIdentity;
  session: string; root: DebugIdentity; jobMember: boolean;
  immediateParent: "not measured"; provenance: "creator-debug-chain";
};

export function admitDebugRecord(record: DebugRecord, session: string, root: DebugIdentity) {
  if (record.session !== session || record.provenance !== "creator-debug-chain" || !record.jobMember ||
    record.root.creationTicks !== root.creationTicks || record.root.image !== root.image ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isSafeInteger(record.handle) || record.handle <= 0 ||
    !Number.isSafeInteger(record.sequence) || record.sequence < 0 ||
    !/^\d+$/.test(record.identity.creationTicks) || BigInt(record.identity.creationTicks) < BigInt(root.creationTicks))
    throw new Error("Debug-chain admission is unknown or contradictory");
  return Object.freeze({ ...record, identity: Object.freeze({ ...record.identity }) });
}

export function continuation(code: number, exceptionCode: number, firstChance: boolean, initialBreakpoint: boolean) {
  if (code !== 1) return 0x00010002;
  // Only an identified initial first-chance loader breakpoint is consumed.
  if (initialBreakpoint && firstChance && exceptionCode === 0x80000003) return 0x00010002;
  return 0x80010001;
}

export function duplicateOwner(close: (handle: number) => void) {
  const held = new Set<number>();
  return {
    add(handle: number) {
      if (held.has(handle)) throw new Error("Duplicate handle ownership conflict");
      held.add(handle);
    },
    close() {
      const failures: unknown[] = [];
      for (const handle of held) {
        try { close(handle); held.delete(handle); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Owned duplicate cleanup remains retryable");
    },
    outstanding: () => [...held],
  };
}

export function requireCoverage(state: { chainSplit: boolean; missingAcknowledgement: boolean; deadlineExpired: boolean; allExited: boolean }) {
  if (state.chainSplit || state.missingAcknowledgement || state.deadlineExpired || !state.allExited)
    throw new Error("Full descendant coverage is not measured");
}

export type TransferRow = { sequence: number; handle: number; pid: number };
export type TransferSeal = { session: string; nextSequence: number; noFurtherTransfers: true; inventory: TransferRow[] };
export function transferBarrier(session: string) {
  const inventory: TransferRow[] = [];
  let pending: TransferRow | "acquiring" | undefined, sealed = false;
  return {
    begin() {
      if (sealed || pending !== undefined || inventory.length >= 2) throw new Error("Controlled transfer admission closed or inflight");
      pending = "acquiring";
    },
    delivered(row: TransferRow) {
      if (pending !== "acquiring" || row.sequence !== inventory.length || !Number.isSafeInteger(row.handle) || row.handle <= 0 ||
        !Number.isSafeInteger(row.pid) || row.pid <= 0) throw new Error("Controlled transfer delivery unknown");
      pending = { ...row };
    },
    acknowledged() {
      if (!pending || pending === "acquiring") throw new Error("Transfer acknowledgement missing delivery");
      inventory.push(pending); pending = undefined;
    },
    seal(requestSession: string): TransferSeal {
      if (requestSession !== session || pending !== undefined || inventory.length !== 2) throw new Error("Transfer seal incomplete or inflight");
      sealed = true;
      return { session, nextSequence: 2, noFurtherTransfers: true, inventory: inventory.map(row => ({ ...row })) };
    },
  };
}
export function validateTransferSeal(seal: TransferSeal, session: string, records: TransferRow[]) {
  if (seal.session !== session || seal.nextSequence !== 2 || seal.noFurtherTransfers !== true ||
    !Array.isArray(seal.inventory) || seal.inventory.length !== 2 || records.length !== 2 ||
    seal.inventory.some((row, index) => row.sequence !== index || row.sequence !== records[index]?.sequence ||
      row.handle !== records[index]?.handle || row.pid !== records[index]?.pid)) throw new Error("Exact transfer seal not measured");
  return seal;
}
