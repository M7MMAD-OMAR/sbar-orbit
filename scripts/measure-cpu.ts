import { readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

// Read-only, bounded observation. This does not start a broker, browser or agent.
const seconds = Number(process.argv[2] ?? 5);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)
  throw new Error("Duration must be an integer from 1 to 30 seconds");
const before = await readCpuSample();
await Bun.sleep(seconds * 1000);
const after = await readCpuSample();
console.log(JSON.stringify({ ...cpuInterval(before, after),
  scope: "all-orbit-jobs-including-this-sampler",
  limitation: "Host totals include the external viewer and unrelated applications; they do not attribute usage to either. Counter reads are approximate, not atomic.",
}, null, 2));
