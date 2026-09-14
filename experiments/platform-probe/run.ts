import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, release, arch, cpus, totalmem } from "node:os";

/**
 * One report per platform, from a host this project does not own: a GitHub runner, or any machine
 * where someone runs this by hand. Every probe is wrapped so that a crash in one is a recorded
 * failure rather than a missing report, and nothing here needs a broker, a budget or a person.
 * Which gates each probe answers is written beside the probe; docs/porting.md carries the verdicts.
 */
export type Item = { ok: boolean; ms: number; result?: unknown; error?: string };
export type Report = Record<string, Item>;

export async function probeAll(probes: Record<string, () => Promise<unknown>>, timeoutMs = 120000): Promise<Report> {
  const report: Report = {};
  for (const [name, probe] of Object.entries(probes)) {
    const started = performance.now();
    try {
      const result = await Promise.race([probe(), new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs))]);
      report[name] = { ok: true, ms: Math.round(performance.now() - started), result };
    } catch (error) {
      report[name] = { ok: false, ms: Math.round(performance.now() - started), error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
    console.log(`${report[name]!.ok ? "ok  " : "FAIL"} ${name} ${report[name]!.ms} ms${report[name]!.error ? ": " + report[name]!.error : ""}`);
  }
  return report;
}

/** Run a command and return its trimmed stdout, or throw with the tail of its stderr. */
export async function run(argv: string[], options: { timeoutMs?: number; env?: Record<string, string>; allowFailure?: boolean } = {}) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env } });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  if (code !== 0 && !options.allowFailure) throw new Error(`${argv[0]} exited ${code}: ${err.trim().slice(-400) || out.trim().slice(-400)}`);
  return { out: out.trim(), err: err.trim(), code };
}

const platform = process.platform;
const module = platform === "win32" ? "./windows" : platform === "darwin" ? "./darwin" : "./linux";
const { probes } = await import(module) as { probes: Record<string, () => Promise<unknown>> };
const report = {
  platform, hostname: hostname(), release: release(), arch: arch(), cpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
  bun: Bun.version, date: new Date().toISOString(), runner: process.env.RUNNER_OS ? { os: process.env.RUNNER_OS, image: process.env.ImageOS, version: process.env.ImageVersion } : null,
  probes: await probeAll(probes),
};
const directory = join("output", "platform-probe");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, `${platform}.json`), JSON.stringify(report, null, 2));
console.log(`report: ${join(directory, `${platform}.json`)}`);
