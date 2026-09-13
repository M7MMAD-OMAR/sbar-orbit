import { mkdir, open, rename, lstat, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { OrbitError } from "./errors";
import { version } from "../package.json";

const methods = new Set(['doctor', 'session.create', 'session.list', 'session.act', 'session.pause', 'session.resume', 'session.stop', 'session.observe', 'session.presence', 'session.control', 'session.account.save', 'session.journal', 'session.narrow', 'session.restore', 'backend.exit', 'preview.open', 'viewer.browsers']);
const actions = new Set(['navigate', 'fill', 'click', 'read', 'open-tab', 'select-tab', 'close-tab', 'launch', 'scroll', 'pointer', 'resize', 'window', 'text', 'paste', 'key']);
const codes = new Set(['INVALID_REQUEST', 'UNSUPPORTED', 'SESSION_NOT_FOUND', 'SESSION_CLOSED', 'PAUSED', 'NOT_PAUSED', 'PROFILE_BUSY', 'REQUEST_CONFLICT', 'POLICY_DENIED', 'BACKEND_ERROR', 'BACKEND_FAILED', 'DEADLINE_EXCEEDED', 'SESSION_LIMIT', 'RESOURCE_LIMIT', 'TIMEOUT', 'RESOURCE_LIMIT_REQUIRED']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
export const diagnosticRoot = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'sbar-orbit', 'diagnostics');
export interface DiagnosticEvent {
  at: string; traceId: string; method: string; action?: string; session?: string; request?: string;
  outcome: 'started' | 'ok' | 'error'; durationMs?: number; code?: string; backend?: string;
}

// Only enumerated metadata crosses this boundary. Never serialize request objects or errors.
export class Diagnostics {
  private tail: Promise<void> = Promise.resolve();
  private failedWrites = 0;
  private failedReads = 0;
  private recent: DiagnosticEvent[] = [];
  constructor(readonly root: string, private maxBytes = 1024 * 1024) {}
  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe diagnostic directory');
    await chmod(this.root, 0o700);
  }
  private async read(name: string) {
    const file = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > this.maxBytes + 4096) throw new Error('Invalid diagnostic file');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }
  private record(event: DiagnosticEvent) {
    this.recent.push(event);
    if (this.recent.length > 1000) this.recent.shift();
    this.tail = this.tail.then(async () => {
      await this.directory();
      const path = join(this.root, 'events.jsonl');
      const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Unsafe diagnostic file');
      const line = JSON.stringify(event) + '\n';
      if (info && info.size + Buffer.byteLength(line) > this.maxBytes) await rename(path, join(this.root, 'events.previous.jsonl'));
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try { await file.chmod(0o600); await file.writeFile(line); } finally { await file.close(); }
    }).catch(() => { this.failedWrites++; });
    return this.tail;
  }
  async run(value: unknown, work: () => Promise<unknown>) {
    const input = object(value), params = object(input.params), action = object(params.action ?? params.input);
    const event: DiagnosticEvent = { at: new Date().toISOString(), traceId: crypto.randomUUID(),
      method: methods.has(String(input.method)) ? String(input.method) : 'unknown',
      ...(actions.has(String(action.type)) ? { action: String(action.type) } : {}),
      ...(['browser', 'fedora', 'system'].includes(String(params.backend)) ? { backend: String(params.backend) } : {}),
      session: hash(params.sessionId), request: hash(params.requestId), outcome: 'started' };
    const start = performance.now();
    await this.record(event);
    try {
      const result = await work();
      await this.record({ ...event, at: new Date().toISOString(), session: event.session ?? hash(object(result).sessionId), outcome: 'ok', durationMs: Math.round(performance.now() - start) });
      return result;
    } catch (error) {
      const code = error instanceof OrbitError && codes.has(error.code) ? error.code : 'BACKEND_ERROR';
      await this.record({ ...event, at: new Date().toISOString(), outcome: 'error', code, durationMs: Math.round(performance.now() - start) });
      throw new OrbitError(error instanceof OrbitError ? error.code : 'BACKEND_ERROR', error instanceof OrbitError ? error.message : 'Request failed', event.traceId);
    }
  }
  async report() {
    await this.tail;
    const events: DiagnosticEvent[] = [];
    for (const name of ['events.previous.jsonl', 'events.jsonl']) {
      try {
        for (const line of (await this.read(name)).split('\n').filter(Boolean)) {
          try {
            // Rebuild from an allowlist even on read: disk data is not trusted report content.
            const e = object(JSON.parse(line));
            if (!/^[a-f0-9-]{36}$/.test(String(e.traceId)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(e.at))) continue;
            if (!['started', 'ok', 'error'].includes(String(e.outcome))) continue;
            events.push({ at: String(e.at), traceId: String(e.traceId), method: methods.has(String(e.method)) ? String(e.method) : 'unknown', outcome: e.outcome as DiagnosticEvent['outcome'],
              ...(actions.has(String(e.action)) ? { action: String(e.action) } : {}),
              ...(['browser', 'fedora', 'system'].includes(String(e.backend)) ? { backend: String(e.backend) } : {}),
              ...(/^[a-f0-9]{16}$/.test(String(e.session)) ? { session: String(e.session) } : {}),
              ...(/^[a-f0-9]{16}$/.test(String(e.request)) ? { request: String(e.request) } : {}),
              ...(codes.has(String(e.code)) ? { code: String(e.code) } : {}),
              ...(typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0 ? { durationMs: e.durationMs } : {}) });
          } catch { this.failedReads++; }
        }
      } catch (error) { if (object(error).code !== 'ENOENT') this.failedReads++; }
    }
    const seen = new Set(events.map(e => `${e.traceId}:${e.outcome}`));
    events.push(...this.recent.filter(e => !seen.has(`${e.traceId}:${e.outcome}`)));
    const report = { schemaVersion: 1, reportId: crypto.randomUUID(), generatedAt: new Date().toISOString(), orbitVersion: version,
      platform: process.platform, architecture: process.arch,
      collection: { failedWrites: this.failedWrites, failedReads: this.failedReads, retainedEvents: events.length, maxBytesPerFile: this.maxBytes, files: 2,
        coverage: 'Orbit dispatch metadata only. Browser content, arguments, native stderr and host activity are not collected. Starts without outcomes may indicate interruption or an operation still running. Old events rotate out.' },
      events };
    const latest = events.findLast(e => e.outcome === 'error');
    const summary = { ...report, events: [...events.filter(e => e.outcome === 'error').slice(-3), ...events.slice(-3)] };
    const issue = new URL('https://github.com/M7MMAD-OMAR/sbar-orbit/issues/new');
    issue.searchParams.set('title', latest ? `Orbit: ${latest.method} ${latest.action ?? ''} ${latest.code ?? 'error'}` : 'Orbit problem report');
    for (;;) {
      issue.searchParams.set('body', `Orbit prepared this diagnostic summary. Optional: describe what you expected.\n\nFull bounded history is available with Download report.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
      if (issue.href.length <= 7000 || !summary.events.length) break;
      summary.events.pop();
    }
    return { ...report, issueUrl: issue.href };
  }
  async flush() { await this.tail; }
  status() { return { latestErrorId: this.recent.findLast(event => event.outcome === 'error')?.traceId, failedWrites: this.failedWrites }; }
}
