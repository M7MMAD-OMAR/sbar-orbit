/**
 * What does the background scheduling class cost a browser session on this Mac?
 *
 * The macOS budget has two halves. The accounting half reads the kernel and refuses work that would
 * not fit. The scheduling half is `taskpolicy -b`, the darwin-background class, which is the only
 * part the SYSTEM enforces and the nearest analogue of the Linux slice's `CPUWeight=10` and
 * `IOWeight=10`. It is meant to keep the person's machine responsive while an agent works.
 *
 * It is not free, and this experiment is here because the size of the bill was never measured.
 * darwin-background is not only a CPU hint: it also sets throttled, low priority I/O, and on Apple
 * silicon it places threads on the efficiency cluster. A browser writing a fresh profile does a lot
 * of I/O, so the plausible failure is that a session which is merely slower on a workstation becomes
 * slow enough to miss a deadline on a small machine. Five browser driven suites time out on a two or
 * three core CI runner, and this is the first hypothesis worth ruling in or out.
 *
 * It matters twice over, because the class is INHERITED. `scripts/limited.ts` puts the whole suite
 * in it, so every browser a test starts is already background before `launchChrome` applies it
 * again. On a workstation that is invisible. On a three core runner it may be the whole story.
 *
 * The measurement: the same real work, launch and navigate and read, timed in both arms, several
 * rounds, alternating. Alternating rather than all-of-one-then-all-of-the-other so that a machine
 * that gets busier partway through does not hand the difference to whichever arm ran second.
 *
 * An honest result here can go either way. If the background class costs little, the timeouts are
 * something else and this rules out a suspect. If it costs a lot, the default is wrong for small
 * machines and the number says by how much.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import { launchChrome } from "../src/chrome";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ skipped: "this experiment measures the macOS scheduling class", platform: process.platform }));
  process.exit(0);
}

const rounds = Number(process.argv[2] ?? 3);

/** One session's real work, timed: launch, navigate to a local page, read it back, close. */
async function timeOneSession(background: boolean) {
  const profile = await mkdtemp(join(tmpdir(), "orbit-qos-"));
  // A local page, so the number is this machine's scheduling and not somebody's network.
  const server = Bun.serve({ port: 0, fetch: () => new Response("<h1 id=t>measured</h1>", { headers: { "Content-Type": "text/html" } }) });
  const started = performance.now();
  let launchMs = 0, navigateMs = 0, readMs = 0, failed: string | undefined;
  let session: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    // `ORBIT_DARWIN_BACKGROUND=0` is the switch `launchOnDarwin` reads. Set per arm rather than
    // per process, so both arms run in one process against one machine state.
    process.env.ORBIT_DARWIN_BACKGROUND = background ? "1" : "0";
    session = await launchChrome(profile);
    launchMs = Math.round(performance.now() - started);
    const navigateAt = performance.now();
    await session.page.goto(`http://127.0.0.1:${server.port}/`);
    navigateMs = Math.round(performance.now() - navigateAt);
    const readAt = performance.now();
    const text = await session.page.textContent("#t");
    readMs = Math.round(performance.now() - readAt);
    if (text !== "measured") failed = `read returned ${JSON.stringify(text)}`;
  } catch (error) {
    failed = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200);
  } finally {
    await session?.close().catch(() => {});
    server.stop(true);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    delete process.env.ORBIT_DARWIN_BACKGROUND;
  }
  return { launchMs, navigateMs, readMs, totalMs: launchMs + navigateMs + readMs, failed };
}

const samples: { round: number; background: boolean; launchMs: number; navigateMs: number; readMs: number; totalMs: number; failed?: string }[] = [];
for (let round = 0; round < rounds; round++) {
  // Alternating order per round, so a machine that warms up or gets busier does not systematically
  // favour one arm.
  const order = round % 2 === 0 ? [true, false] : [false, true];
  for (const background of order) samples.push({ round, background, ...await timeOneSession(background) });
}

const arm = (background: boolean) => samples.filter(sample => sample.background === background && !sample.failed);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};
const summary = (background: boolean) => {
  const rows = arm(background);
  return {
    sessions: rows.length,
    medianLaunchMs: median(rows.map(row => row.launchMs)),
    medianNavigateMs: median(rows.map(row => row.navigateMs)),
    medianTotalMs: median(rows.map(row => row.totalMs)),
  };
};

const withBackground = summary(true), without = summary(false);
const ratio = withBackground.medianTotalMs !== null && without.medianTotalMs
  ? Number((withBackground.medianTotalMs / without.medianTotalMs).toFixed(2)) : null;

console.log(JSON.stringify({
  experiment: "macos-qos-cost",
  date: new Date().toISOString(),
  host: { cpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)) },
  rounds,
  background: withBackground,
  foreground: without,
  // Above 1 means the background class makes a session slower, which is expected. The question this
  // experiment answers is BY HOW MUCH on a small machine, because a hint that costs 10% is a
  // courtesy and one that costs 3x is a deadline defect wearing a courtesy's clothes.
  backgroundCostRatio: ratio,
  failures: samples.filter(sample => sample.failed).map(({ round, background, failed }) => ({ round, background, failed })),
  samples,
  verdict: ratio === null ? "not measured: a session failed in one arm"
    : ratio >= 2 ? "the background class more than doubles a session here; the default is wrong for a machine this size"
    : ratio >= 1.3 ? "the background class costs real time here and is defensible; the figure belongs beside the claim"
    : "the background class is close to free here, so it is not what makes sessions miss deadlines",
}, null, 2));
