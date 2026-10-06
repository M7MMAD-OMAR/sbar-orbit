// Opt-in records for a fresh disposable installed fixture, never a general log path.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const rootKey = "ORBIT_TEST_INSTALLED_STARTUP_ROOT", bindingKey = "ORBIT_TEST_INSTALLED_STARTUP_BINDING";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const recordLimit = 1024, byteLimit = 1048576;
type Fields = Record<string, unknown>;
type Environment = Record<string, string | undefined>;
type Context = { platform: string; runtime: string };
export type InstalledStartupWindow = { token: string; tokenWriteReturned: boolean; beforeReportWriteReturned: boolean; afterStarted: boolean };
export function createInstalledStartupWindow(): InstalledStartupWindow {
  return { token: sha(crypto.randomUUID()), tokenWriteReturned: false, beforeReportWriteReturned: false, afterStarted: false };
}
function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function plain(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }
function numbers(value: unknown, keys: string[]) {
  const from = plain(value), result: Fields = {};
  for (const key of keys) if (typeof from[key] === "number" && Number.isFinite(from[key]) && (from[key] as number) >= 0) result[key] = from[key];
  return result;
}
const executableLimits = { bytes: 256 * 1024 * 1024, chunks: 256, elapsedMs: 1000 };
/** Opt-in executable hashing perturbs timing; its elapsed limit cannot interrupt synchronous IO. */
export function installedExecutableIdentity(executable: string, limits = executableLimits, clock = () => performance.now()): Fields {
  const at = clock(), result: Fields = { complete: false, readFailed: false, typeFailed: false, overflow: false, changed: false,
    closeFailed: false, slow: false, bytes: 0, chunks: 0, maxBytes: limits.bytes, maxChunks: limits.chunks, maxElapsedMs: limits.elapsedMs };
  let fd: number | undefined;
  try {
    if (!isAbsolute(executable) || lstatSync(executable).isSymbolicLink()) { result.typeFailed = true; throw new Error("Executable type unavailable"); }
    const canonical = realpathSync(executable);
    const pathBefore = lstatSync(canonical);
    if (!pathBefore.isFile()) { result.typeFailed = true; throw new Error("Executable type unavailable"); }
    fd = openSync(canonical, "r"); const before = fstatSync(fd);
    if (before.ino !== pathBefore.ino || before.dev !== pathBefore.dev || realpathSync(executable) !== canonical) { result.changed = true; throw new Error("Executable identity changed"); }
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) { result.typeFailed = true; throw new Error("Executable type unavailable"); }
    result.canonicalSha256 = sha(canonical);
    if (before.size > limits.bytes) { result.overflow = true; return result; }
    const digest = createHash("sha256"), buffer = Buffer.alloc(Math.min(1048576, limits.bytes));
    let bytes = 0, chunks = 0;
    while (bytes < before.size) {
      if (chunks >= limits.chunks || bytes >= limits.bytes) { result.overflow = true; break; }
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - bytes, limits.bytes - bytes), bytes);
      if (length === 0) { result.readFailed = true; break; }
      digest.update(buffer.subarray(0, length)); bytes += length; chunks++; result.bytes = bytes; result.chunks = chunks;
    }
    result.bytes = bytes; result.chunks = chunks;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(canonical);
    result.changed = before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev ||
      pathAfter.isSymbolicLink() || pathAfter.ino !== after.ino || pathAfter.dev !== after.dev || realpathSync(executable) !== canonical;
    if (bytes === before.size && result.overflow === false && result.readFailed === false && result.changed === false) result.sha256 = digest.digest("hex");
  } catch { result.readFailed = true; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { result.closeFailed = true; } }
    result.elapsedMs = clock() - at;
    result.slow = typeof result.elapsedMs !== "number" || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 || result.elapsedMs > limits.elapsedMs;
    result.complete = result.readFailed === false && result.typeFailed === false && result.overflow === false && result.changed === false && result.closeFailed === false && result.slow === false && typeof result.sha256 === "string";
  }
  return result;
}
function executableProjection(value: unknown): Fields {
  const source = plain(value), result = numbers(source, ["bytes", "chunks", "elapsedMs", "maxBytes", "maxChunks", "maxElapsedMs"]);
  for (const key of ["complete", "readFailed", "typeFailed", "overflow", "changed", "closeFailed", "slow"]) if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of ["sha256", "canonicalSha256"]) if (typeof source[key] === "string" && /^[a-f0-9]{64}$/.test(source[key])) result[key] = source[key];
  return result;
}
export function installedStartupProjection(value: unknown): Fields {
  const source = plain(value), result = numbers(source, ["elapsedMs", "waitMs", "rootPid", "stderrBytes", "stderrTailBytes", "stderrChunks", "polls", "maxPollGapMs", "sequence", "monotonicMs", "collectionElapsedMs", "initializationElapsedMs", "stopAttempt", "producerPid"]);
  if (["startup snapshot", "owned stop"].includes(String(source.origin))) result.origin = source.origin;
  for (const key of ["phase", "endpointState", "stderrCategory"]) {
    const allowed = key === "phase" ? ["runtime", "assigned", "poll", "stderr", "stderr ended", "stderr failed", "before stop", "stop confirmed", "stop incomplete"]
      : key === "endpointState" ? ["not checked", "missing", "invalid contents", "read failed", "published"]
      : ["endpoint announcement", "resource complaint", "other stderr"];
    if (typeof source[key] === "string" && allowed.includes(source[key])) result[key] = source[key];
  }
  for (const key of ["rootExitCode"]) if (source[key] === null || typeof source[key] === "number" && Number.isSafeInteger(source[key])) result[key] = source[key];
  for (const key of ["stderrEnded", "stderrFailed", "cpuCapEnforced"]) if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of ["stderrSha256", "browserSha256", "bunSha256", "runtimeSha256", "chromeSha256", "launchId", "windowToken"])
    if (typeof source[key] === "string" && /^[a-f0-9]{64}$/.test(source[key])) result[key] = source[key];
  if (source.producerExecutable !== undefined) result.producerExecutable = executableProjection(source.producerExecutable);
  result.budget = numbers(source.budget, ["memoryBytes", "cpuCycleSharePercent", "activeProcesses"]);
  result.accounting = numbers(source.accounting, ["userMs", "kernelMs", "pageFaults", "totalProcesses", "activeProcesses", "terminatedProcesses", "peakJobMemoryBytes"]);
  const clean = plain(source.cleanup), cleanup: Fields = {};
  for (const key of ["confirmed", "handleClosed"]) if (typeof clean[key] === "boolean") cleanup[key] = clean[key];
  if (clean.rootExitCode === null || typeof clean.rootExitCode === "number" && Number.isSafeInteger(clean.rootExitCode)) cleanup.rootExitCode = clean.rootExitCode;
  const members = (value: unknown, target: Fields, sourceRows: unknown) => {
    if (value === undefined && sourceRows === undefined) return;
    const containerValid = Array.isArray(value), rows: unknown[] = Array.isArray(value) ? value : [];
    const retained: number[] = []; let rejectedRows = 0;
    const examinedRows = Math.min(rows.length, 512);
    for (let index = 0; index < examinedRows; index++) {
      const pid = rows[index];
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) retained.push(pid);
      else rejectedRows++;
    }
    const sourceRowsValid = sourceRows === undefined || typeof sourceRows === "number" && Number.isSafeInteger(sourceRows) && sourceRows >= rows.length;
    const inputRows = sourceRowsValid && typeof sourceRows === "number" ? sourceRows : rows.length;
    const truncatedRows = inputRows - examinedRows;
    target.members = retained;
    target.membershipProjection = { containerValid, inputRows, examinedRows, retainedRows: retained.length,
      rejectedRows, truncatedRows, invalid: !containerValid || !sourceRowsValid || rejectedRows > 0 || truncatedRows > 0 };
  };
  members(source.members, result, source.membershipSourceRows); members(clean.members, cleanup, clean.membershipSourceRows);
  result.cleanup = cleanup;
  for (const key of ["accountingError", "membershipError", "membership"])
    if (["query failed", "not measured after handle closure"].includes(String(source[key]))) result[key] = source[key];
  return result;
}

/** Pure admission accepts an explicit context for controls, not a provider verdict. */
export function admitInstalledStartup(env: Environment, context: Context): string | undefined {
  try {
    const root = env[rootKey], binding = env[bindingKey];
    if (context.platform !== "win32" || env.GITHUB_ACTIONS !== "true" || env.ORBIT_TEST_NATIVE === "1" ||
      !root || !isAbsolute(root) || realpathSync(root) !== root || !basename(root).startsWith("orbit installed acceptance ") ||
      lstatSync(root).isSymbolicLink() || !binding || !/^[a-f0-9]{64}$/.test(binding)) return;
    const admission = join(root, "startup-admission.json"), sink = join(root, "startup-trace.jsonl"), status = join(root, "startup-trace-status.json"), ack = join(root, "startup-trace-ack.json"), window = join(root, "startup-expected-window.json");
    for (const path of [admission, sink, status, ack, window]) if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) return;
    const bytes = readFileSync(admission); if (sha(bytes) !== binding) return;
    const declared: unknown = JSON.parse(bytes.toString()); const owner = plain(declared);
    const runtime = realpathSync(context.runtime);
    if (owner.root !== root || owner.source !== join(root, "package") || owner.prefix !== join(root, "prefix") ||
      !inside(join(root, "package"), runtime)) return;
    return root;
  } catch { return; }
}
export function installedStartupEnvironment(launcher: string): Record<string, string> {
  try {
    const root = admitInstalledStartup(process.env, { platform: process.platform, runtime: import.meta.path });
    if (!root || !inside(join(root, "prefix"), realpathSync(launcher))) return {};
    return { GITHUB_ACTIONS: "true", ORBIT_TEST_NATIVE: "0", [rootKey]: root, [bindingKey]: process.env[bindingKey] ?? "" };
  } catch { return {}; }
}
export async function prepareInstalledStartup(root: string, source: string, prefix: string): Promise<Record<string, string>> {
  const canonical = realpathSync(root);
  if (canonical !== root || lstatSync(root).isSymbolicLink() || !basename(root).startsWith("orbit installed acceptance ") || realpathSync(source) !== join(root, "package") || resolve(prefix) !== join(root, "prefix")) throw new Error("Fixture ownership mismatch");
  const bytes = JSON.stringify({ root: canonical, source: realpathSync(source), prefix: resolve(prefix) });
  await writeFile(join(canonical, "startup-admission.json"), bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(canonical, "startup-trace.jsonl"), "", { flag: "wx", mode: 0o600 });
  await writeFile(join(canonical, "startup-trace-status.json"), "{}", { flag: "wx", mode: 0o600 });
  await writeFile(join(canonical, "startup-trace-ack.json"), "", { flag: "wx", mode: 0o600 });
  await writeFile(join(canonical, "startup-expected-window.json"), "{}", { flag: "wx", mode: 0o600 });
  return { [rootKey]: canonical, [bindingKey]: sha(bytes) };
}

export class InstalledStartupWriter {
  private closed = false;
  private digest = createHash("sha256");
  acknowledgementWriteFailed = false;
  readonly status: { records: number; bytes: number; droppedRecords: number; invalidMembershipRecords: number; overflow: boolean; writeFailed: boolean; collectionElapsedMs: number; sealed: boolean; seal?: Fields } = { records: 0, bytes: 0, droppedRecords: 0, invalidMembershipRecords: 0, overflow: false, writeFailed: false, collectionElapsedMs: 0, sealed: false };
  constructor(private append: (text: string) => void, private statusWrite: (value: string) => void,
    private limit = { records: recordLimit, bytes: byteLimit }, private acknowledge?: (value: string) => void) {}
  emit(value: unknown) {
    // A terminal writer accepts no further observations. The seal covers its closed finite window.
    if (this.closed) return;
    const at = performance.now();
    try {
      const projected = installedStartupProjection(value);
      if (plain(projected.membershipProjection).invalid === true || plain(plain(projected.cleanup).membershipProjection).invalid === true) this.status.invalidMembershipRecords++;
      const text = JSON.stringify({ installedStartup: projected }) + "\n";
      if (this.status.records >= this.limit.records || this.status.bytes + Buffer.byteLength(text) > this.limit.bytes) {
        this.status.overflow = true; this.status.droppedRecords++;
      } else {
        this.append(text); this.digest.update(text); this.status.records++; this.status.bytes += Buffer.byteLength(text);
      }
    } catch { this.status.writeFailed = true; }
    this.status.collectionElapsedMs += performance.now() - at;
    const statusAt = performance.now();
    try { this.statusWrite(JSON.stringify(this.status)); } catch { this.status.writeFailed = true; }
    this.status.collectionElapsedMs += performance.now() - statusAt;
  }
  complete(proof: Fields) {
    if (this.closed) return;
    this.closed = true;
    const clean = !this.status.overflow && !this.status.writeFailed && this.status.droppedRecords === 0 && this.status.invalidMembershipRecords === 0;
    const ready = proof.startupCompleted === true && proof.closeCompleted === true && proof.stderrSettled === true && proof.stderrFailed === false && proof.pendingStops === 0 &&
      ["windowToken", "launchId"].every(key => typeof proof[key] === "string" && /^[a-f0-9]{64}$/.test(String(proof[key]))) &&
      ["producerPid", "rootPid", "stopAttempt"].every(key => typeof proof[key] === "number" && Number.isSafeInteger(proof[key]) && Number(proof[key]) > 0) && proof.finalSequence === this.status.records;
    if (clean && ready && this.status.records > 0) {
      this.status.sealed = true;
      this.status.seal = { startupCompleted: true, closeCompleted: true, stderrSettled: true, stderrFailed: false, pendingStops: 0,
        window: "owned startup through completed close and stderr", windowToken: proof.windowToken, launchId: proof.launchId,
        producerPid: proof.producerPid, rootPid: proof.rootPid, stopAttempt: proof.stopAttempt, finalSequence: proof.finalSequence,
        records: this.status.records, bytes: this.status.bytes, traceSha256: this.digest.copy().digest("hex") };
    }
    const finalStatus = JSON.stringify(this.status);
    try { this.statusWrite(finalStatus); }
    catch { this.status.writeFailed = true; this.status.sealed = false; return; }
    if (!this.status.sealed) return;
    const seal = plain(this.status.seal);
    // This witness exists only after the earlier seal write returned. It does not attest its own write return.
    const ack = { schemaVersion: 1, attests: "prior seal persistence returned", sealStatusSha256: sha(finalStatus),
      windowToken: seal.windowToken, launchId: seal.launchId, producerPid: seal.producerPid, rootPid: seal.rootPid,
      stopAttempt: seal.stopAttempt, finalSequence: seal.finalSequence, traceSha256: seal.traceSha256, records: seal.records, bytes: seal.bytes };
    try { this.acknowledge?.(JSON.stringify(ack)); }
    catch { this.acknowledgementWriteFailed = true; }
  }
}
/** Observe settlement without replacing the actual owned stop promise or its error. */
export function observeInstalledStop<T>(operation: () => Promise<T>, observe: (phase: string, attempt: number) => void) {
  let attempts = 0;
  return () => {
    const attempt = ++attempts;
    const record = (phase: string) => { try { observe(phase, attempt); } catch {} };
    record("before stop");
    let result: Promise<T>;
    try { result = operation(); } catch (error) { record("stop incomplete"); throw error; }
    void result.then(() => record("stop confirmed"), () => record("stop incomplete"));
    return result;
  };
}
/** Pure lifecycle state used by the actual opt-in trace, without operation or promise ownership. */
export function installedStartupCompletion(seal: (proof: Fields) => void) {
  let startupCompleted = false, closeCompleted = false, stderrSettled = false, stderrFailed = false, closed = false, invalid = false;
  let rootPid: number | undefined, lastAttempt = 0, latestStop: Fields | undefined;
  const pendingStops = new Set<number>();
  const complete = () => {
    const cleanup = plain(latestStop?.cleanup);
    if (closed || invalid || !startupCompleted || !closeCompleted || !stderrSettled || stderrFailed || pendingStops.size !== 0 ||
        latestStop?.phase !== "stop confirmed" || cleanup.confirmed !== true || cleanup.handleClosed !== true ||
        typeof cleanup.rootExitCode !== "number" || !Number.isSafeInteger(cleanup.rootExitCode)) return;
    closed = true;
    try { seal({ startupCompleted, closeCompleted, stderrSettled, stderrFailed, pendingStops: pendingStops.size, rootPid, stopAttempt: latestStop.stopAttempt }); } catch {}
  };
  return {
    closed: () => closed,
    record(value: Fields) {
      if (closed) return;
      if (value.phase === "assigned") {
        if (rootPid !== undefined || typeof value.rootPid !== "number" || !Number.isSafeInteger(value.rootPid) || value.rootPid <= 0) invalid = true;
        else rootPid = value.rootPid;
      }
      if (value.origin !== "owned stop") return;
      const attempt = value.stopAttempt;
      if (rootPid === undefined || value.rootPid !== rootPid || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt <= 0) { invalid = true; return; }
      if (value.phase === "before stop") {
        if (pendingStops.size !== 0 || attempt <= lastAttempt) invalid = true;
        pendingStops.add(attempt); lastAttempt = attempt; latestStop = undefined;
      } else if (["stop confirmed", "stop incomplete"].includes(String(value.phase))) {
        if (!pendingStops.has(attempt)) invalid = true;
        pendingStops.delete(attempt); latestStop = value;
      }
    },
    startupComplete() { if (closed) return; startupCompleted = true; complete(); },
    closeComplete() { if (closed) return; closeCompleted = true; complete(); },
    stderrComplete(failed: boolean) { if (closed) return; stderrSettled = true; stderrFailed = failed; complete(); },
  };
}
export function installedStartupTrace(executable: string) {
  try {
    const initializationAt = performance.now();
    const root = admitInstalledStartup(process.env, { platform: process.platform, runtime: import.meta.path });
    if (!root) return;
    const sink = join(root, "startup-trace.jsonl"), status = join(root, "startup-trace-status.json"), ackPath = join(root, "startup-trace-ack.json");
    const expectedPath = join(root, "startup-expected-window.json");
    if (lstatSync(expectedPath).isSymbolicLink() || realpathSync(expectedPath) !== expectedPath) return;
    if (!lstatSync(expectedPath).isFile() || lstatSync(expectedPath).size > 256) return;
    const windowToken = plain(JSON.parse(readFileSync(expectedPath, "utf8"))).windowToken;
    if (typeof windowToken !== "string" || !/^[a-f0-9]{64}$/.test(windowToken)) return;
    // One controlled startup attempt per caller window. A previous closed window cannot be resumed.
    if (lstatSync(ackPath).isSymbolicLink() || realpathSync(ackPath) !== ackPath || lstatSync(ackPath).size !== 0) return;
    const writer = new InstalledStartupWriter(text => {
      if (lstatSync(sink).isSymbolicLink() || realpathSync(sink) !== sink) throw new Error("Owned sink changed");
      appendFileSync(sink, text);
    }, value => {
      if (lstatSync(status).isSymbolicLink() || realpathSync(status) !== status) throw new Error("Owned status changed");
      writeFileSync(status, value);
    }, { records: recordLimit, bytes: byteLimit }, value => {
      if (lstatSync(ackPath).isSymbolicLink() || realpathSync(ackPath) !== ackPath || lstatSync(ackPath).size !== 0) throw new Error("Owned acknowledgement changed");
      if (Buffer.byteLength(value) > 4096) throw new Error("Owned acknowledgement overflow");
      writeFileSync(ackPath, value);
    });
    let sequence = 0;
    const launchId = sha(crypto.randomUUID());
    const completion = installedStartupCompletion(proof => writer.complete({ ...proof,
      windowToken, launchId, producerPid: process.pid, finalSequence: sequence }));
    const emit = (value: Fields) => {
      if (completion.closed()) return;
      const terminal = value.origin === "owned stop" && ["stop confirmed", "stop incomplete"].includes(String(value.phase));
      writer.emit({ ...value, ...(terminal ? { producerExecutable: installedExecutableIdentity(process.execPath) } : {}),
        windowToken, launchId, producerPid: process.pid, sequence: ++sequence, monotonicMs: performance.now(), collectionElapsedMs: writer.status.collectionElapsedMs });
      completion.record(value);
    };
    const stream = createHash("sha256"); let chunks = 0, bytes = 0;
    const identities = { browserSha256: sha(readFileSync(executable)), producerExecutable: installedExecutableIdentity(process.execPath), runtimeSha256: sha(readFileSync(import.meta.path)), chromeSha256: sha(readFileSync(join(import.meta.dir, "chrome.ts"))) };
    emit({ phase: "runtime", ...identities, initializationElapsedMs: performance.now() - initializationAt });
    return { emit,
      startupComplete: completion.startupComplete,
      closeComplete: completion.closeComplete,
      end(rootPid: number, failed: boolean) {
      try { emit({ phase: failed ? "stderr failed" : "stderr ended", rootPid, stderrChunks: chunks, stderrBytes: bytes, stderrSha256: stream.copy().digest("hex"), stderrEnded: !failed, stderrFailed: failed }); } catch { writer.status.writeFailed = true; }
      completion.stderrComplete(failed);
    }, stderr(chunk: Uint8Array, rootPid: number) {
      try {
        stream.update(chunk); chunks++; bytes += chunk.byteLength;
        const text = new TextDecoder().decode(chunk);
        emit({ phase: "stderr", rootPid, stderrChunks: chunks, stderrBytes: bytes, stderrSha256: stream.copy().digest("hex"),
          stderrCategory: /DevTools listening/.test(text) ? "endpoint announcement" : /memory|resource|allocation/i.test(text) ? "resource complaint" : "other stderr" });
      } catch { writer.status.writeFailed = true; }
    } };
  } catch { return; }
}

async function runtimeInventory(directory: string, root: string) {
  const files: Record<string, { sha256: string; mode: number; bytes: number; kind: string }> = {};
  let totalBytes = 0, count = 0;
  async function walk(path: string) {
    const info = await lstat(path);
    if (++count > 50000) throw new Error("Runtime inventory exceeds bound");
    if (info.isSymbolicLink()) {
      if (!inside(root, realpathSync(path))) throw new Error("Runtime link escapes fixture");
      const target = await readlink(path);
      files[relative(directory, path)] = { sha256: sha(target), mode: info.mode, bytes: Buffer.byteLength(target), kind: "link" }; return;
    }
    if (info.isDirectory()) {
      files[relative(directory, path)] = { sha256: sha(""), mode: info.mode, bytes: 0, kind: "directory" };
      for (const name of (await readdir(path)).sort()) await walk(join(path, name)); return;
    }
    if (!info.isFile() || totalBytes + info.size > 4 * 1073741824) throw new Error("Runtime inventory exceeds bound");
    const hasher = createHash("sha256"); for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    files[relative(directory, path)] = { sha256: hasher.digest("hex"), mode: info.mode, bytes: info.size, kind: "file" }; totalBytes += info.size;
  }
  await walk(directory); return { files, totalBytes, entries: count, sha256: sha(JSON.stringify(files)) };
}
// Metadata commands only, never execute the browser. Timeout and output bounds are owned.
async function metadata(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", timeout: 10000 });
  let text = "", exceeded = false;
  for await (const chunk of child.stdout) {
    if (Buffer.byteLength(text) + chunk.byteLength > 1048576) { exceeded = true; child.kill(); break; }
    text += new TextDecoder().decode(chunk);
  }
  const code = await child.exited;
  if (exceeded || code !== 0) throw new Error("Metadata unavailable");
  return text.trim();
}
export function taskEnvironmentMatches(xml: string, env: Record<string, string>, launcher: string) {
  const encoded = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1];
  if (encoded === undefined) return false;
  const entities: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
  const actual = encoded.replace(/&(quot|apos|lt|gt|amp);/g, (_, key: string) => entities[key] ?? "");
  const prefix = Object.entries(env).map(([key, value]) => `set "${key}=${value}" && `).join("");
  return actual === `/c ${prefix}"${launcher}" serve --managed-socket`;

}
/** Shared final gate keeps transport retention distinct from lossless typed membership. */
export function installedTraceRetentionComplete(rows: Fields[], status: unknown, bytes: number, acknowledgement?: unknown, expectedWindowToken?: string, rawTrace?: Uint8Array, rawStatus?: Uint8Array) {
  const retention = plain(status);
  const seal = plain(retention.seal), ack = plain(acknowledgement);
  const tokenBound = typeof expectedWindowToken === "string" && /^[a-f0-9]{64}$/.test(expectedWindowToken) && seal.windowToken === expectedWindowToken && ack.windowToken === expectedWindowToken;
  const observedBytes = rawTrace instanceof Uint8Array && rawStatus instanceof Uint8Array && rawTrace.byteLength === bytes;
  const acknowledged = observedBytes && ack.schemaVersion === 1 && ack.attests === "prior seal persistence returned" && ack.sealStatusSha256 === sha(rawStatus) &&
    ["launchId", "producerPid", "rootPid", "stopAttempt", "finalSequence", "traceSha256", "records", "bytes"].every(key => ack[key] === seal[key]);
  const terminal = rows.filter(row => row.origin === "owned stop" && row.phase === "stop confirmed").at(-1);
  const identity = typeof seal.launchId === "string" && /^[a-f0-9]{64}$/.test(seal.launchId) && typeof seal.producerPid === "number" && Number.isSafeInteger(seal.producerPid) && seal.producerPid > 0;
  return rows.length > 0 && tokenBound && acknowledged && retention.sealed === true && identity && seal.window === "owned startup through completed close and stderr" &&
    seal.startupCompleted === true && seal.closeCompleted === true && seal.stderrSettled === true && seal.stderrFailed === false && seal.pendingStops === 0 &&
    seal.records === rows.length && seal.bytes === bytes && seal.finalSequence === rows.length && rawTrace instanceof Uint8Array && seal.traceSha256 === sha(rawTrace) &&
    terminal !== undefined && terminal.rootPid === seal.rootPid && terminal.stopAttempt === seal.stopAttempt &&
    rows.some(row => row.phase === "stderr ended" && row.rootPid === seal.rootPid) &&
    rows.every((row, index) => row.sequence === index + 1 && row.windowToken === expectedWindowToken && row.launchId === seal.launchId && row.producerPid === seal.producerPid) &&
    retention.records === rows.length && retention.bytes === bytes &&
    retention.overflow === false && retention.writeFailed === false && retention.droppedRecords === 0 &&
    retention.invalidMembershipRecords === 0 && rows.every(row => plain(row.membershipProjection).invalid !== true &&
      plain(plain(row.cleanup).membershipProjection).invalid !== true);
}
/** Readiness describes retained protocol evidence, never an operation/provider verdict. */
export function installedStartupAttribution(rows: Fields[]) {
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const membership = (row: Fields) => Array.isArray(row.members) && plain(row.membershipProjection).invalid === false;
  const roots = new Map<number, { assigned: Fields; index: number; endpoint: boolean; before?: { index: number; attempt: number }; latest?: Fields; lastAttempt?: number }>();
  let runtimeCount = 0, pendingRuntime = 0, consistent = true;
  for (const [index, row] of rows.entries()) {
    if (row.phase === "runtime") { runtimeCount++; pendingRuntime++; continue; }
    const pid = row.rootPid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) { consistent = false; continue; }
    if (row.phase === "assigned") {
      if (roots.has(pid) || pendingRuntime === 0) { consistent = false; continue; }
      pendingRuntime--;
      roots.set(pid, { assigned: row, index, endpoint: false });
    }
  }
  // Only root rows belonging to an actual assignment can contribute to attribution.
  for (const [index, row] of rows.entries()) {
    if (row.phase === "runtime" || row.phase === "assigned") continue;
    const root = typeof row.rootPid === "number" ? roots.get(row.rootPid) : undefined;
    if (!root) { consistent = false; continue; }
    if (row.phase === "poll" || row.phase === "before stop" && row.origin === "startup snapshot") {
      if (index <= root.index || root.before !== undefined || row.phase === "poll" && root.latest !== undefined) consistent = false;
      if (["missing", "invalid contents", "read failed", "published"].includes(String(row.endpointState)) &&
        nonnegative(row.elapsedMs) && nonnegative(row.waitMs) && nonnegative(row.maxPollGapMs) &&
        typeof row.polls === "number" && Number.isSafeInteger(row.polls) && row.polls > 0 && index > root.index)
        root.endpoint = true;
    }
    if (["before stop", "stop confirmed", "stop incomplete"].includes(String(row.phase))) {
      if (row.origin === "startup snapshot") { if (index <= root.index) consistent = false; continue; }
      const attempt = row.stopAttempt;
      if (row.origin !== "owned stop" || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt <= 0) { consistent = false; continue; }
      if (row.phase === "before stop") {
        // Snapshot records are separate; only actual stop invocations form attempt pairs.
        if (root.before !== undefined || index <= root.index || root.lastAttempt !== undefined && attempt <= root.lastAttempt) consistent = false;
        root.before = { index, attempt }; root.lastAttempt = attempt; root.latest = undefined;
      } else {
        if (!root.before || root.before.index >= index || root.before.attempt !== attempt) consistent = false;
        root.latest = row; root.before = undefined;
      }
    }
  }
  const everyRoot = (accept: (root: { assigned: Fields; index: number; endpoint: boolean; before?: { index: number; attempt: number }; latest?: Fields; lastAttempt?: number }) => boolean) =>
    consistent && roots.size > 0 && [...roots.values()].every(accept);
  const jobRowsReady = everyRoot(({ assigned: row }) => membership(row) && Array.isArray(row.members) && row.members.includes(row.rootPid) &&
    row.membershipError === undefined && row.accountingError === undefined &&
    ["userMs", "kernelMs", "activeProcesses", "peakJobMemoryBytes"].every(key => nonnegative(plain(row.accounting)[key])) &&
    ["memoryBytes", "cpuCycleSharePercent", "activeProcesses"].every(key => nonnegative(plain(row.budget)[key])));
  const cleanupAttemptObserved = everyRoot(root => root.before !== undefined || root.latest !== undefined);
  const cleanupAttributionReady = everyRoot(root => {
    const row = root.latest;
    if (!row || root.before !== undefined || row.membershipError !== undefined || row.accountingError !== undefined) return false;
    const clean = plain(row.cleanup);
    return membership(clean) && typeof clean.confirmed === "boolean" && typeof clean.handleClosed === "boolean" &&
      (clean.rootExitCode === null || typeof clean.rootExitCode === "number" && Number.isSafeInteger(clean.rootExitCode));
  });
  const cleanupConfirmed = cleanupAttributionReady && everyRoot(root => {
    const row = root.latest, clean = plain(row?.cleanup);
    return row?.phase === "stop confirmed" && clean.confirmed === true && clean.handleClosed === true &&
      typeof clean.rootExitCode === "number" && Number.isSafeInteger(clean.rootExitCode) && Array.isArray(clean.members) && clean.members.length === 0;
  });
  return { startupAttributionReady: runtimeCount > 0 && runtimeCount === roots.size && pendingRuntime === 0 && jobRowsReady && everyRoot(root => root.endpoint),
    cleanupAttemptObserved, cleanupAttributionReady, cleanupConfirmed };
}
/** Selected producer identity is distinct from collector identity and task/source provenance. */
export function installedProducerBinding(rows: Fields[]) {
  const runtimes = rows.filter(row => row.phase === "runtime"), assigned = rows.filter(row => row.phase === "assigned");
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const ready = (value: unknown) => {
    const identity = plain(value);
    return identity.complete === true && ["readFailed", "typeFailed", "overflow", "changed", "closeFailed", "slow"].every(key => identity[key] === false) &&
      digest(identity.sha256) && digest(identity.canonicalSha256) && positive(identity.bytes) && positive(identity.chunks) &&
      identity.maxBytes === executableLimits.bytes && identity.maxChunks === executableLimits.chunks && identity.maxElapsedMs === executableLimits.elapsedMs &&
      typeof identity.elapsedMs === "number" && Number.isFinite(identity.elapsedMs) && identity.elapsedMs >= 0 && identity.elapsedMs <= executableLimits.elapsedMs &&
      typeof identity.bytes === "number" && identity.bytes <= executableLimits.bytes && typeof identity.chunks === "number" && identity.chunks <= executableLimits.chunks;
  };
  let changed = false;
  const roots = new Map<number, Fields>();
  let bound = runtimes.length > 0 && runtimes.length === assigned.length;
  for (const row of assigned) {
    if (!positive(row.rootPid) || typeof row.rootPid !== "number" || roots.has(row.rootPid)) { bound = false; continue; }
    roots.set(row.rootPid, row);
    const runtimeMatches = runtimes.filter(runtime => digest(row.launchId) && runtime.launchId === row.launchId && positive(row.producerPid) && runtime.producerPid === row.producerPid);
    const runtime = runtimeMatches.length === 1 ? runtimeMatches[0] : undefined;
    const before = plain(runtime?.producerExecutable);
    const owned = rows.filter(event => event.rootPid === row.rootPid && event.origin === "owned stop");
    const latest = owned.at(-1), after = plain(latest?.producerExecutable);
    if (!runtime || rows.indexOf(runtime) >= rows.indexOf(row) || !ready(before) || !latest || !["stop confirmed", "stop incomplete"].includes(String(latest.phase)) || !ready(after)) bound = false;
    if (digest(before.sha256) && digest(after.sha256) && before.sha256 !== after.sha256 ||
      digest(before.canonicalSha256) && digest(after.canonicalSha256) && before.canonicalSha256 !== after.canonicalSha256 ||
      before.changed === true || after.changed === true) changed = true;
    if (before.sha256 !== after.sha256 || before.canonicalSha256 !== after.canonicalSha256 || before.bytes !== after.bytes) bound = false;
    if (rows.some(event => event.launchId === row.launchId && event.producerPid !== row.producerPid ||
      event.rootPid === row.rootPid && (event.launchId !== row.launchId || event.producerPid !== row.producerPid))) bound = false;
  }
  if (rows.some(row => !digest(row.launchId) || !positive(row.producerPid) || !runtimes.some(runtime => runtime.launchId === row.launchId && runtime.producerPid === row.producerPid) ||
    row.phase !== "runtime" && (typeof row.rootPid !== "number" || !roots.has(row.rootPid)))) bound = false;
  return { producerIdentityBound: bound, producerIdentityChanged: changed };
}
export async function collectInstalledStartup(root: string, output: string, stage: "before" | "after", window?: InstalledStartupWindow) {
  const at = performance.now(); const report: Fields = { stage, measured: false, invalid: true, metadataBound: false, startupAttributionReady: false, cleanupAttemptObserved: false, cleanupAttributionReady: false, cleanupConfirmed: false, readFailed: false, outputWriteFailed: false };
  try {
    if (!window || !/^[a-f0-9]{64}$/.test(window.token) || window.afterStarted) throw new Error("Current collection window unavailable");
    if (stage === "after") window.afterStarted = true;
    report.expectedWindowToken = window.token;
    const canonical = realpathSync(root), owner = plain(JSON.parse(await readFile(join(canonical, "startup-admission.json"), "utf8")));
    if (owner.root !== canonical || owner.source !== join(canonical, "package") || owner.prefix !== join(canonical, "prefix")) throw new Error("Fixture ownership mismatch");
    if (stage === "before") {
      const path = join(canonical, "startup-expected-window.json");
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error("Owned expected window changed");
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, windowToken: window.token }));
      window.tokenWriteReturned = true;
    }
    report.package = await runtimeInventory(join(canonical, "package"), canonical);
    report.installed = await runtimeInventory(join(canonical, "prefix"), canonical);
    report.collectorBunSha256 = sha(readFileSync(process.execPath));
    const { defaultChromeExecutable } = await import("./chrome"); const browser = defaultChromeExecutable();
    if (!browser) throw new Error("Browser selection unavailable");
    report.browserSha256 = sha(readFileSync(browser));
    if (process.platform === "win32") {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const version = await metadata([powershell, "-NoProfile", "-NonInteractive", "-Command",
        `$v=(Get-Item -LiteralPath '${browser.replaceAll("'", "''")}').VersionInfo.FileVersion; Write-Output $v`]);
      if (!/^\d+(?:\.\d+){1,4}$/.test(version)) throw new Error("Browser metadata unavailable");
      report.browserFileVersion = version;
      const sidOutput = await metadata(["whoami.exe", "/user", "/fo", "csv", "/nh"]);
      const sid = /(S-1-[0-9-]+)/.exec(sidOutput)?.[1]; if (!sid) throw new Error("Task identity unavailable");
      const { taskNameForUser } = await import("./windows-autostart");
      const xml = await metadata(["schtasks.exe", "/Query", "/TN", taskNameForUser(sid), "/XML"]);
      report.taskXmlSha256 = sha(xml);
      report.taskEnvironmentPresent = taskEnvironmentMatches(xml, { GITHUB_ACTIONS: "true", ORBIT_TEST_NATIVE: "0",
        [rootKey]: canonical, [bindingKey]: sha(await readFile(join(canonical, "startup-admission.json"))) }, join(canonical, "prefix/bin/sbar-orbit.cmd"));
    }
    report.metadataBound = report.taskEnvironmentPresent === true;
    if (stage === "after") {
      const trace = await readFile(join(canonical, "startup-trace.jsonl"));
      const status = await readFile(join(canonical, "startup-trace-status.json"));
      const ackPath = join(canonical, "startup-trace-ack.json"), ackInfo = lstatSync(ackPath);
      if (!ackInfo.isFile() || ackInfo.isSymbolicLink() || realpathSync(ackPath) !== ackPath || ackInfo.size > 4096) throw new Error("Owned acknowledgement invalid");
      const ack = await readFile(ackPath);
      await writeFile(join(output, "startup-trace.jsonl"), trace); await writeFile(join(output, "startup-trace-status.json"), status);
      await writeFile(join(output, "startup-trace-ack.json"), ack);
      const lines = trace.toString().trim().split("\n").filter(Boolean);
      report.traceRecords = lines.length; report.traceSha256 = sha(trace);
      const retention = plain(JSON.parse(status.toString())); report.retention = retention;
      const records = lines.map(line => plain(plain(JSON.parse(line)).installedStartup));
      report.acknowledgementBytesObserved = ack.byteLength > 0;
      report.acknowledgementPersistenceReturn = "not measured";
      report.retentionComplete = installedTraceRetentionComplete(records, retention, trace.byteLength, JSON.parse(ack.toString()), window.token, trace, status);
      report.priorSealPersistenceReturnAttested = report.retentionComplete === true;
      report.actualStopRecordPresent = lines.some(line => plain(plain(JSON.parse(line)).installedStartup).phase === "stop confirmed");
      const before = plain(JSON.parse(await readFile(join(output, "startup-before.json"), "utf8")));
      const attribution = installedStartupAttribution(records);
      const producer = installedProducerBinding(records);
      Object.assign(report, attribution, producer);
      const runtimeRows = records.filter(row => row.phase === "runtime");
      const packageFiles = plain(plain(before.package).files);
      report.actualRuntimeBound = producer.producerIdentityBound && runtimeRows.length > 0 && runtimeRows.every(row => row.browserSha256 === before.browserSha256 && row.runtimeSha256 === plain(packageFiles[join("src", "installed-startup-diagnostic.ts")]).sha256 && row.chromeSha256 === plain(packageFiles[join("src", "chrome.ts")]).sha256);
      report.sourceChanged = plain(before.package).sha256 !== plain(report.package).sha256 || plain(before.installed).sha256 !== plain(report.installed).sha256;
      report.browserChanged = before.browserSha256 !== report.browserSha256 || before.browserFileVersion !== report.browserFileVersion;
      report.collectorBunChanged = before.collectorBunSha256 !== report.collectorBunSha256;
      report.taskChanged = before.taskXmlSha256 !== report.taskXmlSha256;
      report.invalid = !window.tokenWriteReturned || !window.beforeReportWriteReturned || before.expectedWindowToken !== window.token || before.metadataBound !== true || !attribution.startupAttributionReady || !attribution.cleanupAttributionReady || !attribution.cleanupConfirmed || report.retentionComplete !== true || report.actualRuntimeBound !== true || report.sourceChanged || report.browserChanged || report.collectorBunChanged || report.taskChanged || producer.producerIdentityChanged || report.taskEnvironmentPresent !== true;
      // Presence records a real stop phase, never a survivor verdict.
    }
    report.measured = stage === "after" && report.invalid === false;
    if (report.taskEnvironmentPresent !== true) report.invalid = true;
  } catch { report.readFailed = true; report.invalid = true; }
  report.collectionElapsedMs = performance.now() - at;
  try {
    await writeFile(join(output, `startup-${stage}.json`), JSON.stringify(report, null, 2) + "\n");
    if (stage === "before" && window && report.readFailed === false && report.metadataBound === true) window.beforeReportWriteReturned = true;
  }
  catch { report.outputWriteFailed = true; report.invalid = true; report.measured = false; }
  try { console.log(JSON.stringify({ installedStartupCollection: { stage, measured: report.measured, invalid: report.invalid,
    readFailed: report.readFailed, outputWriteFailed: report.outputWriteFailed, collectionElapsedMs: report.collectionElapsedMs, metadataBound: report.metadataBound,
    retentionComplete: report.retentionComplete, actualRuntimeBound: report.actualRuntimeBound, collectorBunChanged: report.collectorBunChanged, taskChanged: report.taskChanged,
    producerIdentityBound: report.producerIdentityBound, producerIdentityChanged: report.producerIdentityChanged,
    startupAttributionReady: report.startupAttributionReady, cleanupAttributionReady: report.cleanupAttributionReady, cleanupConfirmed: report.cleanupConfirmed,
    taskEnvironmentPresent: report.taskEnvironmentPresent, traceRecords: report.traceRecords, expectedWindowToken: report.expectedWindowToken,
    acknowledgementBytesObserved: report.acknowledgementBytesObserved, acknowledgementPersistenceReturn: report.acknowledgementPersistenceReturn,
    priorSealPersistenceReturnAttested: report.priorSealPersistenceReturnAttested } })); } catch {}
}
