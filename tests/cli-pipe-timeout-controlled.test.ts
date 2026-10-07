import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("original Python communicate deadline reaches kill and drain", async () => {
 const python = Bun.which("python3") ?? Bun.which("python"); if (!python) throw new Error("Python is required");
 const root = await mkdtemp(join(tmpdir(), "orbit-pipe-timeout-control-"));
 const fixtureSource = await readFile(new URL("./cli-output.test.ts", import.meta.url), "utf8");
 const reader = fixtureSource.split("  const reader = String.raw`", 2)[1]?.split("`;\n  const child", 1)[0];
 if (!reader) throw new Error("Original reader boundary missing");
 const sleeper = fileURLToPath(new URL("./cli-pipe-sleeper-control.ts", import.meta.url));
 const phases = join(root, "phases.jsonl");
 const child = Bun.spawn([python, "-c", reader, process.execPath, sleeper, "observe", join(root, "output"), phases], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000 });
 try {
  const [report, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const phaseRaw = await readFile(phases, "utf8");
  console.error(JSON.stringify({ ownedTimeoutControl: { exit, exitCodeSnapshot: child.exitCode, reportBytes: Buffer.byteLength(report), stderrBytes: Buffer.byteLength(stderr), phaseRaw, cleanup: "not measured", limit: "Controlled sleeper payload, not real CLI or provider cause" } }));
  expect(exit).not.toBe(0); expect(report).toBe(""); expect(stderr).toContain("TimeoutExpired");
  expect(phaseRaw.trim().split("\n").map(line => JSON.parse(line).phase)).toEqual(["entered", "spawned", "delay-complete", "communicate-before", "communicate-timeout", "kill-dispatched", "drain-before", "drain-settled"]);
 } finally { if (child.exitCode === null) child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
}, 15000);
