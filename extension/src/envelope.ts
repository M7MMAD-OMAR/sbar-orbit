/**
 * The request and response envelope carried over native messaging.
 *
 * Both ends of this are hostile to each other in the sense that matters: the broker is a separate
 * program the extension did not start, and the extension runs in the person's browser where a page
 * cannot reach this port but the person's other extensions and anything that can write to the host
 * manifest directory can. So both directions are parsed rather than trusted, and every refusal is a
 * code rather than a thrown string, because the broker has to be able to tell "you asked for an
 * origin I do not have" apart from "the host is not installed" without reading prose.
 */

import { MAX_TTL_MS, ttlAcceptable, type GrantWindow } from "./grant";
import { canonicalOrigin, type MintedCookie } from "./origins";

export const PROTOCOL_VERSION = 1;

export const refusalCodes = [
  /** Not an object, wrong shape, or not JSON at all. */
  "MALFORMED_ENVELOPE",
  /** A version this side does not speak. Never negotiated down: a mismatch is a refusal. */
  "UNSUPPORTED_VERSION",
  /** Longer than the framing cap. */
  "FRAME_TOO_LARGE",
  /** The origin is not in the set the person allowed this extension to mint for. */
  "ORIGIN_NOT_ALLOWED",
  /** Allowed by the person, but the browser has not granted the host permission for it yet. */
  "ORIGIN_NOT_GRANTED",
  /** Outside the lifetime a mint is permitted to have. */
  "TTL_OUT_OF_RANGE",
  /** The grant being presented has already run out. */
  "GRANT_EXPIRED",
  /**
   * A mint arrived with nobody at the keyboard. Gate G13 asks which wake paths into a stopped MV3
   * service worker put something on the person's screen, and it is open and untested: nobody has
   * attempted any of them, because attempting them means loading this in a real browser. So the
   * design takes the fallback the gate itself names in advance, person initiated mint, and a
   * request with nobody present is refused rather than turned into a surface nobody asked for.
   */
  "NO_PENDING_REQUEST",
  /** `chrome.runtime.connectNative` found no host, so there is nothing to hand a grant to. */
  "HOST_ABSENT",
  /** The origin was allowed, granted and live, and the browser returned no cookies for it. */
  "NOTHING_TO_MINT",
] as const;

export type RefusalCode = (typeof refusalCodes)[number];

export type MintRequest = {
  v: number;
  /** Echoed on the response so a caller with several in flight can tell them apart. */
  id: string;
  kind: "mint";
  /** Canonical, as `canonicalOrigin` returns it. */
  origin: string;
  ttlMs: number;
  /** Which Orbit session the grant is for, carried through for the journal rather than checked. */
  sessionId?: string;
};

export type MintGrant = GrantWindow & {
  origin: string;
  cookies: MintedCookie[];
};

export type MintResponse =
  | { v: number; id: string; ok: true; grant: MintGrant }
  | { v: number; id: string; ok: false; refusal: RefusalCode; detail: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: RefusalCode; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An id is an opaque label, so it is length bounded and otherwise not interpreted. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function parseMintRequest(value: unknown): Parsed<MintRequest> {
  if (!isRecord(value)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Request is not an object" };
  if (value.v !== PROTOCOL_VERSION) return { ok: false, code: "UNSUPPORTED_VERSION", detail: `Expected version ${PROTOCOL_VERSION}` };
  if (!isId(value.id)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Missing or unusable id" };
  if (value.kind !== "mint") return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Unknown request kind" };
  if (typeof value.origin !== "string") return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Missing origin" };
  const origin = canonicalOrigin(value.origin);
  // A string that is not an origin this side can mean is refused as an origin problem rather than
  // as a shape problem, because that is the thing the caller has to fix.
  if (!origin) return { ok: false, code: "ORIGIN_NOT_ALLOWED", detail: "Not an http or https origin" };
  if (!ttlAcceptable(value.ttlMs)) return { ok: false, code: "TTL_OUT_OF_RANGE", detail: "ttlMs must be a whole number of milliseconds within the permitted lifetime" };
  const sessionId = typeof value.sessionId === "string" && value.sessionId.length <= 128 ? value.sessionId : undefined;
  return { ok: true, value: { v: PROTOCOL_VERSION, id: value.id, kind: "mint", origin, ttlMs: value.ttlMs, ...(sessionId ? { sessionId } : {}) } };
}

export function refusal(id: string, code: RefusalCode, detail: string): MintResponse {
  return { v: PROTOCOL_VERSION, id, ok: false, refusal: code, detail };
}

export function granted(id: string, grant: MintGrant): MintResponse {
  return { v: PROTOCOL_VERSION, id, ok: true, grant };
}

/**
 * The broker's side of the same envelope. It is parsed with the same suspicion, and a grant that
 * has already expired by the time it is read is refused here rather than handed to a browser: the
 * response travelled through a pipe and a process, and neither is instantaneous.
 */
export function parseMintResponse(value: unknown, now: number): Parsed<MintResponse> {
  if (!isRecord(value)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Response is not an object" };
  if (value.v !== PROTOCOL_VERSION) return { ok: false, code: "UNSUPPORTED_VERSION", detail: `Expected version ${PROTOCOL_VERSION}` };
  if (!isId(value.id)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Missing or unusable id" };
  if (value.ok === false) {
    const code = refusalCodes.find(known => known === value.refusal);
    if (!code) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Unknown refusal code" };
    const detail = typeof value.detail === "string" ? value.detail : "";
    return { ok: true, value: refusal(value.id, code, detail) };
  }
  if (value.ok !== true) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Response does not say whether it succeeded" };
  if (!isRecord(value.grant)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Missing grant" };
  const grant = value.grant;
  const origin = typeof grant.origin === "string" ? canonicalOrigin(grant.origin) : undefined;
  if (!origin) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Grant names no usable origin" };
  if (typeof grant.issuedAt !== "number" || typeof grant.expiresAt !== "number"
    || !Number.isFinite(grant.issuedAt) || !Number.isFinite(grant.expiresAt))
    return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Grant carries no usable lifetime" };
  if (grant.expiresAt - grant.issuedAt > MAX_TTL_MS)
    return { ok: false, code: "TTL_OUT_OF_RANGE", detail: "Grant claims a longer life than a mint may have" };
  if (now >= grant.expiresAt) return { ok: false, code: "GRANT_EXPIRED", detail: "Grant expired before it was read" };
  if (!Array.isArray(grant.cookies)) return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Grant carries no cookie array" };
  const cookies: MintedCookie[] = [];
  for (const entry of grant.cookies) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string"
      || typeof entry.domain !== "string" || typeof entry.path !== "string")
      return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Grant carries an unusable cookie" };
    cookies.push({
      name: entry.name, value: entry.value, domain: entry.domain, path: entry.path,
      secure: entry.secure === true, httpOnly: entry.httpOnly === true,
      ...(entry.sameSite === "Strict" || entry.sameSite === "Lax" || entry.sameSite === "None" ? { sameSite: entry.sameSite } : {}),
      ...(typeof entry.expires === "number" && Number.isFinite(entry.expires) ? { expires: entry.expires } : {}),
      ...(isRecord(entry.partitionKey) && typeof entry.partitionKey.topLevelSite === "string"
        ? { partitionKey: { topLevelSite: entry.partitionKey.topLevelSite, hasCrossSiteAncestor: entry.partitionKey.hasCrossSiteAncestor === true } }
        : {}),
    });
  }
  return { ok: true, value: granted(value.id, { origin, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, cookies }) };
}
