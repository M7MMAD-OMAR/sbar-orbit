/** An in-process capability, never discovered from PATH or ambient display variables.
 * The fixture owner must supply actual private compositor observations. This admission
 * authenticates object identity and lifetime inside this process, not OS ownership.
 */
import { isAbsolute, join, resolve } from "node:path";

export type ExperimentIdentity = Readonly<{
  root: string;
  profiles: readonly string[];
  contexts: readonly object[];
  backends: readonly object[];
}>;
export type FocusSnapshot = Readonly<{ activePid: number; clientPids: readonly number[] }>;
export type ExperimentObserverFactory = (identity: ExperimentIdentity) => object;
type Lease = { identity: ExperimentIdentity; compositor: object; live: () => boolean;
  read: (signal: AbortSignal) => Promise<unknown>; closed: boolean; pending: boolean; admitted: boolean;
  controller?: AbortController };
const leases = new WeakMap<object, Lease>();
const isLive = (live: () => boolean) => { try { return live() === true; } catch { return false; } };

/** Called only by an explicit private fixture owner after creating its compositor.
 * Do not put ambient user signatures, display sockets or personal profiles in a lease.
 * No transport or subprocess is selected or started by this module.
 */
export function issueOwnedExperimentObserver(identity: ExperimentIdentity, compositor: object,
  live: () => boolean, read: (signal: AbortSignal) => Promise<unknown>) {
  if (!Object.isFrozen(identity) || !Object.isFrozen(identity.profiles) ||
      !Object.isFrozen(identity.contexts) || !Object.isFrozen(identity.backends) ||
      identity.profiles.length !== 2 || identity.contexts.length !== 2 || identity.backends.length !== 2 ||
      identity.profiles[0] === identity.profiles[1] || identity.contexts[0] === identity.contexts[1] ||
      identity.backends[0] === identity.backends[1] || !isAbsolute(identity.root) || resolve(identity.root) !== identity.root ||
      identity.profiles[0] !== join(identity.root, "a") || identity.profiles[1] !== join(identity.root, "b") ||
      ![...identity.contexts, ...identity.backends].every(value => typeof value === "object" && value !== null) ||
      typeof compositor !== "object" || compositor === null || !isLive(live)) {
    throw new Error("Owned experiment observer admission refused");
  }
  const capability = Object.freeze({});
  leases.set(capability, { identity, compositor, live, read, closed: false, pending: false, admitted: false });
  return capability;
}

export function admitExperimentObserver(identity: ExperimentIdentity, factory: ExperimentObserverFactory) {
  let capability: object;
  try { capability = factory(identity); } catch { throw new Error("Owned experiment observer admission refused"); }
  const lease = leases.get(capability);
  if (!lease || lease.identity !== identity || lease.closed || lease.admitted || !isLive(lease.live)) {
    throw new Error("Owned experiment observer admission refused");
  }
  lease.admitted = true;
  const validPid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return Object.freeze({
    async read(): Promise<FocusSnapshot> {
      if (lease.closed || !isLive(lease.live) || lease.pending) throw new Error("Owned experiment observer unavailable");
      lease.pending = true;
      const controller = new AbortController();
      lease.controller = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            lease.closed = true;
            controller.abort();
            reject(new Error("Owned experiment observer unavailable"));
          }, 1000);
        });
        const value: unknown = await Promise.race([lease.read(controller.signal), deadline]);
        if (lease.closed || !isLive(lease.live) || !value || typeof value !== "object") throw new Error("Owned experiment observer unavailable");
        const row = value as Record<string, unknown>;
        const activePid = row.activePid;
        const inputClients = row.clientPids;
        if (!validPid(activePid) || !Array.isArray(inputClients) || inputClients.length > 256) {
          throw new Error("Invalid owned experiment observation");
        }
        const clientPids: number[] = [];
        const length = inputClients.length;
        for (let index = 0; index < length; index++) {
          const clientPid: unknown = inputClients[index];
          if (!Object.hasOwn(inputClients, index) || !validPid(clientPid)) throw new Error("Invalid owned experiment observation");
          clientPids.push(clientPid as number);
        }
        return Object.freeze({ activePid: activePid as number, clientPids: Object.freeze(clientPids) });
      } catch {
        // Callback errors and arbitrary compositor data are never exposed in artifacts.
        throw new Error("Owned experiment observer unavailable");
      } finally { if (timer !== undefined) clearTimeout(timer); lease.pending = false; lease.controller = undefined; }
    },
    close() { lease.closed = true; lease.controller?.abort(); },
  });
}
