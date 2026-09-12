import { test, expect } from "bun:test";
import { decodeFrames, encodeFrame, MAX_FRAME_BYTES, nativeLittleEndian } from "../extension/src/framing";
import { canonicalOrigin, cookiesForOrigin, domainCovers, originAllowed, type MintedCookie } from "../extension/src/origins";
import { grantWindow, isExpired, MAX_TTL_MS, MIN_TTL_MS, remainingMs, ttlAcceptable } from "../extension/src/grant";
import { parseMintRequest, parseMintResponse, PROTOCOL_VERSION, refusalCodes } from "../extension/src/envelope";
import { completeMint, planMint } from "../extension/src/mint";

/**
 * The pure half of the mint extension, which is the only half that can be tested here.
 *
 * What these tests do NOT establish, and nothing in this file should be read as establishing:
 * whether the extension loads, whether `chrome.cookies.getAll` returns HttpOnly cookies (G12),
 * whether a partition key survives the round trip (G12), how a queued mint reaches a stopped MV3
 * service worker (G13), or how long an open native port keeps that worker alive (G14). All three
 * gates need the extension loaded in a real browser and all three stay open. No browser API is
 * faked anywhere below; `service-worker.ts` is deliberately not imported.
 */

const request = (over: Record<string, unknown> = {}) => ({ v: 1, id: "m1", kind: "mint", origin: "https://example.com", ttlMs: 60_000, ...over });

test("an origin is what the egress lease would call an origin, and nothing else is", () => {
  // Same normalization src/egress.ts applies, deliberately duplicated rather than imported, so the
  // two layers have to be checked against each other rather than assumed to agree.
  expect(canonicalOrigin("https://Example.COM/path?q=1")).toBe("https://example.com");
  expect(canonicalOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  // A default port is implied by the scheme and is not spelled back out.
  expect(canonicalOrigin("https://example.com:443")).toBe("https://example.com");
  for (const value of ["chrome://settings", "file:///etc/passwd", "not a url", "", "javascript:alert(1)", "ftp://example.com"])
    expect(canonicalOrigin(value)).toBeUndefined();
});

test("the allowlist matches whole origins and never widens to a neighbour", () => {
  const allowlist = ["https://example.com", "http://127.0.0.1:8080"];
  expect(originAllowed(allowlist, "https://example.com/inbox")).toBe(true);
  expect(originAllowed(allowlist, "https://EXAMPLE.com")).toBe(true);
  // A subdomain, a sibling, a scheme change and a port change are four different origins.
  for (const origin of ["https://mail.example.com", "https://example.com.evil.test", "http://example.com", "http://127.0.0.1:8081", "https://notexample.com"])
    expect(originAllowed(allowlist, origin)).toBe(false);
  // An empty allowlist is an empty allowlist. Absent configuration is never a wildcard.
  expect(originAllowed([], "https://example.com")).toBe(false);
});

test("cookie domains are narrowed to the origin the mint was asked for", () => {
  expect(domainCovers(".example.com", "example.com")).toBe(true);
  expect(domainCovers(".example.com", "mail.example.com")).toBe(true);
  expect(domainCovers("example.com", "mail.example.com")).toBe(true);
  // The direction that matters: a parent host is not covered by a child's cookie, and a suffix that
  // is not a label boundary is not a match at all.
  expect(domainCovers("mail.example.com", "example.com")).toBe(false);
  expect(domainCovers("ample.com", "example.com")).toBe(false);
  expect(domainCovers("", "example.com")).toBe(false);

  const cookie = (over: Partial<MintedCookie>): MintedCookie =>
    ({ name: "s", value: "v", domain: "example.com", path: "/", secure: true, httpOnly: true, ...over });
  const mixed = [
    cookie({ name: "keep" }),
    cookie({ name: "parent", domain: ".example.com" }),
    cookie({ name: "other", domain: "other.test" }),
    cookie({ name: "child", domain: "mail.example.com" }),
  ];
  expect(cookiesForOrigin(mixed, "https://example.com").map(entry => entry.name)).toEqual(["keep", "parent"]);
  // A secure cookie on an insecure origin could never be replayed, so it is not handed over.
  expect(cookiesForOrigin([cookie({ name: "s", secure: true })], "http://example.com")).toEqual([]);
  expect(cookiesForOrigin([cookie({ name: "s", secure: false })], "http://example.com").map(entry => entry.name)).toEqual(["s"]);
  // An origin that is not an origin narrows to nothing rather than to everything.
  expect(cookiesForOrigin(mixed, "chrome://settings")).toEqual([]);
});

test("a mint lifetime is bounded at both ends and expiry is inclusive", () => {
  expect(ttlAcceptable(MIN_TTL_MS)).toBe(true);
  expect(ttlAcceptable(MAX_TTL_MS)).toBe(true);
  for (const value of [MIN_TTL_MS - 1, MAX_TTL_MS + 1, 0, -1, 1.5, NaN, Infinity, "60000", null, undefined])
    expect(ttlAcceptable(value)).toBe(false);

  const window = grantWindow(1_000, 60_000);
  expect(window).toEqual({ issuedAt: 1_000, expiresAt: 61_000 });
  expect(isExpired(window, 60_999)).toBe(false);
  // A grant is not alive at the instant it names, which is the difference between a bound and a hint.
  expect(isExpired(window, 61_000)).toBe(true);
  expect(remainingMs(window, 60_000)).toBe(1_000);
  expect(remainingMs(window, 99_999)).toBe(0);
});

test("a request envelope is parsed rather than trusted, with a code for each way it fails", () => {
  const parsed = parseMintRequest(request({ origin: "https://Example.com/inbox", sessionId: "s1" }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    // Canonical on the way in, so nothing downstream compares two spellings of one origin.
    expect(parsed.value.origin).toBe("https://example.com");
    expect(parsed.value.sessionId).toBe("s1");
    expect(parsed.value.v).toBe(PROTOCOL_VERSION);
  }
  const codeFor = (value: unknown) => {
    const result = parseMintRequest(value);
    return result.ok ? "ok" : result.code;
  };
  expect(codeFor(null)).toBe("MALFORMED_ENVELOPE");
  expect(codeFor([request()])).toBe("MALFORMED_ENVELOPE");
  expect(codeFor(request({ v: 2 }))).toBe("UNSUPPORTED_VERSION");
  expect(codeFor(request({ v: undefined }))).toBe("UNSUPPORTED_VERSION");
  expect(codeFor(request({ id: "" }))).toBe("MALFORMED_ENVELOPE");
  expect(codeFor(request({ id: "x".repeat(129) }))).toBe("MALFORMED_ENVELOPE");
  expect(codeFor(request({ kind: "drive" }))).toBe("MALFORMED_ENVELOPE");
  expect(codeFor(request({ origin: 5 }))).toBe("MALFORMED_ENVELOPE");
  expect(codeFor(request({ origin: "file:///etc/passwd" }))).toBe("ORIGIN_NOT_ALLOWED");
  expect(codeFor(request({ ttlMs: MAX_TTL_MS + 1 }))).toBe("TTL_OUT_OF_RANGE");
  // A session label that is not usable is dropped, not fatal: it is carried for the journal only.
  const noLabel = parseMintRequest(request({ sessionId: 42 }));
  expect(noLabel.ok && noLabel.value.sessionId).toBeUndefined();
});

test("the broker reads a response with the same suspicion, and a dead grant never reaches a browser", () => {
  const live = { v: 1, id: "m1", ok: true, grant: { origin: "https://example.com", issuedAt: 1_000, expiresAt: 61_000, cookies: [
    { name: "s", value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 1_700_000_000, partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true } },
    { name: "loose", value: "v", domain: "example.com", path: "/" },
  ] } };
  const parsed = parseMintResponse(live, 2_000);
  expect(parsed.ok).toBe(true);
  if (parsed.ok && parsed.value.ok) {
    const [first, second] = parsed.value.grant.cookies;
    // Carried through unchanged for the broker, and both of these fields are G12: whether HttpOnly
    // cookies come back from the browser at all, and whether a partition key survives the round
    // trip, are NOT MEASURED here.
    expect(first?.httpOnly).toBe(true);
    expect(first?.partitionKey).toEqual({ topLevelSite: "https://example.com", hasCrossSiteAncestor: true });
    expect(first?.sameSite).toBe("None");
    // Absent flags are false rather than undefined, so no consumer has to guess.
    expect(second?.httpOnly).toBe(false);
    expect(second?.secure).toBe(false);
    expect(second?.sameSite).toBeUndefined();
  }
  const codeFor = (value: unknown, now = 2_000) => {
    const result = parseMintResponse(value, now);
    return result.ok ? "ok" : result.code;
  };
  // Expired in transit, which is the ordinary case a pipe and a process make possible.
  expect(codeFor(live, 61_000)).toBe("GRANT_EXPIRED");
  // A response that claims a longer life than a mint may have is refused rather than honoured.
  expect(codeFor({ ...live, grant: { ...live.grant, expiresAt: 1_000 + MAX_TTL_MS + 1 } })).toBe("TTL_OUT_OF_RANGE");
  expect(codeFor({ ...live, v: 9 })).toBe("UNSUPPORTED_VERSION");
  expect(codeFor({ ...live, grant: { ...live.grant, origin: "chrome://settings" } })).toBe("MALFORMED_ENVELOPE");
  expect(codeFor({ ...live, grant: { ...live.grant, cookies: "all of them" } })).toBe("MALFORMED_ENVELOPE");
  expect(codeFor({ ...live, grant: { ...live.grant, cookies: [{ name: "s" }] } })).toBe("MALFORMED_ENVELOPE");
  expect(codeFor({ v: 1, id: "m1" })).toBe("MALFORMED_ENVELOPE");
  // Every refusal the extension can send is a refusal the broker can read back.
  for (const code of refusalCodes)
    expect(codeFor({ v: 1, id: "m1", ok: false, refusal: code, detail: "" })).toBe("ok");
  expect(codeFor({ v: 1, id: "m1", ok: false, refusal: "LET_ME_IN", detail: "" })).toBe("MALFORMED_ENVELOPE");
});

test("the mint decision refuses an origin outside the allowlist before it asks about anything else", () => {
  const parsed = parseMintRequest(request());
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const base = { allowlist: ["https://example.com"], granted: ["https://example.com"], personPresent: true, now: 1_000 };
  const codeFor = (context: typeof base) => {
    const decision = planMint(parsed.value, context);
    return decision.ok ? "ok" : decision.response.ok === false ? decision.response.refusal : "ok";
  };
  expect(codeFor(base)).toBe("ok");
  expect(codeFor({ ...base, granted: [] })).toBe("ORIGIN_NOT_GRANTED");
  expect(codeFor({ ...base, personPresent: false })).toBe("NO_PENDING_REQUEST");
  // The ordering is the property: an origin nobody allowed is refused with nobody present and with
  // nothing granted, so making the request can never be the thing that raises a prompt.
  expect(codeFor({ ...base, allowlist: [], granted: [], personPresent: false })).toBe("ORIGIN_NOT_ALLOWED");
  expect(codeFor({ ...base, allowlist: ["https://other.test"] })).toBe("ORIGIN_NOT_ALLOWED");

  const decision = planMint(parsed.value, base);
  expect(decision.ok).toBe(true);
  if (!decision.ok) return;
  const cookie = { name: "s", value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: true };
  // Checked again after the read, because reading cookies is not instantaneous.
  const late = completeMint(decision.plan, [cookie], 1_000 + 60_000);
  expect(late.ok === false && late.refusal).toBe("GRANT_EXPIRED");
  // Scoped again after the read, because the browser's idea of relevant is not this extension's.
  const other = completeMint(decision.plan, [{ ...cookie, domain: "other.test" }], 2_000);
  expect(other.ok === false && other.refusal).toBe("NOTHING_TO_MINT");
  const minted = completeMint(decision.plan, [cookie, { ...cookie, name: "elsewhere", domain: "other.test" }], 2_000);
  expect(minted.ok).toBe(true);
  if (minted.ok) {
    expect(minted.grant.cookies.map(entry => entry.name)).toEqual(["s"]);
    expect(minted.grant.expiresAt - minted.grant.issuedAt).toBe(60_000);
  }
});

test("native messaging framing is native byte order, bounded, and survives a split stream", () => {
  const framed = encodeFrame({ v: 1, id: "m1" });
  // Four bytes of length in the machine's own order, which is the fact a big endian constant gets
  // wrong silently. Read it back the same way rather than asserting a byte pattern.
  expect(new DataView(framed.buffer).getUint32(0, nativeLittleEndian)).toBe(framed.length - 4);
  const read = decodeFrames(framed);
  expect(read.ok && read.messages).toEqual([{ v: 1, id: "m1" }]);
  expect(read.ok && read.rest.length).toBe(0);

  // Two messages in one read, which is what a pipe actually delivers.
  const both = new Uint8Array([...encodeFrame({ id: "a" }), ...encodeFrame({ id: "b" })]);
  const pair = decodeFrames(both);
  expect(pair.ok && pair.messages).toEqual([{ id: "a" }, { id: "b" }]);

  // A partial frame is the ordinary case, not a failure: it comes back as the remainder.
  for (const cut of [1, 3, 4, framed.length - 1]) {
    const partial = decodeFrames(framed.subarray(0, cut));
    expect(partial.ok && partial.messages).toEqual([]);
    expect(partial.ok && partial.rest.length).toBe(cut);
  }
  const straddling = decodeFrames(both.subarray(0, framed.length + 2));
  expect(straddling.ok && straddling.messages.length).toBe(1);

  // A declared length this side will not honour is refused rather than buffered.
  const huge = new Uint8Array(8);
  new DataView(huge.buffer).setUint32(0, MAX_FRAME_BYTES + 1, nativeLittleEndian);
  const refused = decodeFrames(huge);
  expect(refused.ok === false && refused.code).toBe("FRAME_TOO_LARGE");

  const body = new TextEncoder().encode("{not json");
  const broken = new Uint8Array(4 + body.length);
  new DataView(broken.buffer).setUint32(0, body.length, nativeLittleEndian);
  broken.set(body, 4);
  const bad = decodeFrames(broken);
  expect(bad.ok === false && bad.code).toBe("MALFORMED_ENVELOPE");

  expect(() => encodeFrame({ pad: "x".repeat(MAX_FRAME_BYTES + 1) })).toThrow(RangeError);
});
