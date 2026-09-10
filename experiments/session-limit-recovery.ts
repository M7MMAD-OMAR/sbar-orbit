import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const unit = `sbarorbit-recovery-${crypto.randomUUID()}.service`;
const control = async (...args: string[]) => {
  const child = Bun.spawn(["/usr/bin/systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`systemctl failed: ${stderr}`);
  return stdout.trim();
};
const child = Bun.spawn(["/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--collect", "--quiet", `--unit=${unit}`,
  "--service-type=exec", "--slice=sbarorbit.slice", "--property=TasksMax=128", "--property=MemoryMax=768M",
  "--property=MemorySwapMax=0", "--property=CPUQuota=100%", "--property=RuntimeMaxSec=60",
  `--working-directory=${process.cwd()}`, process.execPath, "run", "experiments/recovery-broker.ts"], { stdout: "pipe", stderr: "pipe" });
const errors = new Response(child.stderr).text();
const reader = child.stdout.getReader();
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<p>Recovered Orbit session</p>", { headers: { "Content-Type": "text/html" } }) });
const report: Record<string, unknown> = { status: "running" };
try {
  let output = "";
  const deadline = setTimeout(() => { void control("stop", unit); }, 15000);
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Broker exited before startup: ${await errors}`);
      output += new TextDecoder().decode(chunk.value);
    }
  } finally { clearTimeout(deadline); }
  const { socket } = JSON.parse(output.split("\n")[0]!);
  // Warm the IPC and asynchronous filesystem paths before closing task admission.
  await call(socket, "doctor");
  const group = join("/sys/fs/cgroup", await control("show", unit, "--property=ControlGroup", "--value"));
  const value = async (file: string) => (await readFile(join(group, file), "utf8")).trim();
  const current = Number(await value("pids.current"));
  await control("set-property", "--runtime", unit, `TasksMax=${current}`);
  let rejected: unknown;
  try { await call(socket, "session.create", { backend: "browser", profileKey: "recovery" }); }
  catch (error) { rejected = error; }
  report.rejectionCode = (rejected as { code?: string })?.code;
  report.taskEvents = await value("pids.events");
  if (!rejected) throw new Error("Session unexpectedly created at a full task limit");
  if (report.rejectionCode !== "RESOURCE_UNAVAILABLE") throw new Error("Resource denial was not reported clearly");
  const sessions = await call(socket, "session.list") as unknown[];
  if (sessions.length) throw new Error("Failed creation left a registered session");
  await control("set-property", "--runtime", unit, "TasksMax=128");
  const session = await call(socket, "session.create", { backend: "browser", profileKey: "recovery" }) as { sessionId: string };
  await call(socket, "session.act", { ...session, requestId: "navigate", action: { type: "navigate", url: `http://127.0.0.1:${fixture.port}` } });
  const result = await call(socket, "session.act", { ...session, requestId: "read", action: { type: "read", selector: "p" } }) as { text: string };
  if (result.text !== "Recovered Orbit session") throw new Error("Recovered session failed to read the fixture");
  await call(socket, "session.stop", session);
  Object.assign(report, { status: "passed", recoveredText: result.text, sameProfileKeyReused: true,
    peakMemoryBytes: Number(await value("memory.peak")), swapBytes: Number(await value("memory.swap.current")),
    limitations: ["One creation-time task denial and one recovered browser; active-session OOM recovery remains unverified."] });
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  fixture.stop(true);
  await control("stop", unit).catch(() => {});
  await child.exited;
  await reader.cancel();
  report.diagnostics = await errors;
  await Bun.write("output/session-limit-recovery.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
