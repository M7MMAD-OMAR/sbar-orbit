import { inspectPrerequisites } from "../src/preflight";

if (process.argv.length > 2) throw new Error("Usage: sbar-orbit preflight");
const report = await inspectPrerequisites();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.browserPrerequisitesFound ? 0 : 1;
