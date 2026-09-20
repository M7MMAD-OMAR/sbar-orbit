import { darwinTaskPolicy } from "../src/macos-scheduling";
import { requireResourceBudget } from "../src/resource-budget";
import { budget } from "../src/service";

const args = process.argv.slice(2);
if (!args.length) throw new Error("Usage: bun run scripts/limited.ts COMMAND [ARGS]");
const executable = Bun.which(args[0]!);
if (!executable) throw new Error("Command executable not found");

/*
 * The website is a SEPARATE workspace with its own bun.lock, and `bun test` from the repository root
 * walks the whole tree and finds `website/tests/locale.test.tsx` whether or not that workspace was
 * installed. Those tests contain JSX, so Bun injects `react/jsx-dev-runtime` at TRANSPILE time,
 * before a single line of the file runs: no lazy import and no `test.skip` can prevent it, which I
 * confirmed by trying exactly that and watching it fail anyway. The run reports
 * `Cannot find module 'react/jsx-dev-runtime'` and reads as a platform failure.
 *
 * Three machines have paid for that now. The Windows 11 guest, where it cost a debugging round and
 * is recorded in docs/windows-measured.md line 1248. The CI runners, where both workflows carry an
 * explicit website install step with a comment saying why. And the Fedora gate 3 VM, where it was
 * the one red line in an otherwise clean suite and had to be explained before the number could be
 * published.
 *
 * So the condition is NAMED here, in the one place every budgeted command passes through, rather
 * than being rediscovered on the next machine. This does not hide the failure and does not skip the
 * tests: it prints the cause and the one command that fixes it, before the run starts.
 */
if (args.slice(1).includes("test")) {
  const site = new URL("../website/", import.meta.url);
  const hasTests = await Bun.file(new URL("tests/locale.test.tsx", site)).exists();
  const installed = await Bun.file(new URL("node_modules/react/package.json", site)).exists();
  if (hasTests && !installed) {
    console.error("note: website/ is a separate workspace and is not installed here, so website/tests/locale.test.tsx");
    console.error("      will fail to resolve react/jsx-dev-runtime. That is a missing dependency, not a platform result.");
    console.error("      Run `cd website && bun install --frozen-lockfile --ignore-scripts` to make those tests runnable.");
  }
}

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
  //   3. The command runs under a utility QoS clamp, below interactive work but
  //      without maintenance-style background I/O throttling. The kernel applies
  //      this scheduling policy; it does not impose a CPU or memory ceiling.
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
  const policy = darwinTaskPolicy(inheritedBackgroundClass());
  const background = policy.length && await Bun.file("/usr/sbin/taskpolicy").exists()
    ? ["/usr/sbin/taskpolicy", ...policy] : [];
  const child = Bun.spawn([...background, executable, ...args.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // Signals go to the GROUP, not to the child: the point of the group is that everything the
  // command started is addressable, and forwarding to one pid would leave a browser tree behind.
  //
  // `killpg` to one's OWN group delivers to this process too, which re-enters this handler and
  // signals the group again. An audit probe reproduced the re-entry, and the only thing that kept it
  // from being an unbounded loop is that a signal arriving during handler execution is not queued.
  // Relying on that is relying on a coincidence of delivery semantics, so the handler is made
  // idempotent instead and detached after the first pass: one sweep of the group is the whole
  // intent, and the second and later passes were never doing anything but re-signalling the dead.
  let forwarded = false;
  const forward = () => {
    if (forwarded) return;
    forwarded = true;
    process.off("SIGTERM", forward); process.off("SIGINT", forward);
    signalProcessGroup(pgid, SIGNAL.TERM);
  };
  process.on("SIGTERM", forward); process.on("SIGINT", forward);
  try { process.exitCode = await child.exited; }
  finally {
    process.off("SIGTERM", forward); process.off("SIGINT", forward);
    await unregisterBudgetGroup(pgid);
  }
} else if (process.platform === "win32") {
  // Windows has no cgroup and no systemd, and its ceiling is a named JOB OBJECT: a kernel object that
  // carries a committed-memory limit and a process limit, which every process assigned to it counts
  // against. `joinSharedBudget` creates it on first use and joins it afterwards, so independently
  // started Orbit processes share one pool the same way the cgroup and the process group do.
  //
  // This branch did not exist. On Windows the code fell through to the Linux arm below and spawned
  // `/usr/bin/systemctl`, which is not a path Windows has, so `bun run verify` could not work there at
  // all: the suite ran unbudgeted, and every test that starts a broker failed with
  // RESOURCE_LIMIT_REQUIRED. That reads as 34 unrelated product failures rather than as one missing
  // branch, which is exactly how it presented.
  //
  // Unlike the macOS arm this is a real ceiling, not a hint: the kernel refuses the allocation rather
  // than scheduling it later, which is why `requireResourceBudget()` reports `job-object` here and
  // `advisory` there.
  const { joinSharedBudget } = await import("../src/windows-job");
  // The same two numbers `requireWindowsBudget` joins with, so the pool this creates is the pool that
  // check then accepts. Stated once in `src/service.ts`, as on the other two platforms.
  const { memoryMiB } = await import("../src/service");
  const pool = joinSharedBudget({ memoryBytes: memoryMiB * 1048576, processes: 1536 });
  if (!pool.joined) throw new Error(`Cannot join the shared Orbit job object (Win32 assignment error ${pool.assignmentError ?? "unknown"})`);
  // Assignment is INHERITED, so the command and everything it starts are inside the job without
  // being assigned individually, and killing the job takes the tree.
  const child = Bun.spawn([executable, ...args.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  try { process.exitCode = await child.exited; }
  finally { /* The job object is released when the last handle closes, which is this process exiting. */ }
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
