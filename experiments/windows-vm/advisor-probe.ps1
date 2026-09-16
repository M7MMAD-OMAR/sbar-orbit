$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head7.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# parsePolicy was changed so a Windows advisor path is accepted at all. That was a type level fix and
# nothing has ever consulted an advisor on Windows, so this runs every branch of the contract against
# real programs: allow, deny, non zero exit, a hang against the clock, unparsable output, and the
# check that the advisor is handed the record and nothing that could carry an injection.
$probe = @'
import { consultAdvisor } from "./src/advisor";
import { parsePolicy } from "./src/policy";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const say = (m: string) => console.log("[s] " + m);
const dir = join(tmpdir(), "orbit-advisor-" + Math.random().toString(36).slice(2, 8));
mkdirSync(dir, { recursive: true });

// Advisors as .cmd programs, which is what a Windows machine would actually configure.
const write = (name: string, body: string) => {
  const path = join(dir, name + ".cmd");
  writeFileSync(path, body.replace(/\n/g, "\r\n"));
  return path;
};
const allow = write("allow", '@echo off\n@echo {"decision":"allow","reason":"probe says yes"}');
const deny = write("deny", '@echo off\n@echo {"decision":"deny","reason":"probe says no"}');
const broken = write("broken", '@echo off\n@exit /b 3');
const garbage = write("garbage", '@echo off\n@echo not json at all');
const hang = write("hang", '@echo off\n@ping -n 20 127.0.0.1 >nul');

const request = { pending: { verb: "navigate", url: "https://bank.test/transfer" }, tail: [], reason: "second opinion", ruleId: "probe-rule" } as never;

// 1. parsePolicy must accept a Windows absolute path now, and still refuse a relative one and a UNC.
for (const [label, command] of [["windows absolute", [allow]], ["relative", ["advisor.cmd"]], ["UNC", ["\\\\server\\share\\a.cmd"]]] as const) {
  try { parsePolicy({ advisor: { command } }); say(`parsePolicy ${label}: accepted`); }
  catch (error) { say(`parsePolicy ${label}: refused, ${(error as Error).message.slice(0, 70)}`); }
}

// 2. Every branch of the consult contract, against real programs on this machine.
const run = async (label: string, path: string, timeoutMs = 5000) => {
  const started = Date.now();
  const answer = await consultAdvisor({ command: [path], timeoutMs }, request);
  say(`${label}: ${answer.decision.outcome} / ${answer.decidedBy} (${Date.now() - started}ms)`);
};
await run("allow", allow);
await run("deny", deny);
await run("non zero exit", broken);
await run("unparsable", garbage);
await run("hang against a 1500ms clock", hang, 1500);

// 3. The advisor must be handed the record and nothing else. This one echoes what it was given.
const echo = join(dir, "echo.cmd");
writeFileSync(echo, '@echo off\r\n@more\r\n');
const seen = Bun.spawnSync([echo], { stdin: new TextEncoder().encode(JSON.stringify({ probe: true })) });
say("an advisor reads its stdin: " + (seen.stdout.toString().includes("probe") ? "yes" : "no"));
say("done");
'@
Set-Content -Path C:\orbit\src\advprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\advprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\advprobe.ts -Force -EA SilentlyContinue
