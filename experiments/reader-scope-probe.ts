/** Manual-only real cgroup probe. Never opens, reads or controls an application. */
import { join } from "node:path";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Manual owned reader cgroup probe: bun experiments/reader-scope-probe.ts --run (Linux, Orbit budget required). No desktop/app operations.");
    return;
  }
  if (args.length !== 1 || args[0] !== "--run" || process.platform !== "linux")
    throw new Error("Use --help, or explicitly --run on Linux inside the Orbit resource budget");
  const child = Bun.spawn(["/usr/bin/python3", "-I", "-S", join(import.meta.dir, "reader-scope-probe.py"), "--run"], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error("Owned reader cgroup probe failed; inspect its private artifacts and unresolved debt");
}
if (import.meta.main) await main();
