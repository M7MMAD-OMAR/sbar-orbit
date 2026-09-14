/** A page with enough detail that a screenshot is not a blank rectangle, served on loopback. */
export function fixture() {
  const html = `<!doctype html><title>Orbit probe</title><style>body{margin:0;font:16px system-ui;background:linear-gradient(135deg,#f6f7f9,#c8d6ea)}
  .card{display:inline-block;margin:12px;padding:16px;width:280px;background:#fff;border-radius:10px;box-shadow:0 2px 8px #0002}</style>` +
    Array.from({ length: 40 }, (_, i) => `<div class="card"><h2>Panel ${i + 1}</h2><p>Text, borders and shadows so the encoder has detail to work with.</p></div>`).join("");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/set-cookie") return new Response("set", { headers: { "Set-Cookie": "orbit_probe=1; Path=/; Max-Age=86400", "Content-Type": "text/plain" } });
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  } });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}
