import { requireResourceBudget } from "../src/resource-budget";
import { budget } from "../src/service";

const args = process.argv.slice(2);
if (!args.length) throw new Error("Usage: bun run scripts/limited.ts COMMAND [ARGS]");
const executable = Bun.which(args[0]!);
if (!executable) throw new Error("Command executable not found");
let alreadyLimited = false;
try { await requireResourceBudget(); alreadyLimited = true; } catch {}
if (alreadyLimited) {
  const child = Bun.spawn([executable, ...args.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const terminate = () => child.kill("SIGTERM");
  const interrupt = () => child.kill("SIGINT");
  process.on("SIGTERM", terminate); process.on("SIGINT", interrupt);
  try { process.exitCode = await child.exited; }
  finally { process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); }
} else {
  const settings = Bun.spawn(["/usr/bin/systemctl", "--user", "set-property", "--runtime", "sbarorbit.slice",
    ...Object.entries(budget).map(([key, value]) => `${key}=${value}`)], { stdout: "inherit", stderr: "inherit" });
  if (await settings.exited !== 0) throw new Error("Cannot enforce the shared Orbit resource budget");
  const unit = `sbarorbit-${crypto.randomUUID()}.scope`;
  const child = Bun.spawn(["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--slice=sbarorbit.slice",
    "--expand-environment=no", "/usr/bin/nice", "-n", "10", executable, ...args.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const stop = async () => {
    const cleanup = Bun.spawn(["/usr/bin/systemctl", "--user", "stop", unit], { stdout: "ignore", stderr: "ignore" });
    await cleanup.exited;
  };
  const signal = () => { void stop(); };
  process.on("SIGTERM", signal); process.on("SIGINT", signal);
  try { process.exitCode = await child.exited; }
  finally { await stop(); process.off("SIGTERM", signal); process.off("SIGINT", signal); }
}
