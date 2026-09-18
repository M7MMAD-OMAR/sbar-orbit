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
} else if (process.platform === "darwin") {
  // macOS has no cgroup and no named job object, so the budget is a registered process group and
  // this is where a command joins one. Three steps, in this order:
  //
  //   1. This process becomes a group leader, so the command and everything it starts inherit one
  //      group id the kernel can enumerate.
  //   2. The group is written into the shared registry, which is what makes the pool shared across
  //      independently started Orbit processes.
  //   3. The command runs under `taskpolicy -b`, the darwin-background class, which on Apple
  //      silicon places its threads on the efficiency cluster. That is the scheduling half of the
  //      budget and the only half the system enforces.
  //
  // Step 3 is a hint and steps 1 and 2 are accounting. Nothing here is a ceiling, which is why
  // `requireResourceBudget()` reports `enforcement: "advisory"` on this platform.
  const { becomeGroupLeader, signalProcessGroup, SIGNAL } = await import("../src/macos");
  const { registerBudgetGroup, unregisterBudgetGroup } = await import("../src/macos-budget");
  const pgid = becomeGroupLeader();
  await registerBudgetGroup("limited");
  // `taskpolicy` is in the base system on every supported version and is still resolved rather than
  // assumed: a machine without it runs the command unhinted rather than refusing to run it at all,
  // because the accounting half of the budget is in place either way and that is what the ceiling
  // is read from.
  //
  // Skipped when this process is ALREADY in the background class, which happens whenever one
  // budgeted command starts another. The class is inherited, so re-applying it spawns a process per
  // nesting level and changes nothing.
  const { inheritedBackgroundClass } = await import("../src/macos");
  const background = !inheritedBackgroundClass() && await Bun.file("/usr/sbin/taskpolicy").exists()
    ? ["/usr/sbin/taskpolicy", "-b"] : [];
  const child = Bun.spawn([...background, executable, ...args.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // Signals go to the GROUP, not to the child: the point of the group is that everything the
  // command started is addressable, and forwarding to one pid would leave a browser tree behind.
  const forward = () => { signalProcessGroup(pgid, SIGNAL.TERM); };
  process.on("SIGTERM", forward); process.on("SIGINT", forward);
  try { process.exitCode = await child.exited; }
  finally {
    process.off("SIGTERM", forward); process.off("SIGINT", forward);
    await unregisterBudgetGroup(pgid);
  }
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
