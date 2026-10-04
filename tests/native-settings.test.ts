import { expect, test } from "bun:test";
import { join } from "node:path";

test.each([
  { args: ["full"], plan: undefined, control: undefined, code: "INVALID_REQUEST" },
  { args: [], plan: undefined, control: undefined, code: "UNSUPPORTED" },
  { args: [], plan: "relative", control: "relative", code: process.platform === "linux" ? "INVALID_REQUEST" : "UNSUPPORTED" },
])("native owner controls refuse invalid or unconfigured CLI before GTK launch", async sample => {
  const env = { ...process.env };
  delete env.ORBIT_CONVERSATION_ID;
  delete env.ORBIT_NATIVE_PLAN;
  delete env.ORBIT_NATIVE_CONTROL;
  if (sample.plan) env.ORBIT_NATIVE_PLAN = sample.plan;
  if (sample.control) env.ORBIT_NATIVE_CONTROL = sample.control;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "native-settings", ...sample.args],
    { env, stdout: "pipe", stderr: "pipe" });
  const [output, error] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(await child.exited).toBe(1);
  expect(output).toBe("");
  expect(JSON.parse(error)).toMatchObject({ ok: false, error: { code: sample.code } });
});
