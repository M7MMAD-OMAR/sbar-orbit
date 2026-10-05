import { expect, test } from "bun:test";
import { join } from "node:path";

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
  const script = `
    import { nativePlugin } from ${JSON.stringify(source)};
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
  expect(error).toContain("Ran 23 tests");
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
