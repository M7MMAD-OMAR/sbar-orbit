import { expect, spyOn, test } from "bun:test";
import * as commands from "../src/lifecycle-command";
import { brokerTaskXml } from "../src/windows-autostart";
import { taskPolicyMatches, qualifiedTaskPolicyMatches } from "../src/windows-task-policy";
import vector from "./fixtures/windows-task-policy-v1.json";
const launcher = "C:\\Orbit\\bin\\sbar-orbit.cmd";
function fixture() {
  const expected = brokerTaskXml(launcher, vector.sid, { ORBIT_MANAGED_ENV_SCHEMA: "1", ORBIT_BUN: "C:\\Orbit\\versions\\1.2.3\\runtime\\bun.exe" }, true);
  let actual = expected.replaceAll(vector.sid, vector.alias).replace("<RunLevel>LeastPrivilege</RunLevel>", "");
  const settingsStart = actual.indexOf("<Settings>");
  const prefix = actual.slice(0, settingsStart); let settings = actual.slice(settingsStart);
  for (const [name, value] of Object.entries(vector.settings)) settings = settings.replace("<" + name + ">" + value + "</" + name + ">", "");
  actual = prefix + settings;
  return { expected, actual, task: "SbarOrbitBroker-" + vector.sid, wire: { schema: 1, xml: actual, references: [vector.alias, vector.alias], runLevel: 0, settings: vector.settings } };
}
test("strict explicit task policy ignores XML formatting and entity spelling, not command content", () => {
  const f = fixture(); expect(taskPolicyMatches(f.expected, f.expected.replaceAll("&quot;", "&#34;"), vector.sid)).toBe(true);
  expect(taskPolicyMatches(f.actual, f.expected, vector.sid)).toBe(false);
  for (const bad of [f.expected.replace("cmd.exe", "evil.exe"), f.expected.replace("serve --managed-socket", "serve --wrong"), f.expected.replace("LeastPrivilege", "HighestAvailable"), f.expected.replace("InteractiveToken", "S4U"), f.expected.replace("<Settings>", "<Settings><UnknownEffect>true</UnknownEffect>"), f.expected.replace("</Actions>", "<Exec><Command>evil</Command></Exec></Actions>"), f.expected.replace("</Triggers>", "<BootTrigger/></Triggers>"), f.expected.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"), "<!DOCTYPE Task>" + f.expected, f.expected.replace("cmd.exe", "&custom;"), f.expected.replace("cmd.exe", "&constructor;"), f.expected.replace("cmd.exe", "&toString;"), f.expected.replace("cmd.exe", "&__proto__;"), f.expected.replace("<Task version=", '<Task __proto__="x" version='), f.expected.replace("<UserId>", "<GroupId>")]) expect(taskPolicyMatches(bad, f.expected, vector.sid)).toBe(false);
});
if (process.env.ORBIT_TASK_POLICY_TEST_WORKER === "1") {
test("live qualification binds snapshot refs typed defaults and exact expected actions", async () => {
  const f = fixture(), spy = spyOn(commands, "boundedCommand").mockResolvedValue({ ok: true, output: JSON.stringify(f.wire) });
  try {
    expect(f.actual).toContain("<Enabled>true</Enabled>"); // Trigger policy is not a Settings default.
    expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await qualifiedTaskPolicyMatches(f.actual.replace("cmd.exe", "evil.exe"), f.expected, vector.sid, f.task)).toBe(false);
    expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, "S-1-5-21-9999", f.task)).toBe(false);
    spy.mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, settings: { ...vector.settings, Enabled: false } }) }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
    spy.mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, runLevel: 1 }) }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
    spy.mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, runLevel: null }) }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
    spy.mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, references: [vector.alias] }) }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
    spy.mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, settings: { ...vector.settings, Enabled: null } }) }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
    spy.mockResolvedValue({ ok: false, output: "Lifecycle command timed out" }); expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false);
  } finally { spy.mockRestore(); }
});
test("a snapshot for a different definition never qualifies incoming XML", async () => {
  const f = fixture(), spy = spyOn(commands, "boundedCommand").mockResolvedValue({ ok: true, output: JSON.stringify({ ...f.wire, xml: f.actual.replace("serve --managed-socket", "serve --other") }) });
  try { expect(await qualifiedTaskPolicyMatches(f.actual, f.expected, vector.sid, f.task)).toBe(false); } finally { spy.mockRestore(); }
});
} else {
test("live qualification fixtures are isolated in one owned subprocess", async () => {
  const child = Bun.spawn([process.execPath, "test", import.meta.path], { env: { ...process.env, ORBIT_TASK_POLICY_TEST_WORKER: "1" }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 15000);
  try { const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (exit !== 0) throw new Error("Owned task-policy fixture worker failed: " + out + err); expect(exit).toBe(0); } finally { clearTimeout(timer); }
}, 20000);
}
