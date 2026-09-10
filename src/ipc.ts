import { requireResourceBudget } from "./resource-budget";
import { chmod, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Sessions } from "./session";
import { OrbitError } from "./errors";
import { startPreview } from "./preview";
import { createWorkspaceDirectory } from "./workspace-storage";

export async function startBroker(options: { accountRoot?: string } = {}) {
  await requireResourceBudget();
  const root = await mkdtemp(join(tmpdir(), "orbit-broker-"));
  await chmod(root, 0o700);
  const socket = join(root, "broker.sock");
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
        return Response.json({ ok: false, error: { code, message } });
      }
    },
  });
  await chmod(socket, 0o600);
  return { socket, sessions, async close() { preview?.close(); server.stop(true); await sessions.close(); } };
}
export async function call(socket: string, method: string, params: unknown = {}): Promise<unknown> {
  const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(45000) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!result.ok) throw new OrbitError(result.error?.code ?? "BROKER_ERROR", result.error?.message ?? "Broker failed");
  return result.result;
}
