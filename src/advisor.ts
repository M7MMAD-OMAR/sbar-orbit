import type { JournalEntry, PolicyDecision } from "./policy";

/**
 * A second opinion on the part of the action space the policy deliberately left open.
 *
 * When nobody is watching, a rule that says "consult" has to resolve to a decision. This is what
 * resolves it: a subprocess given one JSON object and expected to answer with one, in the shape
 * Claude Code's PreToolUse hook uses, because that shape is already proven to work for exactly this.
 *
 * What it is NOT, and the code should not be read as claiming otherwise: a security boundary. It is
 * a model judging a model, on an action derived from attacker controlled input. That is why it is
 * never consulted on an immune id, and why the immune set is checked before this is ever reached.
 *
 * Everything about it fails closed. A non zero exit, a timeout, unparsable output, an answer that is
 * not exactly allow or deny: all of them deny, and the recorded reason is the failure itself rather
 * than a guess about what the advisor meant.
 */

export type AdvisorConfig = { command: string[]; timeoutMs: number };

export type AdvisorAnswer = { decision: PolicyDecision; decidedBy: string };

/** What the advisor is told. The redacted record and the tail, never page text and never typed characters. */
export type AdvisorRequest = {
  pending: JournalEntry;
  /** Recent decisions, so it can see a pattern rather than one action out of context. */
  tail: JournalEntry[];
  reason: string;
  ruleId: string;
};

const deny = (reason: string, ruleId: string, decidedBy: string): AdvisorAnswer =>
  ({ decision: { outcome: "deny", reason, ruleId }, decidedBy });

export async function consultAdvisor(config: AdvisorConfig, request: AdvisorRequest): Promise<AdvisorAnswer> {
  const [executable, ...rest] = config.command;
  if (!executable) return deny("The advisor has no command configured.", request.ruleId, "advisor-misconfigured");
  // An advisor that reads the page is one more thing to inject, so it is given the record and
  // nothing else. Every field here already passed the journal's redaction.
  const payload = JSON.stringify({ pending: request.pending, tail: request.tail, reason: request.reason, ruleId: request.ruleId });

  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([executable, ...rest], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }); }
  catch (error) { return deny(`The advisor could not be started: ${String(error).slice(0, 120)}`, request.ruleId, "advisor-unstartable"); }

  const timeout = Math.min(Math.max(config.timeoutMs, 100), 30000);
  try {
    const writer = child.stdin as { write(text: string): unknown; end(): unknown };
    writer.write(payload);
    writer.end();
    const answered = await Promise.race([
      (async () => {
        const text = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
        const code = await child.exited;
        return { text, code };
      })(),
      // A hung advisor is a stalled session, and a stalled session is the thing autonomy exists to
      // avoid, so the clock is part of the contract rather than a safety net.
      Bun.sleep(timeout).then(() => null),
    ]);
    if (answered === null) return deny(`The advisor did not answer within ${timeout} ms.`, request.ruleId, "advisor-timeout");
    if (answered.code !== 0) return deny(`The advisor exited with code ${answered.code}.`, request.ruleId, "advisor-failed");
    let parsed: unknown;
    try { parsed = JSON.parse(answered.text); }
    catch { return deny("The advisor's answer was not JSON.", request.ruleId, "advisor-unparsable"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return deny("The advisor's answer was not an object.", request.ruleId, "advisor-unparsable");
    const answer = parsed as { decision?: unknown; reason?: unknown };
    const reason = typeof answer.reason === "string" && answer.reason.trim()
      ? answer.reason.slice(0, 300) : "The advisor gave no reason.";
    // There is no third answer, because there is nobody to ask.
    if (answer.decision === "allow") return { decision: { outcome: "allow" }, decidedBy: "advisor-allowed" };
    if (answer.decision === "deny") return { decision: { outcome: "deny", reason, ruleId: request.ruleId }, decidedBy: "advisor-denied" };
    return deny(`The advisor answered ${JSON.stringify(answer.decision)?.slice(0, 40)}, which is neither allow nor deny.`, request.ruleId, "advisor-unparsable");
  } catch (error) {
    return deny(`The advisor failed: ${String(error).split("\n").at(0)?.slice(0, 120)}`, request.ruleId, "advisor-failed");
  } finally {
    // Whatever happened, it does not outlive the decision it was asked for.
    child.kill();
    await child.exited.catch(() => {});
  }
}
