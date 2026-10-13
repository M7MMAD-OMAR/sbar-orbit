import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const sha = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
async function main() {
  if (process.env.ORBIT_TEST_NATIVE === "1") throw new Error("Native opt-in refused before every source capture spawn");
  const environment = { ...process.env, ORBIT_TEST_NATIVE: "0" };
  const [phase] = process.argv.slice(2);
  if (!["before", "after"].includes(phase ?? "")) throw new Error("Explicit source capture phase required");
  const repository = process.env.GITHUB_REPOSITORY, repositoryId = process.env.GITHUB_REPOSITORY_ID;
  if (repository !== "M7MMAD-OMAR/sbar-orbit" || repositoryId !== "1364437010") throw new Error("Repository identity mismatch");
  const runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT, headSha = process.env.GITHUB_SHA;
  const jobName = process.env.ORBIT_SOURCE_JOB_NAME, jobKey = process.env.GITHUB_JOB, branch = process.env.GITHUB_REF_NAME;
  const event = process.env.GITHUB_EVENT_NAME, workflowRef = process.env.GITHUB_WORKFLOW_REF, workflowSha = process.env.GITHUB_WORKFLOW_SHA;
  if (!/^\d+$/.test(runId ?? "") || !/^\d+$/.test(attempt ?? "") || !/^[a-f0-9]{40}$/.test(headSha ?? "")
    || !jobName || !jobKey || !branch || !event || !workflowRef || workflowSha !== headSha)
    throw new Error("Exact provider execution identity missing");
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !isAbsolute(temporary)) throw new Error("Private runner temporary directory missing");
  const directory = join(temporary, "orbit-provider-source", `${jobKey}-${process.env.RUNNER_OS}-${runId}-${attempt}`);
  const git = (...args: string[]) => {
    if (process.env.ORBIT_TEST_NATIVE === "1") throw new Error("Native opt-in refused before Git spawn");
    const result = Bun.spawnSync(["git", ...args], { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(`Source Git command failed: ${args[0]}`);
    return result.stdout;
  };
  if (git("rev-parse", "HEAD").toString().trim() !== headSha || git("status", "--porcelain").length)
    throw new Error("Checkout source is dirty or not the exact workflow SHA");
  const paths = git("ls-files", "-z").toString().split("\0").filter(Boolean).sort();
  const tree = new Map(git("ls-tree", "-r", "--full-tree", "-z", "HEAD").toString().split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match?.[2] || !match[3]) throw new Error("Source tree contains an unbound nonregular entry");
    return [match[3], match[2]] as const;
  }));
  if (!paths.length || paths.length !== tree.size) throw new Error("Complete source inventory mismatch");
  const canonical: Record<string, string> = {}, checkout: Record<string, string> = {}, gitBlobs: Record<string, string> = {};
  await mkdir(directory, { recursive: true });
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.split("/").some(part => part === ".." || part === "." || !part))
      throw new Error("Unsafe source path");
    const info = await lstat(path); if (!info.isFile() || info.size > 33554432) throw new Error("Unbound source layout or size");
    const raw = await readFile(path); let bytes = raw;
    if (path === "bin/sbar-orbit.cmd" || path === "install.cmd") {
      const attrs = git("check-attr", "text", "eol", "--", path).toString().trim().split(/\r?\n/);
      if (attrs[0] !== `${path}: text: set` || attrs[1] !== `${path}: eol: crlf` || raw.some(byte => byte > 127))
        throw new Error("Declared ASCII CMD normalization contract mismatch");
      const text = raw.toString("ascii").replace(/\r\n/g, "\n"); if (text.includes("\r")) throw new Error("Bare CR in source");
      bytes = Buffer.from(text, "ascii");
    }
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== tree.get(path)) throw new Error("Checkout bytes differ from exact source Git blob");
    canonical[path] = sha(bytes); checkout[path] = sha(raw); gitBlobs[path] = blob;
    if (phase === "before") {
      const destination = join(directory, "source", path); await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, raw, { flag: "wx" });
    }
  }
  const identity = { repository, repositoryId: Number(repositoryId), runId: Number(runId), attempt: Number(attempt), headSha,
    branch, event, workflowRef, workflowSha, jobName, jobKey, runnerOS: process.env.RUNNER_OS, bunVersion: Bun.version };
  let beforeSha256: string | null = null;
  if (phase === "after") {
    const raw = await readFile(join(directory, "source-before.json")), before = JSON.parse(raw.toString()); beforeSha256 = sha(raw);
    if (JSON.stringify(before.identity) !== JSON.stringify(identity) || JSON.stringify(before.canonical) !== JSON.stringify(canonical)
      || JSON.stringify(before.checkout) !== JSON.stringify(checkout) || JSON.stringify(before.gitBlobs) !== JSON.stringify(gitBlobs))
      throw new Error("Actual source changed during workload");
  }
  const record = { schema_version: 1, phase, identity, paths, canonical, checkout, gitBlobs, beforeSha256,
    sourceUnchanged: phase === "after", nativeHold: "0", createdAtUTC: new Date().toISOString() };
  const raw = Buffer.from(JSON.stringify(record, null, 2) + "\n"); await writeFile(join(directory, `source-${phase}.json`), raw, { flag: "wx" });
  if (phase === "before") {
    if (!process.env.GITHUB_ENV) throw new Error("Provider environment handoff unavailable");
    await writeFile(process.env.GITHUB_ENV, `ORBIT_PROVIDER_SOURCE_DIR=${directory}\n`, { flag: "a" });
  }
  console.log(JSON.stringify({ providerSourceCapture: phase, directory, sha256: sha(raw), identity }));
}
try { await main(); } catch (error) {
  console.log(JSON.stringify({ providerSourceCapture: "not measured", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
