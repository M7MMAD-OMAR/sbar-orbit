import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ChromeTransportObserver, createChromeTraceOutputSink } from "../src/chrome-transport-observer";

export const outputTraceId = "11111111-1111-4111-8111-111111111111";
const marker = "orbit-chrome-trace";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const integer = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function refuse(reason: string): never { throw new Error("trace-output-incomplete: " + reason); }

/** Independent wire decoder. It does not import an encoder schema or repair captured bytes. */
export function reassembleTraceOutput(lines: readonly string[], traceId = outputTraceId, message = 1): { bytes: Buffer; value: Record<string, unknown> } {
  const fragments = new Map<number, Buffer>();
  let manifest = false;
  let metadata: string | undefined;
  let count = 0, length = 0, hash = "";
  let target = false;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") + 1 > 4096 || line.includes("\n") || line.includes("\r")) refuse("physical line");
    let item: unknown;
    try { item = JSON.parse(line); } catch { refuse("JSON"); }
    if (!object(item)) refuse("object");
    const keys = [...line.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(match => JSON.parse('"' + match[1] + '"') as string);
    if (new Set(keys).size !== keys.length) refuse("duplicate key");
    if (item.chromeTraceFrame !== marker || item.schema !== 1 || !Number.isInteger(item.schema)) refuse("schema");
    if (typeof item.traceId !== "string" || item.traceId.length !== 36 || !uuid.test(item.traceId) || !integer(item.message, 1, 81)) refuse("identity");
    if (item.traceId !== traceId || item.message !== message) continue;
    target = true;
    if (item.kind !== "fragment" && item.kind !== "emission-manifest") refuse("kind");
    const known = ["chromeTraceFrame", "schema", "kind", "traceId", "message", "count", "bytes", "sha256", ...(item.kind === "fragment" ? ["index", "payload"] : [])].sort();
    if (Object.keys(item).sort().join("|") !== known.join("|")) refuse("fields");
    if (!integer(item.count, 1, 256) || !integer(item.bytes, 1, 524288) || item.count !== Math.ceil(item.bytes / 2048) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) refuse("metadata");
    const identity = JSON.stringify([item.traceId, item.message, item.count, item.bytes, item.sha256]);
    if (metadata !== undefined && metadata !== identity) refuse("conflict");
    metadata = identity; count = item.count; length = item.bytes; hash = item.sha256;
    if (item.kind === "emission-manifest") {
      if (manifest) refuse("duplicate manifest");
      manifest = true;
    } else {
      if (!integer(item.index, 0, count - 1) || fragments.has(item.index) || typeof item.payload !== "string") refuse("index");
      const bytes = Buffer.from(item.payload, "base64");
      if (bytes.toString("base64") !== item.payload || bytes.length !== Math.min(2048, length - item.index * 2048)) refuse("payload");
      fragments.set(item.index, bytes);
    }
  }
  if (!target || !manifest || fragments.size !== count) refuse("missing fragments or manifest");
  const ordered: Buffer[] = [];
  for (let index = 0; index < count; index++) {
    const part = fragments.get(index);
    if (part === undefined) refuse("missing index");
    ordered.push(part);
  }
  const bytes = Buffer.concat(ordered);
  if (bytes.length !== length || digest(bytes) !== hash) refuse("digest or length");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { refuse("UTF-8 or original JSON"); }
  if (!object(value) || value.chromeProtocolTrace !== traceId) refuse("original identity");
  return { bytes, value };
}

export function controlledTraceValue(size: number, padding?: string) {
  const value = { chromeProtocolTrace: outputTraceId, final: { controlledOutputOnly: true, padding: "" } };
  const fixed = Buffer.byteLength(JSON.stringify(value), "utf8");
  value.final.padding = padding ?? "X".repeat(size - fixed);
  if (padding === undefined && Buffer.byteLength(JSON.stringify(value), "utf8") !== size) throw new Error("controlled exact payload size");
  return value;
}

export function outputLines(value: unknown): string[] {
  const lines: string[] = [];
  createChromeTraceOutputSink(line => lines.push(line))(value);
  return lines;
}

if (import.meta.main) {
  const { requireResourceBudget } = await import("../src/resource-budget");
  await requireResourceBudget();
  const mode = process.argv[2];
  if (mode === "fixture-framed") {
    const observer = new ChromeTransportObserver({ chrome: "not measured", observer: "not measured", fixture: "not measured", lock: "not measured", coreBundle: "not measured", dependencyVersion: "not measured" }, createChromeTraceOutputSink(line => console.error(line)));
    observer.observe("fixture-stop", () => Promise.reject(new Error("owned-fixture-stop-original-rejection")));
    observer.finish();
    await Bun.sleep(10);
  } else if (mode === "emit-controlled") {
    createChromeTraceOutputSink(line => console.error(line))(controlledTraceValue(Number(process.argv[3])));
  } else if (mode === "strict-reassemble") {
    const lines = readFileSync(process.argv[3] ?? "", "utf8").trimEnd().split("\n");
    const result = reassembleTraceOutput(lines, process.argv[4] ?? outputTraceId, Number(process.argv[5] ?? 1));
    console.log(JSON.stringify({ bytes: result.bytes.length, sha256: digest(result.bytes), complete: true, limit: "exact captured bytes only; emission manifest is not durability" }));
  } else throw new Error("unknown pure output probe mode");
}
