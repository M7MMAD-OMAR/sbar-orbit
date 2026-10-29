/**
 * Who is calling the broker.
 *
 * Orbit's contract is cooperative control by one user, not a sandbox, so this is not authentication.
 * It exists so that two agents sharing one broker cannot step on each other by accident, and so that
 * every refusal can name who holds what. The broker believes a caller only as far as it can check:
 *
 * - The claim names a process id and that process's start time. The broker confirms the process
 *   exists, belongs to the broker's own user and started when the claim says. This is a verified claim
 *   rather than kernel peer credentials: Bun's Unix server does not expose SO_PEERCRED, so a process
 *   that lies about someone else's live pid and start time is not caught. Cooperating agents do not.
 * - The caller id is the conversation id when the host sets ORBIT_CONVERSATION_ID, so a restarted
 *   adapter of one conversation keeps what that conversation owns. Without it the id is the adapter
 *   process, which is what the lifecycle watches.
 * - The owner role is the person: the panel and the owner CLI present the owner credential file.
 *   An adapter never reads it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";

export type CallerKind = "adapter" | "cli" | "client";
export type CallerRole = "owner" | "agent";

export interface CallerClaim { v: 1; kind: CallerKind; pid: number; start?: string; conversationId?: string; host?: string }
export interface Caller {
  id: string; label: string; role: CallerRole; kind: CallerKind | "internal" | "unidentified";
  verified: boolean; pid?: number; start?: string;
}

/** In-process callers (tests, the broker itself) carry the owner's authority. */
export const internalCaller: Caller = { id: "internal", label: "the broker", role: "owner", kind: "internal", verified: true };
/** A request that presented nothing the broker could check, such as an older adapter or a raw socket client. */
export const unidentifiedCaller: Caller = { id: "unidentified", label: "unidentified client", role: "agent", kind: "unidentified", verified: false };

export const callerHeader = "x-orbit-caller";
export const ownerHeader = "x-orbit-owner";

/** Start time of a process in clock ticks since boot (field 22 of /proc/PID/stat), where /proc exists. */
export function processStart(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may hold spaces, so count from its closing one.
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch { return undefined; }
}
function processOwner(pid: number): number | undefined {
  try { return statSync(`/proc/${pid}`).uid; } catch { return undefined; }
}
export function processAlive(pid: number, start?: string): boolean {
  try { process.kill(pid, 0); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) return false; }
  if (start !== undefined) {
    const current = processStart(pid);
    if (current !== undefined && current !== start) return false;
  }
  return true;
}

export function hostName(env: Record<string, string | undefined> = process.env): string {
  if (env.ORBIT_CALLER_LABEL?.trim()) return env.ORBIT_CALLER_LABEL.trim().slice(0, 40);
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude";
  if (env.CODEX_THREAD_ID || env.CODEX_HOME || env.CODEX_SANDBOX) return "Codex";
  if (env.HERMES_SESSION_ID || env.HERMES_HOME) return "Hermes";
  return "Agent";
}

/** What this process says about itself on every request. */
export function localClaim(kind: CallerKind, env: Record<string, string | undefined> = process.env, pid = process.pid): CallerClaim {
  const conversation = env.ORBIT_CONVERSATION_ID?.trim();
  return { v: 1, kind, pid, start: processStart(pid),
    ...(conversation && conversation.length <= 256 && !/[\x00-\x1f\x7f]/.test(conversation) ? { conversationId: conversation } : {}),
    host: hostName(env) };
}
export function encodeClaim(claim: CallerClaim): string { return Buffer.from(JSON.stringify(claim)).toString("base64url"); }

export interface ProcessProbe { start(pid: number): string | undefined; owner(pid: number): number | undefined; alive(pid: number, start?: string): boolean }
export const realProbe: ProcessProbe = { start: processStart, owner: processOwner, alive: processAlive };

function suffix(id: string) { return createHash("sha256").update(id).digest("hex").slice(0, 4); }

/**
 * The broker's reading of a request. A header that is missing, malformed or fails the process check
 * yields the shared unidentified caller, never the owner.
 */
export function resolveCaller(header: string | null | undefined, probe: ProcessProbe = realProbe, brokerUid = process.getuid?.()): Caller {
  if (!header || header.length > 2048) return unidentifiedCaller;
  let claim: CallerClaim;
  try {
    const value = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Partial<CallerClaim>;
    if (!value || value.v !== 1 || !["adapter", "cli", "client"].includes(String(value.kind))
        || !Number.isInteger(value.pid) || (value.pid as number) < 2) return unidentifiedCaller;
    if (value.start !== undefined && (typeof value.start !== "string" || !/^\d{1,20}$/.test(value.start))) return unidentifiedCaller;
    if (value.conversationId !== undefined && (typeof value.conversationId !== "string" || !value.conversationId.trim()
        || value.conversationId.length > 256 || /[\x00-\x1f\x7f]/.test(value.conversationId))) return unidentifiedCaller;
    claim = value as CallerClaim;
  } catch { return unidentifiedCaller; }
  const actual = probe.start(claim.pid);
  const owner = probe.owner(claim.pid);
  if (!probe.alive(claim.pid, claim.start)) return unidentifiedCaller;
  if (owner !== undefined && brokerUid !== undefined && owner !== brokerUid) return unidentifiedCaller;
  if (claim.start !== undefined && actual !== undefined && actual !== claim.start) return unidentifiedCaller;
  const id = claim.conversationId ? `conv:${claim.conversationId}` : `proc:${claim.pid}:${claim.start ?? "0"}`;
  const host = typeof claim.host === "string" && claim.host.trim() && !/[\x00-\x1f\x7f]/.test(claim.host) ? claim.host.trim().slice(0, 40) : "Agent";
  return { id, label: `${host} (${suffix(id)})`, role: "agent", kind: claim.kind, verified: true, pid: claim.pid, start: claim.start };
}

/** The owner credential sits next to the socket, readable by the owner alone. */
export function ownerCredentialPath(socket: string) { return `${socket}.owner`; }

export async function createOwnerCredential(socket: string): Promise<string> {
  const path = ownerCredentialPath(socket);
  const token = randomBytes(32).toString("hex");
  await rm(path, { force: true });
  await writeFile(path, token + "\n", { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return token;
}
export async function removeOwnerCredential(socket: string) { await rm(ownerCredentialPath(socket), { force: true }); }

/** Refuses a credential file another user could read, rather than presenting it. */
export function readOwnerCredential(socket: string): string | undefined {
  try {
    const path = ownerCredentialPath(socket);
    const info = statSync(path);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return undefined;
    const token = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  } catch { return undefined; }
}

export function ownerTokenMatches(presented: string | null | undefined, expected: string | undefined): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** What a client sends: its own claim, and the owner credential only when the caller asked to be the owner. */
export interface ClientIdentity { claim: CallerClaim; ownerToken?: string }
let configured: { kind: CallerKind; owner: boolean } = { kind: "client", owner: false };
/** Called once by an entry point. The adapters pass kind adapter and never owner. */
export function configureCaller(options: { kind: CallerKind; owner?: boolean }) { configured = { kind: options.kind, owner: options.owner === true }; }
export function clientIdentity(socket: string, override?: ClientIdentity): ClientIdentity {
  if (override) return override;
  const claim = localClaim(configured.kind);
  const ownerToken = configured.owner && configured.kind !== "adapter" ? readOwnerCredential(socket) : undefined;
  return { claim, ...(ownerToken ? { ownerToken } : {}) };
}
export function identityHeaders(identity: ClientIdentity): Record<string, string> {
  return { [callerHeader]: encodeClaim(identity.claim), ...(identity.ownerToken ? { [ownerHeader]: identity.ownerToken } : {}) };
}
