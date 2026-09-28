import { formatCodexOwnerDryRun, prepareCodexOwnerLaunch } from "../src/codex-owner-launch";

const dryRun = process.argv[2] === "--dry-run";
const plan = await prepareCodexOwnerLaunch(process.argv.slice(dryRun ? 3 : 2));
if (dryRun) {
  console.log(formatCodexOwnerDryRun(plan));
} else {
  const child = Bun.spawn([plan.executable, ...plan.args], {
    env: plan.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.exitCode = await child.exited;
}
