import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationUsage } from "../src/conversation-usage";
import { encodeClaim, isCanonicalConversationId, localClaim, resolveCaller, unidentifiedCaller, type ProcessProbe } from "../src/caller";
import { OrbitError } from "../src/errors";

const outer = [" ", "\t", "\n", "\r", "\u00a0", "\u1680", "\u2000", "\u2007", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
const unpaired = ["\ud800", "\udfff", "x\ud800", "x\udc00", "\ud800x", "\udc00\ud800", "\ud800\ud800", "\ud800\udc00\udc00"];
const invalid = ["", ...outer, ...outer.flatMap(space => [space + "foo", "foo" + space, space + "foo" + space]),
  ...Array.from({ length: 32 }, (_, index) => "a" + String.fromCharCode(index) + "b"), "a\x7fb", "x".repeat(257), ...unpaired];
const canonical = ["foo", "foo bar", "foo  bar", "é", "e\u0301", "قناة-1", "x\u0085y", "\u0085foo", "foo\u009f", "😀", "😀".repeat(128), "x".repeat(256), "x\ufffd"];
const pathFor = (root: string, id: string) => join(root, createHash("sha256").update(id).digest("hex") + ".json");
const invalidUsage = (value: unknown, root: string) => {
  let caught: unknown;
  try { new ConversationUsage(value as string, root); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OrbitError);
  expect(caught).toMatchObject({ code: "INVALID_REQUEST" });
};
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "orbit-conversation-identity-"));
  return { base, root: join(base, "usage"), close: () => rm(base, { recursive: true, force: true }) };
}
const rawHeader = (conversationId: unknown) => Buffer.from(JSON.stringify({ v: 1, kind: "adapter", pid: 50, start: "777", conversationId })).toString("base64url");
const probe: ProcessProbe = { start: () => "777", owner: () => 1000, alive: () => true };

test("shared identity validation rejects noncanonical values without coercion", () => {
  let coerced = 0;
  const object = { trim() { coerced++; return "foo"; }, toString() { coerced++; return "foo"; } };
  for (const value of [null, false, true, 0, 1, {}, [], object, ...invalid]) expect(isCanonicalConversationId(value)).toBe(false);
  expect(isCanonicalConversationId(undefined)).toBe(false);
  expect(coerced).toBe(0);
});

test("canonical well-formed identities preserve Unicode interior whitespace C1 and UTF-16 length semantics", () => {
  for (const id of canonical) expect(isCanonicalConversationId(id)).toBe(true);
  expect(isCanonicalConversationId("😀".repeat(129))).toBe(false);
  expect(isCanonicalConversationId("x" + "😀".repeat(127) + "y")).toBe(true);
  expect(isCanonicalConversationId("x" + "😀".repeat(128))).toBe(false);
  // Preserve the legacy C0/DEL policy, not a new Unicode category ban.
  expect(isCanonicalConversationId("\u0085")).toBe(true);
});

test("actual CLI and adapter localClaim omit invalid conversation IDs instead of trimming", () => {
  for (const kind of ["cli", "adapter"] as const) {
    for (const id of invalid) {
      const claim = localClaim(kind, { ORBIT_CONVERSATION_ID: id });
      expect(Object.hasOwn(claim, "conversationId")).toBe(false);
    }
    for (const id of canonical) expect(localClaim(kind, { ORBIT_CONVERSATION_ID: id }).conversationId).toBe(id);
    expect(Object.hasOwn(localClaim(kind, {}), "conversationId")).toBe(false);
  }
});

test("resolveCaller rejects raw noncanonical encoded claims before process lookup and never normalizes", () => {
  let lookups = 0;
  const untouched: ProcessProbe = { start: () => { lookups++; return "777"; },
    owner: () => { lookups++; return 1000; }, alive: () => { lookups++; return true; } };
  for (const value of [null, false, 1, {}, [], ...invalid])
    expect(resolveCaller(rawHeader(value), untouched, 1000)).toBe(unidentifiedCaller);
  expect(lookups).toBe(0);
  for (const id of canonical) expect(resolveCaller(rawHeader(id), probe, 1000)).toMatchObject({ id: "conv:" + id, verified: true, role: "agent" });
});

test("usage rejects invalid IDs before directory creation or CLI/MCP-style work", async () => {
  const state = await fixture();
  try {
    let work = 0;
    for (const id of invalid) {
      invalidUsage(id, state.root);
      for (const kind of ["cli", "adapter"] as const) {
        expect(Object.hasOwn(localClaim(kind, { ORBIT_CONVERSATION_ID: id }), "conversationId")).toBe(false);
        expect(() => { new ConversationUsage(id, state.root); work++; }).toThrow(OrbitError);
      }
    }
    expect(work).toBe(0);
    expect(await readdir(state.base)).toEqual([]);
  } finally { await state.close(); }
});

test("independent CLI and MCP usage instances share the exact canonical hash and off state", async () => {
  const state = await fixture();
  try {
    const id = "canonical-قناة-😀";
    const cli = new ConversationUsage(id, state.root), mcp = new ConversationUsage(id, state.root);
    const claim = localClaim("adapter", { ORBIT_CONVERSATION_ID: id });
    const localProbe: ProcessProbe = { start: () => claim.start, owner: () => 1000, alive: () => true };
    expect(resolveCaller(encodeClaim(claim), localProbe, 1000).id).toBe("conv:" + id);
    await cli.set("off");
    expect(await mcp.status()).toEqual({ enabled: false, scope: "conversation", conversationId: id });
    await expect(cli.assertEnabled()).rejects.toMatchObject({ code: "ORBIT_DISABLED" });
    await expect(mcp.assertEnabled()).rejects.toMatchObject({ code: "ORBIT_DISABLED" });
    expect(JSON.parse(await readFile(pathFor(state.root, id), "utf8"))).toEqual({ enabled: false });
    await mcp.set("on");
    await cli.assertEnabled();
    expect((await cli.status()).enabled).toBe(true);
    expect(await readdir(state.root)).toEqual([createHash("sha256").update(id).digest("hex") + ".json"]);
  } finally { await state.close(); }
});

test("valid interior spaces and Unicode normalization variants retain independent exact identities", async () => {
  const state = await fixture();
  try {
    for (const [first, second] of [["foo bar", "foo  bar"], ["é", "e\u0301"], ["x\u0085y", "xy"]] as const) {
      const left = new ConversationUsage(first, state.root), right = new ConversationUsage(second, state.root);
      expect(pathFor(state.root, first)).not.toBe(pathFor(state.root, second));
      await left.set("off");
      expect((await right.status()).enabled).toBe(true);
      expect(resolveCaller(rawHeader(first), probe, 1000).id).not.toBe(resolveCaller(rawHeader(second), probe, 1000).id);
    }
  } finally { await state.close(); }
});

test("historical padded off state is preserved but not silently migrated into the canonical identity", async () => {
  const state = await fixture();
  try {
    const oldId = " foo ", canonicalId = "foo";
    await mkdir(state.root, { mode: 0o700 });
    const oldPath = pathFor(state.root, oldId), oldBytes = '{"enabled":false}';
    await writeFile(oldPath, oldBytes, { mode: 0o600, flag: "wx" });
    invalidUsage(oldId, state.root);
    expect(Object.hasOwn(localClaim("cli", { ORBIT_CONVERSATION_ID: oldId }), "conversationId")).toBe(false);
    expect(resolveCaller(rawHeader(oldId), probe, 1000)).toBe(unidentifiedCaller);
    const canonicalUsage = new ConversationUsage(canonicalId, state.root);
    // Historical paths cannot safely be inferred to describe the same owner intent.
    // Canonical foo may still be on. The owner must explicitly reconcile that state.
    expect((await canonicalUsage.status()).enabled).toBe(true);
    expect(await readdir(state.root)).toEqual([createHash("sha256").update(oldId).digest("hex") + ".json"]);
    expect(await readFile(oldPath, "utf8")).toBe(oldBytes);
    await canonicalUsage.set("off"); // Explicit owner action in this owned fixture only.
    await expect(new ConversationUsage(canonicalId, state.root).assertEnabled()).rejects.toMatchObject({ code: "ORBIT_DISABLED" });
    expect(await readFile(oldPath, "utf8")).toBe(oldBytes);
  } finally { await state.close(); }
});

test("lone surrogate UTF-8 hash collision is refused while valid replacement and paired IDs remain exact", async () => {
  const state = await fixture();
  try {
    const malformed = "x\ud800", replacement = "x\ufffd";
    expect(pathFor(state.root, malformed)).toBe(pathFor(state.root, replacement));
    invalidUsage(malformed, state.root);
    expect(resolveCaller(rawHeader(malformed), probe, 1000)).toBe(unidentifiedCaller);
    await mkdir(state.root, { mode: 0o700 });
    await writeFile(pathFor(state.root, malformed), '{"enabled":false}', { mode: 0o600, flag: "wx" });
    await expect(new ConversationUsage(replacement, state.root).assertEnabled()).rejects.toMatchObject({ code: "ORBIT_DISABLED" });
    const pair = new ConversationUsage("x😀", state.root);
    expect((await pair.status()).enabled).toBe(true);
    expect(resolveCaller(rawHeader("x😀"), probe, 1000).id).toBe("conv:x😀");
  } finally { await state.close(); }
});

test("canonical malformed persisted preference still refuses instead of being silently re-enabled", async () => {
  const state = await fixture();
  try {
    await mkdir(state.root, { mode: 0o700 });
    const id = "canonical-malformed";
    await writeFile(pathFor(state.root, id), '{"enabled":"private-invalid"}', { mode: 0o600, flag: "wx" });
    const usage = new ConversationUsage(id, state.root);
    await expect(usage.status()).rejects.toMatchObject({ code: "USAGE_STATE_INVALID" });
    await expect(usage.assertEnabled()).rejects.toMatchObject({ code: "USAGE_STATE_INVALID" });
    expect(await readFile(pathFor(state.root, id), "utf8")).toBe('{"enabled":"private-invalid"}');
  } finally { await state.close(); }
});


test("actual CLI rejects padded environment before missing-broker status and reads canonical usage state", async () => {
  const state = await fixture();
  const invoke = async (id: string, args: readonly string[]) => {
    const env: Record<string, string | undefined> = {
      ...process.env, ORBIT_CONVERSATION_ID: id, ORBIT_USAGE_DIR: state.root,
      ORBIT_SOCKET: join(state.base, "no-broker.sock"), HOME: state.base,
      XDG_CONFIG_HOME: join(state.base, "config"), XDG_STATE_HOME: join(state.base, "state"),
      XDG_CACHE_HOME: join(state.base, "cache"),
    };
    delete env.ORBIT_OWNER;
    // Standard Bun owned-child fixture timeout, not a native process/drain proof.
    // This never starts serve or targets an existing broker, app or numeric PID.
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
      cwd: state.base, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536,
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { out, err, code };
  };
  try {
    const refused = await invoke(" foo ", ["status"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    // Exact JSON/code assertions fail on startup, timeout or socket errors.
    expect(JSON.parse(refused.err)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    // Bun may initialize its cache inside this owned HOME; neither usage
    // state nor a broker socket may be created before identity refusal.
    await expect(lstat(state.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(state.base, "no-broker.sock"))).rejects.toMatchObject({ code: "ENOENT" });

    const id = "actual-cli-canonical", allowed = await invoke(id, ["usage", "status"]);
    expect(allowed.code).toBe(0);
    expect(allowed.err).toBe("");
    expect(JSON.parse(allowed.out)).toEqual({ ok: true, result: { enabled: true, scope: "conversation", conversationId: id } });
    await mkdir(state.root, { mode: 0o700 });
    await writeFile(pathFor(state.root, id), '{"enabled":false}', { mode: 0o600, flag: "wx" });
    const off = await invoke(id, ["usage", "status"]);
    expect(off.code).toBe(0);
    expect(off.err).toBe("");
    expect(JSON.parse(off.out)).toEqual({ ok: true, result: { enabled: false, scope: "conversation", conversationId: id } });
    expect(await readFile(pathFor(state.root, id), "utf8")).toBe('{"enabled":false}');
  } finally { await state.close(); }
}, 20000);
