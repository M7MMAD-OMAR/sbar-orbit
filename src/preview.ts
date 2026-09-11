import { join } from "node:path";
import { Sessions } from "./session";
import { OrbitError, record } from "./errors";
import { loadTheme } from "./theme";

export function startPreview(sessions: Sessions) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const files: Record<string, string> = { "/": "index.html", "/viewer.js": "viewer.js", "/style.css": "style.css" };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 65536, idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const expected = `http://127.0.0.1:${server.port}`;
      if (url.origin !== expected || request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Invalid host", { status: 403 });
      const headers = {
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
      const file = files[url.pathname];
      if (request.method === "GET" && url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
      // Served from brand/ rather than copied into viewer/, so the mark has one source in the repo.
      if (request.method === "GET" && url.pathname === "/favicon.svg")
        return new Response(Bun.file(join(import.meta.dir, "../brand/favicon.svg")), { headers: { ...headers, "Content-Type": "image/svg+xml" } });
      // Read per request so a desktop that regenerates its palette is picked up by the next viewer load.
      if (request.method === "GET" && url.pathname === "/theme.css")
        return new Response(await loadTheme(), { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
      if (request.method === "GET" && file) return new Response(Bun.file(join(import.meta.dir, "../viewer", file)), { headers });
      if (request.method !== "POST" || url.pathname !== "/rpc") return new Response("Not found", { status: 404, headers });
      if (request.headers.get("origin") !== expected || request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Forbidden", { status: 403, headers });
      try {
        const body = record(await request.json());
        if (!["session.list", "session.observe", "session.presence", "session.pause", "session.resume", "session.stop", "session.control", "session.account.save"].includes(String(body.method))) throw new OrbitError("UNSUPPORTED", "Method unavailable in viewer");
        return Response.json({ ok: true, result: await sessions.dispatch(body) }, { headers });
      } catch (error) {
        return Response.json({ ok: false, error: { code: error instanceof OrbitError ? error.code : "PREVIEW_ERROR",
          message: error instanceof OrbitError ? error.message : "Preview request failed" } }, { headers });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/#${token}`, close: () => server.stop(true) };
}
