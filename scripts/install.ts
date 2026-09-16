import { join } from "node:path";
import { runInstall, stepTitles, type StepRecord } from "../src/install";
import { InstallDisplay, offerings, supportsDisplay, type StepView } from "../src/install-ui";
import { requireResourceBudget } from "../src/resource-budget";
import { connectorConfigDirectory } from "../src/service";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (flag("--help") || flag("-h")) {
  console.log(`Usage: sbar-orbit install [options]

  --prefix PATH     Where the sbar-orbit command is linked (default ~/.local)
  --no-service      Write nothing into systemd and start nothing
  --dry-run         Report every step without changing anything
  --reinstall-deps  Run bun install even when dependencies already resolve
  --native          Build the private display runtime (downloads Fedora packages, compiles)
  --json            Print the report only, for a script rather than a person
  --plain           One line per step, no repainting`);
  process.exit(0);
}
/** One line a person can copy. The values come from the step that wrote the file, not from a guess. */
function connectorCommand(report: { steps: { id: string; data?: Record<string, unknown> }[] }) {
  const written = report.steps.find(step => step.id === "connector")?.data as { configuration?: { mcpServers: { orbit: unknown } } } | undefined;
  const server = written?.configuration?.mcpServers.orbit;
  if (server) return `claude mcp add-json orbit '${JSON.stringify(server)}'`;
  // The fallback names the file this platform actually writes, and reads it the way this platform
  // reads one. A hardcoded `~/.config/...` and `$(cat ...)` printed on Windows would tell a person to
  // read a file that is not there with a shell they are not running.
  const path = join(connectorConfigDirectory(), "mcp.json");
  // cmd.exe has no command substitution, so there is no one-liner equivalent of `$(cat ...)`: a
  // pasted `%(type ...)%` would reach the tool literally. PowerShell does have one, and naming the
  // shell it needs is better than inventing a flag for a tool this project does not own.
  return process.platform === "win32"
    ? `powershell -c "claude mcp add-json orbit (Get-Content -Raw '${path}')"`
    : `claude mcp add-json orbit "$(cat ${path})"`;
}

const json = flag("--json");
const plain = flag("--plain") || json;

// The same budget every other Orbit entry point runs inside. An installer that stepped around it
// would be the one command in the project that can take the desktop down.
await requireResourceBudget();

const views: StepView[] = stepTitles.map(step => ({ ...step, state: "pending", detail: "", elapsedMs: 0 }));
const display = new InstallDisplay(text => { if (!json) process.stdout.write(text); }, !plain && supportsDisplay());
let offering = 0;
const rotate = setInterval(() => { display.setNote(offerings[offering++ % offerings.length]!); }, 3400);
display.setNote(offerings[0]!);
display.start(views);

const report = await runInstall({
  prefix: value("--prefix"),
  service: !flag("--no-service"),
  dryRun: flag("--dry-run"),
  reinstallDependencies: flag("--reinstall-deps"),
  native: flag("--native"),
  onStep(id, state, record?: StepRecord) {
    const view = views.find(entry => entry.id === id);
    if (!view) return;
    view.state = state === "running" ? "running" : state;
    if (record) { view.detail = record.detail; view.elapsedMs = record.elapsedMs; }
    display.update(views);
  },
}).finally(() => clearInterval(rotate));

display.stop();

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const command = report.steps.find(step => step.id === "launcher")?.state === "done" ? report.launcher : join(report.source, "bin/sbar-orbit");
  if (report.installed) {
    display.summary(report.dryRun ? "Nothing was changed. This is what the run would do." : "Orbit is installed.", [
      `  Browser sessions:  ${report.capabilities.browserSessions ? "ready" : "not available on this machine yet"}`,
      `  Native sessions:   ${report.capabilities.nativeSessions ? "ready" : "not available on this machine yet"}`,
      "",
      "  Try it:",
      `    ${command} status`,
      `    ${command} session create`,
      `    ${command} preview`,
      "",
      "  Give an agent host the connector:",
      `    ${connectorCommand(report)}`,
    ], report.remedies.length ? "warn" : "good");
  } else {
    const failed = report.steps.filter(step => step.state === "failed");
    display.summary("Orbit is not installed.", failed.map(step => `  ${step.title}: ${step.detail}`), "bad");
  }
  if (report.remedies.length) {
    // Elevation first, because that is the part nobody here can do, and each one carries its command
    // on its own line so it can be copied without editing.
    const lines: string[] = [];
    for (const remedy of [...report.remedies].sort((a, b) => Number(b.needsElevation) - Number(a.needsElevation))) {
      lines.push(`  ${remedy.needsElevation ? "needs a package manager" : "yours to decide"}: ${remedy.message}`);
      if (remedy.command) lines.push(`      ${remedy.command}`);
    }
    display.summary("Left for you, because it needs a package manager or a decision:", lines, "warn");
  }
  display.summary("What this run did not check:", [`  ${report.verified}`], "warn");
}

process.exitCode = report.installed ? 0 : 1;
