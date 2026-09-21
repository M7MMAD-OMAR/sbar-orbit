import { expect, test } from "bun:test";
import http from "node:http";
import { normaliseClientResponseUrls } from "../src/http-response-url";

/**
 * The failure this guards is not subtle once it is named: on Bun a client response's `url` is the
 * request PATH, Playwright reads that field as the response URL whenever a response sets a cookie,
 * and `new URL("/settings/profile")` throws inside a socket handler. Nothing above it catches, so
 * the broker exits and every session on it, including other agents', is destroyed.
 */
async function respond(headers: Record<string, string | string[]>) {
  const server = http.createServer((_request, response) => { response.writeHead(302, headers); response.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const seen = await new Promise<string>(resolve => {
    http.request({ host: "127.0.0.1", port, path: "/settings/profile" }, response => {
      resolve(String((response as unknown as { url: unknown }).url ?? ""));
    }).end();
  });
  server.close();
  return seen;
}

test("a client response carries no request path in url, so an absolute URL fallback is reached", async () => {
  normaliseClientResponseUrls();
  const url = await respond({ location: "/b", "set-cookie": "session=1; Path=/" });
  expect(url).toBe("");
  // What Playwright then does with it, reproduced exactly: the falsy field selects the absolute URL.
  expect(() => new URL(url || "https://www.npmjs.com/settings/profile")).not.toThrow();
});

test("patching twice adds no second listener", async () => {
  normaliseClientResponseUrls();
  normaliseClientResponseUrls();
  expect(await respond({ location: "/b", "set-cookie": "session=1" })).toBe("");
});
