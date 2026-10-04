import { isAbsolute, join } from "node:path";
import { OrbitError } from "./errors";
import { requireResourceBudget } from "./resource-budget";

/** Owner command only; writes an unapplied configuration bundle. */
export async function prepareNative(directory: string | undefined, pluginManifest?: string) {
  if (!directory || !isAbsolute(directory)) throw new OrbitError("INVALID_REQUEST", "Use native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY");
  if (pluginManifest !== undefined && !isAbsolute(pluginManifest)) throw new OrbitError("INVALID_REQUEST", "Plugin manifest must be absolute");
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native preparation requires Linux and Hyprland");
  await requireResourceBudget();
  const { code, reply } = await runOwnerCommand("prepare.py", [directory,
    ...(pluginManifest === undefined ? [] : ["--plugin-manifest", pluginManifest])]);
  if (code !== 0) throw new OrbitError("CONFIG_REQUIRED", "Native preparation failed; its directory must be private, empty and bound to a live Hyprland host");
  return reply;
}

/** Fixed owner entry, without an agent RPC counterpart. */
export async function nativePlugin(operation: string | undefined, directory: string | undefined) {
  if (!["status", "load"].includes(operation ?? "") || !directory || !isAbsolute(directory))
    throw new OrbitError("INVALID_REQUEST", "Use native-plugin status|load ABSOLUTE_PREPARATION_DIRECTORY");
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native plugin loading requires Linux and Hyprland");
  await requireResourceBudget();
  let outcome: Awaited<ReturnType<typeof runOwnerCommand>>;
  try {
    outcome = await runOwnerCommand("plugin_owner.py", [operation ?? "", directory]);
    if (outcome.code === 0 && !validPluginReply(outcome.reply, operation ?? "", directory))
      throw new OrbitError("BACKEND_FAILED", "Owner plugin command returned an incomplete result");
    if (outcome.code !== 0 && (typeof outcome.reply !== "object" || outcome.reply === null
        || !("ok" in outcome.reply) || outcome.reply.ok !== false
        || !("error" in outcome.reply) || typeof outcome.reply.error !== "string" || !outcome.reply.error.trim()))
      throw new OrbitError("BACKEND_FAILED", "Owner plugin command returned an incomplete error");
  }
  catch (error) {
    if (operation !== "load") throw error;
    const detail = error instanceof Error ? error.message : "No verified owner command result";
    throw new OrbitError("BACKEND_FAILED", "Plugin load outcome is unknown; load may have been sent. Inspect status and plugin-owner.jsonl before recovery. " + detail);
  }
  const { code, reply } = outcome;
  if (code !== 0) {
    const detail = typeof reply === "object" && reply !== null && "error" in reply && typeof reply.error === "string"
      ? reply.error : "Native plugin operation failed; inspect the owner's plugin journal";
    throw new OrbitError("CONFIG_REQUIRED", detail);
  }
  return reply;
}

function validPluginReply(reply: unknown, operation: string, directory: string): boolean {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!object(reply) || reply.ok !== true || !object(reply.result)) return false;
  const result = reply.result;
  if (typeof result.loaded !== "boolean" || result.owner_service_activation !== "not performed"
      || !Array.isArray(result.compositor) || result.compositor.length !== 2
      || !result.compositor.every(value => Number.isSafeInteger(value) && value > 0)) return false;
  if (operation === "load" && (result.loaded !== true || typeof result.load_sent !== "boolean"
      || result.journal !== join(directory, "plugin-owner.jsonl"))) return false;
  if (!result.loaded) return true;
  const build = result.build;
  return object(build) && build.schema === 1 && digest(build.source_sha256)
    && typeof build.abi_hash === "string" && build.abi_hash.length > 0
    && typeof build.live_roots === "number" && Number.isInteger(build.live_roots)
    && build.live_roots >= 0 && build.live_roots <= 128
    && digest(result.binary_sha256) && result.path === join(directory, "plugin.so")
    && result.binding === "prepared identity/digest plus exact kernel maps device/inode"
    && result.unload_readiness === "not measured";
}

async function runOwnerCommand(entry: string, words: string[]) {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native", entry), ...words], {
    stdout: "pipe", stderr: "pipe", timeout: 20000,
  });
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) throw new OrbitError("BACKEND_FAILED", "Native preparation output exceeded its bound");
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  }
  let stdout: string, stderr: string, code: number;
  try { [stdout, stderr, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); }
  catch (error) { child.kill(); await child.exited; throw error; }
  let reply: unknown;
  try { reply = JSON.parse(code === 0 ? stdout : stderr); }
  catch { throw new OrbitError("BACKEND_FAILED", "Native preparation did not return a result"); }
  return { code, reply };
}
