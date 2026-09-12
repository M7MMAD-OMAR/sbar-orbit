/**
 * The decision a mint makes, with no browser in it.
 *
 * Everything that decides whether state leaves the person's browser lives here, so that it can be
 * read in one place and tested without loading anything. The service worker beside this file is
 * the part that cannot be tested that way, and it is kept to the calls that need a browser: ask
 * for cookies, open the port, write the reply. It makes no decisions of its own.
 */

import { grantWindow, isExpired, type GrantWindow } from "./grant";
import { cookiesForOrigin, originAllowed, type MintedCookie } from "./origins";
import { refusal, granted, type MintRequest, type MintResponse } from "./envelope";

export type MintContext = {
  /** Origins the person configured this extension to be willing to mint for, ever. */
  allowlist: readonly string[];
  /** Origins the browser has actually granted host permission for, which is a separate thing. */
  granted: readonly string[];
  /**
   * Whether this mint is happening because the person asked for it in this moment. Gate G13, which
   * asks which wake paths into a stopped MV3 service worker put something on the person's screen,
   * is open and untested, so the design takes the fallback that gate names in advance: a mint with
   * nobody present is refused rather than announced.
   */
  personPresent: boolean;
  now: number;
};

export type MintPlan = {
  request: MintRequest;
  window: GrantWindow;
  /** The origin to ask the browser about, already canonical. */
  origin: string;
};

export type MintDecision = { ok: true; plan: MintPlan } | { ok: false; response: MintResponse };

/**
 * Four refusals in a fixed order, and the order is the point: an origin the person never allowed is
 * refused before anything asks whether a person is at the keyboard, so a request for an origin
 * outside the set cannot be turned into a prompt by the act of making it.
 */
export function planMint(request: MintRequest, context: MintContext): MintDecision {
  if (!originAllowed(context.allowlist, request.origin))
    return { ok: false, response: refusal(request.id, "ORIGIN_NOT_ALLOWED", "Origin is not in the configured mint allowlist") };
  if (!originAllowed(context.granted, request.origin))
    return { ok: false, response: refusal(request.id, "ORIGIN_NOT_GRANTED", "The browser has not granted host permission for this origin") };
  if (!context.personPresent)
    return { ok: false, response: refusal(request.id, "NO_PENDING_REQUEST", "A mint happens when the person asks for it, and nobody asked") };
  return { ok: true, plan: { request, window: grantWindow(context.now, request.ttlMs), origin: request.origin } };
}

/**
 * What the browser returned, narrowed and stamped. The expiry is checked again at this point
 * because reading cookies is not instantaneous and a grant that is already dead should never be
 * written to the pipe.
 */
export function completeMint(plan: MintPlan, cookies: readonly MintedCookie[], now: number): MintResponse {
  if (isExpired(plan.window, now))
    return refusal(plan.request.id, "GRANT_EXPIRED", "The grant ran out while its cookies were being read");
  const scoped = cookiesForOrigin(cookies, plan.origin);
  if (scoped.length === 0)
    return refusal(plan.request.id, "NOTHING_TO_MINT", "The browser returned no cookies for this origin");
  return granted(plan.request.id, { ...plan.window, origin: plan.origin, cookies: scoped });
}
