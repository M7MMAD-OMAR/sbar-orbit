import http from "node:http";
import https from "node:https";

/**
 * One line of Bun's HTTP client, and it took the broker down with every session on it.
 *
 * Node's `http.IncomingMessage.url` is documented as meaningful only for a SERVER request; on a
 * client response it is the empty string. Bun sets it to the request PATH instead, and Playwright's
 * fetch path reads it as the response URL:
 *
 *     const cookies = this._parseSetCookieHeader(response.url || url.toString(), ...)
 *     const url = new URL(responseUrl);   // TypeError: "/settings/profile" cannot be parsed as a URL
 *
 * `response.url` is truthy on Bun, so the `|| url.toString()` fallback that makes this correct on
 * Node never runs, and a bare path reaches the URL constructor. The throw lands inside a socket
 * event handler with nothing above it to catch, so it is an uncaught exception: the broker process
 * exits and every OTHER agent's sessions die with it.
 *
 * It only fires when a response carries `Set-Cookie`, which is why it was invisible until a session
 * started from the person's own profile and visited a page that signs them in or redirects them.
 *
 * Restoring the documented value is the whole fix. A client response has no meaningful `url`, so
 * nothing can want the path from this field, and Playwright then takes the absolute URL it already
 * has. Applied to the module objects rather than to a prototype, because the caller reads
 * `http.request` at call time.
 */
export function normaliseClientResponseUrls(modules: { request: typeof http.request; get: typeof http.get }[] = [http, https]): void {
  for (const module of modules) {
    for (const name of ["request", "get"] as const) {
      const original = module[name] as (...args: unknown[]) => http.ClientRequest;
      // Patched already, in a process that started two brokers. Wrapping twice is harmless but the
      // marker keeps the listener count honest.
      if ((original as { orbitPatched?: boolean }).orbitPatched) continue;
      const patched = function (this: unknown, ...args: unknown[]) {
        const request = original.apply(this, args);
        // Prepended, not appended. The response callback a caller passes to `http.request` is itself
        // registered as a `response` listener when the request is constructed, so an appended
        // listener runs after the caller has already read the field it was meant to correct.
        request.prependListener("response", response => {
          // A client response, never a server one: this is the object the client hands back.
          if (typeof response.url === "string" && response.url !== "") response.url = "";
        });
        return request;
      };
      (patched as { orbitPatched?: boolean }).orbitPatched = true;
      (module as Record<string, unknown>)[name] = patched;
    }
  }
}
