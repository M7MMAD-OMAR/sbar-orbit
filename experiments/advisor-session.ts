import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * The autonomous path end to end, through the real broker and a real browser.
 *
 * Four things are being shown, and none of them stops to ask a person. A rule that says consult
 * reaches the advisor subprocess and its answer decides. An advisor that fails, in any of the ways an
 * advisor can fail, denies. An action that trips the immune table is refused whatever the policy
 * allows, and the session is contained afterwards. And a session can be narrowed but never widened.
 *
 * A fresh profile, so no real account and no real keyring are involved.
 */
await requireResourceBudget();
const root = await createWorkspaceDirectory("advisor-session");
const scripts = await mkdtemp(join(tmpdir(), "orbit-advisors-"));
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

async function advisor(name: string, body: string) {
  const path = join(scripts, `${name}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  return new Response(`<h1>page ${url.pathname}</h1>`, { headers: { "Content-Type": "text/html" } });
} });
const origin = `http://127.0.0.1:${site.port}`;

const sessions = new Sessions(root);
const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
const act = (session: object, action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
const outcome = (promise: Promise<unknown>) =>
  promise.then(() => "allowed", error => ({ refused: (error as { code?: string }).code, reason: (error as Error).message.slice(0, 120) }));

try {
  // A policy that consults on every click, so the advisor is genuinely in the path.
  const withAdvisor = async (command: string) => {
    const created = await run("session.create", {
      backend: "browser", taskName: "Advisor probe",
      policy: {
        mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"],
        rules: [{ id: "clicks-are-checked", verb: "click", decision: "consult", reason: "a click was singled out" }],
        advisor: { command: [command], timeoutMs: 2000 },
      },
    }) as { sessionId: string };
    const session = { sessionId: created.sessionId };
    await act(session, { type: "navigate", url: origin });
    return session;
  };

  const permissive = await withAdvisor(await advisor("yes", `cat >/dev/null; echo '{"decision":"allow","reason":"looked fine"}'`));
  report.advisorAllows = await outcome(act(permissive, { type: "click", selector: "h1" }));
  await run("session.stop", permissive);

  const strict = await withAdvisor(await advisor("no", `cat >/dev/null; echo '{"decision":"deny","reason":"not that one"}'`));
  report.advisorDenies = await outcome(act(strict, { type: "click", selector: "h1" }));
  // A refusal is not a crash: the session keeps working afterwards.
  report.usableAfterAdvisorDeny = await outcome(act(strict, { type: "read", selector: "h1" }));
  await run("session.stop", strict);

  const broken = await withAdvisor(await advisor("crash", `kill -9 $$`));
  report.advisorCrashDenies = await outcome(act(broken, { type: "click", selector: "h1" }));
  await run("session.stop", broken);

  const hung = await withAdvisor(await advisor("hang", `cat >/dev/null; sleep 30`));
  const started = Date.now();
  report.advisorHangDenies = await outcome(act(hung, { type: "click", selector: "h1" }));
  report.hangDecidedInMs = Date.now() - started;
  await run("session.stop", hung);

  // The immune table, against the most permissive policy the parser will produce: every class
  // allowed, nothing denied, autonomous, advisor configured.
  const permissiveCreated = await run("session.create", {
    backend: "browser", taskName: "Immune probe",
    policy: {
      mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write", "irreversible"], deny: [],
      rules: [{ id: "consult-everything", verb: ["navigate", "click"], decision: "consult", reason: "second opinion" }],
      advisor: { command: [await advisor("always-yes", `cat >/dev/null; echo '{"decision":"allow"}'`)], timeoutMs: 2000 },
    },
  }) as { sessionId: string; policy: { allow: string[] } };
  const immune = { sessionId: permissiveCreated.sessionId };
  report.policyBefore = permissiveCreated.policy.allow;
  await act(immune, { type: "navigate", url: origin });
  // An ordinary click is consulted and allowed, which proves the advisor really is in this path.
  report.ordinaryClick = await outcome(act(immune, { type: "click", selector: "h1" }));
  // This one trips the immune table, and the advisor never sees it.
  report.immuneAction = await outcome(act(immune, { type: "navigate", url: `${origin}/account/password` }));
  const contained = await run("session.journal", immune) as { policy: { allow: string[] }; entries: { immuneId?: string; decidedBy?: string; outcome: string }[] };
  report.policyAfterImmuneDeny = contained.policy.allow;
  // Containment: the write class is gone, so the next click fails even though the advisor says yes.
  report.clickAfterContainment = await outcome(act(immune, { type: "click", selector: "h1" }));
  report.readAfterContainment = await outcome(act(immune, { type: "read", selector: "h1" }));
  report.journalTail = contained.entries.slice(-4);

  // The durable copy: what is left after the broker is gone, which is how an autonomous run is
  // reviewed at all. Read from the file rather than from the API, and checked for what it must not
  // carry, because a journal in a project that clones browser profiles is a leak if it is careless.
  const durable = await run("session.journal", immune) as { path: string };
  const lines = (await Bun.file(durable.path).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  report.durableJournal = {
    path: durable.path.replace(process.env.HOME ?? "", "~"),
    mode: ((await Bun.file(durable.path).stat()).mode & 0o777).toString(8),
    lines: lines.length,
    firstLineIsTheAgreement: lines[0]?.actionType === "session.create",
    agreement: lines[0]?.reason,
    everyLineTimestamped: lines.slice(1).every(line => typeof line.at === "string"),
    everyActionCarriesItsRequestId: lines.slice(1).every(line => typeof line.requestId === "string"),
    outcomes: lines.map(line => line.outcome),
  };
  const raw = lines.map(line => JSON.stringify(line)).join("\n");
  report.journalCarriesNothingItShouldNot = {
    noUrlPath: !raw.includes("/account/password"),
    noQuery: !raw.includes("?"),
    noSelector: !raw.includes("h1"),
  };

  // Narrowing is available and one way.
  const narrowed = await run("session.narrow", { ...immune, allow: ["read"] }) as { policy: { allow: string[] } };
  report.afterNarrow = narrowed.policy.allow;
  const widened = await run("session.narrow", { ...immune, allow: ["read", "navigate", "write"] }) as { policy: { allow: string[] } };
  report.afterAttemptedWiden = widened.policy.allow;
  report.narrowRefusesEmpty = await outcome(run("session.narrow", immune));
  await run("session.stop", immune);
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  await sessions.close();
  site.stop(true);
  await rm(root, { recursive: true, force: true });
  await rm(scripts, { recursive: true, force: true });
}

await mkdir("output", { recursive: true, mode: 0o700 });
const path = join("output", `advisor-session-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
