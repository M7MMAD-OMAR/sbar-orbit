/**
 * How long minted state is worth anything.
 *
 * A grant is the person's live identity for one origin, sitting outside the browser that holds it.
 * The only thing that makes that tolerable is that it stops being usable soon, and "soon" has to be
 * a number rather than a habit. Five minutes is the ceiling because a mint is handed to a session
 * that is already running and about to use it, not stored for later.
 *
 * This is a clock, not containment. An expired grant is refused by anything that checks it here; it
 * says nothing about a copy someone took of the cookies in the meantime. That cost is the one named
 * in `docs/separate-workspace-review.md` under what granting real sessions costs.
 */

export const MIN_TTL_MS = 1_000;
export const MAX_TTL_MS = 300_000;
/** What a mint asks for when nothing asked for more. The ceiling is a limit, not a habit. */
export const DEFAULT_TTL_MS = 60_000;

export type GrantWindow = { issuedAt: number; expiresAt: number };

export function ttlAcceptable(ttlMs: unknown): ttlMs is number {
  return typeof ttlMs === "number" && Number.isFinite(ttlMs)
    && Number.isInteger(ttlMs) && ttlMs >= MIN_TTL_MS && ttlMs <= MAX_TTL_MS;
}

export function grantWindow(now: number, ttlMs: number): GrantWindow {
  return { issuedAt: now, expiresAt: now + ttlMs };
}

/** Expiry is inclusive of the instant it names: a grant is not alive at its own expiry. */
export function isExpired(window: GrantWindow, now: number): boolean {
  return now >= window.expiresAt;
}

export function remainingMs(window: GrantWindow, now: number): number {
  return Math.max(0, window.expiresAt - now);
}
