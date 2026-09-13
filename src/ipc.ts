import { requireResourceBudget } from "./resource-budget";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Sessions } from "./session";
import { OrbitError } from "./errors";
import { startPreview } from "./preview";
import { listHostBrowsers, openViewer, viewerPreference } from "./host-browsers";
import { createWorkspaceDirectory, markWorkspaceOwner } from "./workspace-storage";
import { claimSocket } from "./service";
import { Diagnostics, diagnosticRoot } from "./diagnostics";

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
  const workspace = await createWorkspaceDirectory("broker");
  const sessions = new Sessions(workspace, options.accountRoot, new Diagnostics(options.socketPath ? diagnosticRoot() : join(workspace, "diagnostics")));
  let preview: ReturnType<typeof startPreview> | undefined;
  const server = Bun.serve({
    unix: socket, maxRequestBodySize: 65536,
    async fetch(request) {
      this.timeout(request, 60);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("Not found", { status: 404 });
      try {
        const body = await request.json();
        // The viewer's own browser is a host concern, not a session one, so it is answered here rather
        // than in the session dispatcher the agent API shares.
        if (body?.method === "viewer.browsers") return Response.json({ ok: true, result: { browsers: await listHostBrowsers(), ...await viewerPreference() } });
        if (body?.method === "preview.open") {
          preview ??= startPreview(sessions);
          const params = (body.params ?? {}) as { launch?: boolean; browser?: string; appWindow?: boolean };
          // The link carries an access token, so opening it here keeps it out of any caller that only
          // wanted a window. A caller that asks for the URL alone still gets the URL alone.
          if (!params.launch) return Response.json({ ok: true, result: { url: preview.url } });
          const preference = await viewerPreference();
          const opened = await openViewer(preview.url, params.browser ?? preference.browser,
            params.appWindow ?? preference.appWindow);
          return Response.json({ ok: true, result: { url: preview.url, ...opened } });
        }
        return Response.json({ ok: true, result: await sessions.dispatch(body) });
      }
      catch (error) {
        const code = error instanceof OrbitError ? error.code : error instanceof SyntaxError ? "INVALID_REQUEST" : "BACKEND_ERROR";
        const message = error instanceof OrbitError ? error.message : "Request failed";
        // The private metadata journal holds the correlation ID. Raw exceptions can contain secrets,
        // so the client gets a fixed message, and the cause goes to the broker's own stderr, which is
        // the operator's journal rather than anything an agent or a page can read. Without that line a
        // BACKEND_ERROR is unattributable: the journal records that a method failed and not why, and
        // the exception is gone. Measured 13 September 2026 on a fresh machine, where every session
        // creation failed with nothing anywhere saying what had thrown.
        if (!(error instanceof OrbitError))
          console.error(JSON.stringify({ unexpected: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
        return Response.json({ ok: false, error: { code, message, diagnosticId: error instanceof OrbitError ? error.diagnosticId : undefined } });
      }
    },
  });
  await chmod(socket, 0o600);
  // Recorded once the socket answers, since answering is what marks the workspace as owned.
  await markWorkspaceOwner(workspace, socket);
  return { socket, sessions, async close() {
    preview?.close(); server.stop(true); await sessions.close();
    await sessions.diagnostics.flush();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true }).catch(() => {});
  } };
}
export async function call(socket: string, method: string, params: unknown = {}): Promise<unknown> {
  const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(45000) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string; diagnosticId?: string } };
  if (!result.ok) throw new OrbitError(result.error?.code ?? "BROKER_ERROR", result.error?.message ?? "Broker failed", result.error?.diagnosticId);
  return result.result;
}
