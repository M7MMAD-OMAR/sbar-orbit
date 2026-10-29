import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runs every `tests/*.test.ts` file in its own `bun test` process and writes one JSON record per
 * file. A single combined run reports one number; this names the files, which is what a platform
 * port needs. It never fails the job on a red file: the report is the product, and the gate that
 * decides what must pass is `bun run verify:platform-contracts`.
 */
const label = process.argv[2] ?? process.platform;
const root = join(import.meta.dir, "..");
const only = process.env.ORBIT_TEST_FILTER ? new RegExp(process.env.ORBIT_TEST_FILTER) : undefined;
const files = (await readdir(join(root, "tests"))).filter(name => name.endsWith(".test.ts") && (!only || only.test(name))).sort();
const results: { file: string; exit: number | null; seconds: number; pass: number; fail: number; skip: number; tail: string }[] = [];
for (const file of files) {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "test", join("tests", file)], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
  const timer = setTimeout(() => child.kill(), 180_000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exit = await child.exited;
  clearTimeout(timer);
  const text = `${out}\n${err}`;
  const count = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}`, "m").exec(text)?.[1] ?? 0);
  const record = { file, exit, seconds: Math.round((performance.now() - started) / 100) / 10, pass: count("pass"), fail: count("fail"), skip: count("skip"), tail: exit === 0 ? "" : text.trim().split(/\r?\n/).slice(-12).join("\n") };
  results.push(record);
  console.log(`${exit === 0 ? "ok  " : "FAIL"} ${file} pass=${record.pass} fail=${record.fail} skip=${record.skip} ${record.seconds}s`);
}
await mkdir(join(root, "output", "platform-tests"), { recursive: true });
await writeFile(join(root, "output", "platform-tests", `${label}.json`), JSON.stringify({ label, platform: process.platform, bun: Bun.version, results }, null, 2));
const bad = results.filter(result => result.exit !== 0);
console.log(`\n${results.length - bad.length}/${results.length} files green on ${label}`);
for (const item of bad) console.log(`--- ${item.file}\n${item.tail}`);
