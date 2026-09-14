/**
 * Origin scoping, on the minting side.
 *
 * Orbit already scopes a session's egress to a set of origins, per origin inside the browser and
 * per authority below it (`src/egress.ts`). This is the third place the same set has to be
 * understood, and it is the one that decides what leaves the person's browser at all.
 *
 * The normalization here is deliberately a duplicate of `leasedAuthorities` in `src/egress.ts`
 * rather than an import of it: that module is Bun code that opens sockets, and pulling it into an
 * extension bundle would drag a server runtime into a service worker. The duplication carries an
 * obligation instead, which is that the two must agree on what an origin is. Both drop anything
 * that is not http or https, and both take the port implied by the scheme.
 */

export type MintedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  /**
   * Carried because the broker side needs it. Whether `chrome.cookies.getAll` returns HttpOnly
   * cookies at all was gate G12 in `docs/porting.md`, closed 14 September 2026: it does, with this
   * flag set, so session cookies are mintable and this field is what says which ones were.
   */
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Seconds since the epoch, Chrome's own unit for this field. Absent means a session cookie. */
  expires?: number;
  /**
   * Also G12, also NOT MEASURED: whether a partition key survives the round trip into a second
   * browser through `Network.setCookie` was never confirmed. The shape is CDP's so that the broker
   * side has something to pass through unchanged if it does.
   */
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
};

/**
 * `https://Example.COM/path` is the origin `https://example.com`. Anything that is not an http or
 * https origin is not an origin this path can mean, so it is dropped rather than guessed at.
 */
export function canonicalOrigin(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.hostname) return undefined;
  return url.origin;
}

/**
 * Exact origin membership, with no wildcards and no subdomain widening. A request for
 * `https://mail.example.com` against an allowlist holding `https://example.com` is a refusal, not a
 * match: the allowlist is the whole safety property, and a matcher that is generous with it is the
 * same as not having one.
 */
export function originAllowed(allowlist: readonly string[], origin: string): boolean {
  const wanted = canonicalOrigin(origin);
  if (!wanted) return false;
  return allowlist.some(entry => canonicalOrigin(entry) === wanted);
}

/**
 * RFC 6265 domain matching, which is the rule the browser itself applied when it stored the cookie.
 * A leading dot is the old spelling of the same thing and Chrome still returns it.
 *
 * The honest limit: there is no public suffix list here, so this function alone would accept a
 * cookie whose domain is a registry suffix. It is not the guard against that; the browser is,
 * because it never stores such a cookie. Nothing downstream should read this as validation of a
 * domain that did not come out of `chrome.cookies`.
 */
export function domainCovers(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  if (!domain || !target) return false;
  if (domain === target) return true;
  return target.endsWith(`.${domain}`);
}

/**
 * Narrow a cookie set to one origin. The browser is asked for one origin's cookies already, so this
 * is the second check rather than the first, and it exists because the answer to a `getAll` is the
 * browser's idea of relevant rather than this extension's idea of scoped.
 *
 * Insecure cookies are kept for an http origin and dropped for an https one only where the cookie
 * itself is marked secure and the origin is not, which is a mint that could never be replayed.
 */
export function cookiesForOrigin(cookies: readonly MintedCookie[], origin: string): MintedCookie[] {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return [];
  const url = new URL(canonical);
  const secureOrigin = url.protocol === "https:";
  return cookies.filter(cookie => {
    if (!domainCovers(cookie.domain, url.hostname)) return false;
    if (cookie.secure && !secureOrigin) return false;
    return true;
  });
}
