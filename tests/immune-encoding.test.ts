/**
 * The immune set against encoded paths.
 *
 * `docs/support-tiers.md` claims "An immune set nothing clears" as Measured, and `docs/autonomy.md`
 * names matching a URL as a string as Orbit's "equivalent mistake". That mistake was alive inside the
 * structural matcher: `segmentsOf` split `URL.pathname`, which keeps percent escapes verbatim, so
 * `new URL("https://bank.test/%74ransfer").pathname` is `/%74ransfer`, the segment set held
 * `%74ransfer`, the table looked for `transfer`, and the money movement entry never fired. Every
 * ordinary web server decodes the path before routing, so that is one endpoint to the service and two
 * endpoints to the matcher. `/%70assword` and `/%6Fauth/authorize` defeated `credential-change` and
 * `oauth-grant` the same way.
 *
 * Found by the adversarial suite, reproduced independently here before being fixed, and written as
 * its own file because the negative cases matter as much as the positive ones: a decoder bolted onto
 * a matcher is an easy way to create FALSE positives, and a guard that fires on everything gets
 * disabled by the next person it blocks.
 */
import { test, expect } from "bun:test";
import { immuneMatch } from "../src/policy";

const caught = (url: string, method = "POST") => immuneMatch("navigate", url, method)?.id ?? null;

test("the canonical spelling is caught, which is the control every other case is read against", () => {
  expect(caught("https://bank.test/transfer")).toBe("money-movement");
  expect(caught("https://acct.test/password")).toBe("credential-change");
});

test("a percent encoded path no longer walks past the immune set", () => {
  // The finding, exactly as reproduced: one hex escape on one letter was the whole bypass.
  expect(caught("https://bank.test/%74ransfer")).toBe("money-movement");
  expect(caught("https://acct.test/%70assword")).toBe("credential-change");
  // Uppercase hex digits are the same escape.
  expect(caught("https://bank.test/%54RANSFER")).toBe("money-movement");
});

test("an entry with required query parameters is caught encoded, and only with them", () => {
  // oauth-grant also requires response_type and client_id, so its encoded form has to be checked
  // WITH the query present. Without it the entry correctly does not fire, encoded or not, and
  // asserting both halves is what stops this test from mistaking a query miss for a decode miss.
  const encoded = "https://id.test/%6Fauth/authorize";
  const query = "?response_type=code&client_id=x";
  expect(caught(encoded + query, "GET")).toBe("oauth-grant");
  expect(caught("https://id.test/oauth/authorize" + query, "GET")).toBe("oauth-grant");
  expect(caught(encoded, "GET")).toBeNull();

  // This case SURVIVED the mutation that removes the decode, and the survivor is worth keeping
  // rather than tidying away: `oauth-grant` lists three segments, `oauth`, `authorize` and
  // `consent`, and `%6Fauth/authorize` still contains an unencoded `authorize`, so the entry fires
  // through that segment whether or not anything is decoded. The test was not measuring the decode
  // at all.
  //
  // Encoding EVERY listed segment is what makes the decode the only way through, and that is the
  // shape a real bypass would take.
  const allEncoded = "https://id.test/%6Fauth/%61uthorize" + query;
  expect(caught(allEncoded, "GET")).toBe("oauth-grant");
});

test("the spellings that already worked still work", () => {
  expect(caught("https://bank.test/TRANSFER")).toBe("money-movement");
  expect(caught("https://bank.test/a/../transfer")).toBe("money-movement");
});

test("a separator smuggled in as %2F is split rather than swallowed", () => {
  // Decoding the whole path before splitting would be the opposite defect: %2F would introduce a
  // separator the request never had. Decoding per segment and re-splitting is why this is caught as
  // a real `transfer` segment rather than as the single opaque segment `x%2ftransfer`.
  expect(caught("https://bank.test/x%2Ftransfer")).toBe("money-movement");
});

test("decoding does not invent matches: the negative cases still miss", () => {
  // A guard that fires on everything is a guard someone turns off, so these matter as much as the
  // positives.
  //
  // Double encoding must NOT match: %2574ransfer decodes once to %74ransfer, which is a path a
  // server would serve literally, not a transfer endpoint. One decode is the web's behaviour; two is
  // this matcher inventing a request nobody made.
  expect(caught("https://bank.test/%2574ransfer")).toBeNull();
  // A substring is not a segment, which is the property segmentsOf existed for before this change.
  expect(caught("https://bank.test/transferred")).toBeNull();
  expect(caught("https://bank.test/wiretransfers")).toBeNull();
  // An ordinary path is untouched.
  expect(caught("https://example.test/about")).toBeNull();
});

test("a malformed escape is matched on its raw spelling rather than throwing", () => {
  // `decodeURIComponent("%zz")` throws. A matcher that throws here stops protecting the REST of the
  // request, so a bad escape keeps its raw form and the other segments are still checked.
  expect(() => caught("https://bank.test/%zzransfer")).not.toThrow();
  expect(caught("https://bank.test/%zzransfer")).toBeNull();
  // And the case that proves the throw would have mattered: a malformed segment beside a real one.
  expect(caught("https://bank.test/%zz/transfer")).toBe("money-movement");
  expect(() => caught("https://bank.test/%/transfer")).not.toThrow();
  expect(caught("https://bank.test/%/transfer")).toBe("money-movement");
});

test("an implied method never disarms the immune set, though a stated one still narrows it", () => {
  // The regression this file nearly shipped. Fixing the dead-rule defect made the broker supply an
  // implied GET for a navigation, so `money-movement`, which lists POST and PUT, stopped matching
  // navigations it had caught a moment earlier. Fixing one defect broke another, and only the
  // end-to-end adversarial test saw it.
  expect(immuneMatch("navigate", "https://bank.test/transfer", "GET", true)?.id).toBe("money-movement");
  expect(immuneMatch("navigate", "https://bank.test/%74ransfer", "GET", true)?.id).toBe("money-movement");
  // A STATED method still narrows, which is the behaviour that existed before and is worth keeping:
  // a caller who tells the broker this is a GET is telling it something it did not guess.
  expect(immuneMatch("navigate", "https://bank.test/transfer", "GET", false)).toBeNull();
  expect(immuneMatch("navigate", "https://bank.test/transfer", "POST", false)?.id).toBe("money-movement");
});
