// Local fixture for the web flows campaign. Serves on localhost only.
// Run: bun run experiments/web-flows/server.ts [port]
const port = Number(process.argv[2] ?? 8765);
const root = new URL("./", import.meta.url).pathname;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/lazy-content") {
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 2500));
      return new Response("<p id=\"lazy-ready\">Lazy content arrived</p>", { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/") return new Response(Bun.file(`${root}index.html`));
    if (url.pathname === "/frame") return new Response(Bun.file(`${root}frame.html`));
    return new Response("not found", { status: 404 });
  },
});
console.log(`web-flows fixture on http://localhost:${server.port}/`);
