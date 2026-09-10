import { requireResourceBudget } from "./resource-budget";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Sessions } from "./session";
import { OrbitError } from "./errors";
import { startPreview } from "./preview";
import { createWorkspaceDirectory } from "./workspace-storage";
import { claimSocket } from "./service";

export async function startBroker(options: { accountRoot?: string; socketPath?: string } = {}) {
  await requireResourceBudget();
  // A managed broker binds one fixed path so host configuration survives restarts. Every other
  // broker keeps a private directory, so tests and experiments cannot collide with each other.
  let socket = options.socketPath;
  let privateRoot: string | undefined;
  if (socket) await claimSocket(socket, async path => {
    try { await call(path, "doctor"); return true; } catch { return false; }
  });
  else {
    privateRoot = await mkdtemp(join(tmpdir(), "orbit-broker-"));
    await chmod(privateRoot, 0o700);
    socket = join(privateRoot, "broker.sock");
  }
  const sessions = new Sessions(await createWorkspaceDirectory("broker"), options.accountRoot);
  let preview: ReturnType<typeof startPreview> | undefined;
  const server = Bun.serve({
    unix: socket, maxRequestBodySize: 65536,
    async fetch(request) {
      this.timeout(request, 60);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("Not found", { status: 404 });
      try {
        const body = await request.json();
        if (body?.method === "preview.open") {
          preview ??= startPreview(sessions);
          return Response.json({ ok: true, result: { url: preview.url } });
        }
        return Response.json({ ok: true, result: await sessions.dispatch(body) });
      }
      catch (error) {
        const code = error instanceof OrbitError ? error.code : error instanceof SyntaxError ? "INVALID_REQUEST" : "BACKEND_ERROR";
        const message = error instanceof OrbitError ? error.message : "Request failed";
        // Clients get a fixed message; the broker's own stderr keeps the cause, or a failure that
        // only shows up under load is impossible to attribute afterwards.
        if (code === "BACKEND_ERROR") console.error(JSON.stringify({ unexpected: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
        return Response.json({ ok: false, error: { code, message } });
      }
    },
  });
  await chmod(socket, 0o600);
  return { socket, sessions, async close() {
    preview?.close(); server.stop(true); await sessions.close();
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true }).catch(() => {});
  } };
}
export async function call(socket: string, method: string, params: unknown = {}): Promise<unknown> {
  const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(45000) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!result.ok) throw new OrbitError(result.error?.code ?? "BROKER_ERROR", result.error?.message ?? "Broker failed");
  return result.result;
}
