import { expect, test } from "bun:test";
import { join } from "node:path";

test.each([
  { args: [] },
  { args: ["relative"] },
  { args: ["/unused-owner-preparation", "full"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest", "relative"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest", "/unused", "extra"] },
])("native preparation rejects invalid owner arguments before host access", async ({ args }) => {
  const env = { ...process.env };
  delete env.ORBIT_CONVERSATION_ID;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "native-prepare", ...args],
    { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(JSON.parse(error)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});
