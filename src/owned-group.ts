import { readFile } from "node:fs/promises";

/**
 * A supervisor that is killed outright never runs its own reaping loop, so the application it owned
 * keeps running with nothing above it. The application is started in a session of its own, which
 * makes it the leader of its own process group, so the group is what is left to address.
 *
 * Ownership is checked before any signal is sent. A process identifier alone is not evidence: the
 * number can be reused by an unrelated program between the supervisor's death and this sweep. The
 * private runtime directory in the process environment is what says the process came from this
 * session, and leading its own group is what says a group signal stays inside it.
 */
export async function ownsGroup(pid: number, directory: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || !directory.startsWith("/")) return false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // A command name can hold spaces and parentheses, so the fields are read after the last ")".
    // They are state, parent, group, session; a group equal to the identifier is a group leader.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) !== pid) return false;
    // A zombie reads back an empty environment. It holds nothing and cannot be reaped from here,
    // so it counts as gone rather than as something to signal again.
    const environ = await readFile(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`XDG_RUNTIME_DIR=${directory}`);
  } catch { return false; }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Terminate a group that outlived its supervisor. Graceful first, then not, because the reason this
 * path exists at all is that the process that would have asked politely is already dead.
 */
export async function sweepOwnedGroup(pid: number, directory: string, graceMs = 1000, pollMs = 25) {
  if (!await ownsGroup(pid, directory)) return { swept: false, escalated: false };
  try { process.kill(-pid, "SIGTERM"); }
  catch { return { swept: false, escalated: false }; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (!await ownsGroup(pid, directory)) return { swept: true, escalated: false };
  }
  try { process.kill(-pid, "SIGKILL"); } catch { return { swept: true, escalated: false }; }
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(pollMs);
    if (!await ownsGroup(pid, directory)) break;
  }
  return { swept: true, escalated: true };
}
