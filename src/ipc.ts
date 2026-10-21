import { requireResourceBudget } from "./resource-budget";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopSessions } from "./desktop-session";
import { OrbitError } from "./errors";
import { restrictSocketToOwner } from "./socket-acl";
import { settingsRequest } from "./desktop-settings";
import { createWorkspaceDirectory, markWorkspaceOwner } from "./workspace-storage";
import { claimSocket } from "./service";
import { Diagnostics, diagnosticRoot } from "./diagnostics";
import type { NativeOptions } from "./native-worker";

export async function startBroker(options: { accountRoot?: string; socketPath?: string; native?: NativeOptions } = {}) {
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
  const sessions = new DesktopSessions(workspace, options.accountRoot, new Diagnostics(options.socketPath ? diagnosticRoot() : join(workspace, "diagnostics")), options.native);
  const server = Bun.serve({
    unix: socket, maxRequestBodySize: 65536,
    async fetch(request) {
      this.timeout(request, 60);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("Not found", { status: 404 });
      try {
        const body = await request.json();
        if (body?.method === "settings.list" || body?.method === "settings.write")
          return Response.json({ ok: true, result: await settingsRequest(body) });
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
  await restrictSocketToOwner(socket);
  // Recorded once the socket answers, since answering is what marks the workspace as owned.
  await markWorkspaceOwner(workspace, socket);
  return { socket, sessions, async close() {
    server.stop(true); await sessions.close();
    await sessions.diagnostics.flush();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true }).catch(() => {});
  } };
}
async function cancellableCall(socket: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  const { request } = await import("node:http");
  const combined = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  combined.throwIfAborted();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const child = request({ socketPath: socket, path: "/rpc", method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    } }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          child.destroy(new OrbitError("BROKER_ERROR", "Native broker reply exceeds its client bound"));
        } else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: unknown; error?: { code?: string; message?: string; diagnosticId?: string } };
          if (!result.ok) reject(new OrbitError(result.error?.code ?? "BROKER_ERROR", result.error?.message ?? "Broker failed", result.error?.diagnosticId));
          else resolve(result.result);
        } catch { reject(new OrbitError("BROKER_ERROR", "Native broker reply is invalid JSON")); }
      });
    });
    const abort = () => {
      const error = combined.reason instanceof Error ? combined.reason : new Error("Native client request cancelled");
      // Settle locally even when the runtime delays its socket error event.
      reject(error); child.destroy(error);
    };
    combined.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.once("close", () => combined.removeEventListener("abort", abort));
    if (combined.aborted) abort(); else child.end(body);
  });
}

export async function call(socket: string, method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
  // Bun 1.3.14's Unix fetch did not cancel an admitted request in the native view check.
  if (signal) return cancellableCall(socket, method, params, signal);
  const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(45000) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string; diagnosticId?: string } };
  if (!result.ok) throw new OrbitError(result.error?.code ?? "BROKER_ERROR", result.error?.message ?? "Broker failed", result.error?.diagnosticId);
  return result.result;
}
