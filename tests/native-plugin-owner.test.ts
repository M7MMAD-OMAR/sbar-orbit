import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

(process.platform === "linux" ? test : test.skip).each([
  { output: "", exit: 137 },
  { output: "null", exit: 0 },
  { output: "{}", exit: 0 },
  { output: '{"ok":true,"result":{"loaded":false}}', exit: 0 },
  { output: '{"ok":false,"result":{}}', exit: 0 },
  { output: "null", exit: 1 },
  { output: "{}", exit: 1 },
  { output: '{"ok":false,"error":""}', exit: 1 },
].flatMap(fixture => ["load", "unload", "resume"].map(operation => ({ ...fixture, operation }))))(
  "owner mutation keeps uncertainty when its child returns no verified outcome: %j", async ({ output: response, exit, operation }) => {
  const source = process.env.ORBIT_OWNER_COMMAND_TEST_SOURCE ?? join(import.meta.dir, "../src/native-prepare.ts");
  // These component fixtures exercise uncertain child outcomes. Current source/ABI compatibility has its own unmocked tests.
  const release = join(dirname(source), "native-availability.ts");
  const script = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(release)}, () => ({ requireNativeAdapter() {} }));
    const { nativePlugin } = await import(${JSON.stringify(source)});
    Bun.spawn = () => ({ stdout: new Response(${JSON.stringify(exit === 0 ? response : "")}).body,
      stderr: new Response(${JSON.stringify(exit !== 0 ? response : "")}).body,
      exited: Promise.resolve(${exit}), kill() {} });
    try { await nativePlugin(${JSON.stringify(operation)}, "/unused-private-preparation"); process.exitCode = 2; }
    catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(output)).toMatchObject({ code: "BACKEND_FAILED" });
  expect(JSON.parse(output).message).toContain(operation + " may have been sent");
});

(process.platform === "linux" ? test : test.skip)("owner plugin lifecycle refuses changed artifacts, stale hosts and unavailable journals", async () => {
  const child = Bun.spawn(["/usr/bin/python3", "-m", "src.native.plugin_owner_test"],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output, error }).toMatchObject({ code: 0 });
  expect(error).toContain("Ran 26 tests");
});

test.each([
  [], ["pause", "/unused"], ["load"], ["status", "relative"],
  ["load", "/unused", "full"], ["load", "/unused", "--path", "/other"],
].map(args => ({ args })))("owner plugin command rejects invalid arguments before host access", async ({ args }) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "native-plugin", ...args],
    { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(JSON.parse(error)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});

(process.platform === "linux" ? test : test.skip).each([
  { pending: undefined, accepted: true }, { pending: 0, accepted: true },
  { pending: 1, accepted: false }, { pending: true, accepted: false },
  { pending: -1, accepted: false }, { pending: 9, accepted: false }, { pending: "0", accepted: false },
])("owner unload receipt accounts for bounded pending semantic callbacks: %j", async ({ pending, accepted }) => {
  const source = process.env.ORBIT_OWNER_COMMAND_TEST_SOURCE ?? join(import.meta.dir, "../src/native-prepare.ts");
  const directory = "/unused-private-preparation";
  const admission = { schema: 1, admission_paused: true, live_roots: 0, tracked_scopes: 0,
    scopes_empty: true, legacy_enrollment: false, ready: pending === undefined || pending === 0,
    ...(pending === undefined ? {} : { semantic_pending: pending }) };
  const reply = { ok: true, result: { loaded: false, compositor: [123, 456], owner_service_activation: "not performed",
    unload_sent: true, admission_pause_sent: true, journal: join(directory, "plugin-owner.jsonl"), admission_before_unload: admission } };
  const script = `
    const { nativePlugin } = await import(${JSON.stringify(source)});
    Bun.spawn = () => ({ stdout: new Response(${JSON.stringify(JSON.stringify(reply))}).body,
      stderr: new Response("").body, exited: Promise.resolve(0), kill() {} });
    try { await nativePlugin("unload", ${JSON.stringify(directory)}); console.log("accepted"); }
    catch (error) { console.log(error.code); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.trim()).toBe(accepted ? "accepted" : "BACKEND_FAILED");
});
