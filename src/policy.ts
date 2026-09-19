import { OrbitError, record } from "./errors";
import { isAbsolute } from "node:path";
import type { AdvisorConfig } from "./advisor";

/**
 * What an autonomous session is allowed to do, decided before it starts.
 *
 * A human confirmation step and an autonomous agent are the same mechanism at different times. The
 * confirmation asks a person at the moment of the action; the policy asks them once, in advance, and
 * then answers on their behalf. Orbit takes the second, because an agent that stops to ask cannot
 * finish a task alone, and an agent with no answer at all is not autonomous, it is unbounded.
 *
 * Three properties make this worth having rather than decorative.
 *
 * It is enforced in the broker, in code, over the RESOLVED action. The model chooses the arguments,
 * so a rule the model evaluates is a rule the model can talk itself out of.
 *
 * The origin allowlist is fixed when the session is created and can never be widened, only narrowed.
 * That is the one property that survives prompt injection: a page can say anything, and the set of
 * places the agent may go was already closed before the page was read.
 *
 * A deny is absolute. There is no override, no escalation and no mode in which a denied class runs,
 * because a deny that can be lifted by the thing it constrains is not a deny.
 */

/** What an action does to the world, which is what a person actually cares about authorizing. */
export type ActionClass =
  /** Observes without changing anything: read, observe, scroll, resize, select a tab. */
  | "read"
  /** Moves the session somewhere: navigate, open a tab. Checked against the origin allowlist. */
  | "navigate"
  /** Changes page state: fill, click, close a tab. Reversible only in the sense that it is local. */
  | "write"
  /**
   * Leaves the machine or cannot be taken back: a download, a form submission, a payment. Orbit
   * cannot always tell, so this class is for what it CAN tell, and the honest limit is written in
   * docs: a click on a send button is indistinguishable from any other click.
   */
  | "irreversible";

export const actionClasses: ActionClass[] = ["read", "navigate", "write", "irreversible"];

/** Orbit's action vocabulary, mapped to what each one does. Unknown actions are never assumed safe. */
const classOfAction: Record<string, ActionClass> = {
  read: "read", observe: "read", scroll: "read", resize: "read", "select-tab": "read",
  navigate: "navigate", "open-tab": "navigate",
  // Everything that changes state inside the session's own workspace. `launch` belongs here rather
  // than in the irreversible class: it starts an application on the private display, which is
  // disposable and whose descendants are reaped when the session stops, so it leaves nothing behind.
  // That is a statement about the display, not about the program: the native launcher is not
  // permission containment and does not make an arbitrary same-user command safe.
  fill: "write", click: "write", "close-tab": "write", paste: "write", text: "write", key: "write",
  pointer: "write", window: "write", launch: "write",
  // Leaves the workspace for the filesystem, so stopping the session does not take it back.
  download: "irreversible",
};

export function classify(actionType: string): ActionClass {
  const known = classOfAction[actionType];
  // An action Orbit does not recognise is treated as the most consequential class, not the least.
  // A vocabulary grows, and the failure of a default should be a refusal, not a silent permit.
  return known ?? "irreversible";
}

/**
 * A rule matches the RESOLVED action structurally, in order, with alternatives. It never matches a
 * URL as a string: a rule that matched text would be a rule the model can route around by spelling
 * the same destination differently.
 *
 * A rule can only lower a decision. It can turn an allowed class into a consult or a deny for one
 * origin and path; it can never turn a class level deny, or an immune id, into an allow.
 */
export type Rule = {
  /** Stable, and written verbatim into the journal so a denial can be traced to the line that caused it. */
  id: string;
  backend?: "browser" | "fedora";
  /** The action type, alternatives allowed. */
  verb: string | string[];
  origin?: string | string[];
  /** Matched on whole path segments, never as a substring, so /accounts cannot match /accounts-help. */
  pathPrefix?: string;
  method?: string;
  decision: "allow" | "deny" | "consult";
  reason: string;
};

/**
 * The actions no autonomy level clears.
 *
 * `ActionClass` cannot express these: `irreversible` is one bucket holding a download and a launch,
 * while money movement, a credential change and an account deletion are a different kind of thing
 * that a person would never fold into a class they also use for saving a file.
 *
 * The set is a module constant, not a policy field, because a per session immune list is a per
 * session way to omit one.
 *
 * The limit belongs here rather than in a footnote: these match a REQUEST, never a button. A click
 * on a send button is indistinguishable from any other click, so the table catches the request the
 * click causes, which is later and narrower. It cannot catch an unknown site's endpoint.
 */
export type ImmuneEntry = { id: string; reason: string; verb?: string[]; pathSegments: string[]; method?: string[]; query?: string[] };

export const immuneSet: ImmuneEntry[] = [
  { id: "money-movement", reason: "Moving money is not an action an unattended agent takes.",
    pathSegments: ["transfer", "transfers", "payment", "payments", "payout", "withdraw", "wire"], method: ["POST", "PUT"] },
  { id: "credential-change", reason: "Changing a password, an email or a recovery contact takes the account away from its owner.",
    pathSegments: ["password", "passwords", "recovery", "2fa", "mfa", "security-key", "changeemail"], method: ["POST", "PUT", "PATCH"] },
  { id: "message-send", reason: "A message sent on the person's behalf cannot be recalled.",
    pathSegments: ["sendmessage", "sendmail"], method: ["POST"] },
  { id: "account-deletion", reason: "Deleting or closing an account is the one action with no way back.",
    pathSegments: ["deleteaccount", "closeaccount", "terminate"], method: ["POST", "DELETE"] },
  { id: "oauth-grant", reason: "Granting an application access to the person's account hands it out to a third party.",
    pathSegments: ["oauth", "authorize", "consent"], query: ["response_type", "client_id"] },
];

/**
 * Whole path segments, lowercased and PERCENT DECODED, so a substring cannot be mistaken for a match
 * and an encoding cannot be mistaken for a different path.
 *
 * The decode is the half this was missing, and it defeated the immune set outright:
 * `new URL("https://bank.test/%74ransfer").pathname` is `/%74ransfer` verbatim, so the segment set
 * held `%74ransfer` while the table looked for `transfer`, and the money movement entry never fired.
 * Every ordinary web server decodes the path before routing, so those are one endpoint to the
 * service and two endpoints to the matcher. `docs/autonomy.md` names matching a URL as a string as
 * Orbit's "equivalent mistake"; this was that mistake surviving inside the structural matcher.
 * `/%70assword` and `/%6Fauth/authorize` defeated `credential-change` and `oauth-grant` the same way.
 *
 * Decoding is per segment and AFTER the split, never before: decoding the whole path first would let
 * `%2F` introduce a separator that was not in the request, which is the opposite mistake and turns
 * one segment into two. A segment that cannot be decoded, `%zz` or a lone `%`, keeps its raw form
 * rather than throwing, because a malformed escape is still a path some server will route somehow
 * and a matcher that throws on it stops protecting the rest of the request.
 *
 * Both spellings are kept, so a server that does NOT decode is covered too: the raw segment and the
 * decoded one are each matchable.
 */
function segmentsOf(pathname: string): string[] {
  const out: string[] = [];
  for (const raw of pathname.toLowerCase().split("/")) {
    if (!raw) continue;
    out.push(raw);
    if (!raw.includes("%")) continue;
    try {
      const decoded = decodeURIComponent(raw).toLowerCase();
      // A decode that produced separators is split again, so `%2f` cannot smuggle a segment past a
      // whole-segment comparison.
      for (const part of decoded.split("/")) if (part && part !== raw) out.push(part);
    } catch { /* A malformed escape keeps the raw spelling already pushed above. */ }
  }
  return out;
}

/**
 * The immune entry a resolved action trips, if any. Matched on the request's own shape rather than
 * on anything the page said about it.
 */
export function immuneMatch(actionType: string, url?: string, method?: string, methodIsImplied = false): ImmuneEntry | null {
  if (url === undefined) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const segments = new Set(segmentsOf(parsed.pathname));
  for (const entry of immuneSet) {
    if (entry.verb && !entry.verb.includes(actionType)) continue;
    // An IMPLIED method never narrows the immune set, only a stated one does. The broker supplies
    // GET for a navigation so that a person's rule naming a method can fire at all, and feeding that
    // same guess in here would have quietly disarmed this table: `money-movement` lists POST and
    // PUT, an implied GET is neither, and every navigation to a transfer endpoint would have walked
    // straight through a set that had caught it a moment earlier. That regression was real, and the
    // suite caught it: fixing the dead-rule defect broke the containment one.
    //
    // The asymmetry is deliberate. A rule is the person narrowing their own session and a guess that
    // makes it fire is doing what they asked. The immune set is the floor nobody clears, so it is
    // never narrowed by anything the broker inferred rather than observed.
    if (entry.method && method !== undefined && !methodIsImplied && !entry.method.includes(method.toUpperCase())) continue;
    if (!entry.pathSegments.some(segment => segments.has(segment))) continue;
    if (entry.query && !entry.query.every(key => parsed.searchParams.has(key))) continue;
    return entry;
  }
  return null;
}

export type SessionPolicy = {
  /**
   * supervised pauses on anything not allowed and waits for a person. autonomous never waits: it
   * refuses what the policy does not allow and carries on, which is what lets it finish alone.
   */
  mode: "supervised" | "autonomous";
  /**
   * Origins this session may reach, as scheme plus host plus optional port. Never widened later.
   *
   * "any" means unbounded, and it is spelled out rather than implied by an empty list so that it is
   * greppable and cannot be reached by forgetting a field. It is correct for the session Orbit has
   * always created, which starts from an empty profile and holds no credentials: there is nothing to
   * steer such a session toward. It is refused for a session carrying the person's real logins, and
   * `requireBoundedOrigins` is where that refusal lives.
   */
  origins: string[] | "any";
  /** Classes permitted without a person. Anything absent is refused. */
  allow: ActionClass[];
  /** Classes refused unconditionally, even if also listed in allow. Evaluated last and never lifted. */
  deny: ActionClass[];
  /** Narrowing rules, evaluated after the immune table and before the class check. */
  rules?: Rule[];
  /** Spawned only when a rule says consult, so it never runs on a read. */
  advisor?: AdvisorConfig;
};

/** Look, do not touch, go nowhere that was not named in advance. The right policy for a session that carries real logins. */
export const readOnlyPolicy: SessionPolicy = { mode: "supervised", origins: [], allow: ["read"], deny: ["irreversible"] };

/**
 * The default for a session that starts from an empty profile, which is every session Orbit creates
 * today. It holds no credentials, so bounding where it may go protects nothing and would only break
 * the agent. What it still refuses is the irreversible class, including any action Orbit does not
 * recognise, because that is about the machine rather than about the person's accounts.
 */
export const freshProfilePolicy: SessionPolicy = { mode: "supervised", origins: "any", allow: ["read", "navigate", "write"], deny: ["irreversible"] };

/**
 * A session holding the person's real logins must name where it may go. This is the single refusal
 * that makes the clone survivable: a page can say anything, and the set of reachable origins was
 * closed before the page was read.
 */
export function requireBoundedOrigins(policy: SessionPolicy): string[] {
  if (policy.origins === "any")
    throw new OrbitError("INVALID_REQUEST", "A session carrying real browser sessions must name the origins it may reach; unbounded origins are refused for it.");
  if (!policy.origins.length)
    throw new OrbitError("INVALID_REQUEST", "Name at least one origin this session may reach.");
  return policy.origins;
}

function normaliseOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new OrbitError("INVALID_REQUEST", "An origin must be a non-empty string");
  // A bare wildcard is refused rather than normalised. A session holding the person's real logins
  // with an unbounded origin set is the case this whole module exists to prevent, so there is no
  // spelling of it that Orbit accepts.
  if (value === "*" || value.includes("://*")) throw new OrbitError("INVALID_REQUEST", "A wildcard origin is not allowed; name each origin the session may reach");
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `https://${value}`); }
  catch { throw new OrbitError("INVALID_REQUEST", `Not a usable origin: ${value.slice(0, 80)}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OrbitError("INVALID_REQUEST", "Origins must be http or https");
  return url.origin;
}

/** Action classes on their own, with no cross field rule attached. Narrowing needs exactly this. */
export function parseActionClasses(value: unknown, field = "allow"): ActionClass[] {
  if (!Array.isArray(value)) throw new OrbitError("INVALID_REQUEST", `Policy ${field} must be an array of action classes`);
  return value.map(entry => {
    if (!actionClasses.includes(entry as ActionClass))
      throw new OrbitError("INVALID_REQUEST", `Unknown action class in ${field}: ${String(entry).slice(0, 40)}`);
    return entry as ActionClass;
  });
}

/** Origins on their own, normalised and deduplicated. Narrowing needs exactly this. */
export function parseOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) throw new OrbitError("INVALID_REQUEST", "Origins must be an array");
  if (value.length > 64) throw new OrbitError("INVALID_REQUEST", "Name at most 64 origins");
  return [...new Set(value.map(normaliseOrigin))];
}

export function parsePolicy(value: unknown): SessionPolicy {
  const input = record(value);
  const mode = input.mode === undefined ? "supervised" : String(input.mode);
  if (mode !== "supervised" && mode !== "autonomous") throw new OrbitError("INVALID_REQUEST", "Policy mode must be supervised or autonomous");
  const list = (field: unknown, name: string): ActionClass[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) throw new OrbitError("INVALID_REQUEST", `Policy ${name} must be an array of action classes`);
    return field.map(entry => {
      if (!actionClasses.includes(entry as ActionClass)) throw new OrbitError("INVALID_REQUEST", `Unknown action class in ${name}: ${String(entry).slice(0, 40)}`);
      return entry as ActionClass;
    });
  };
  const origins: string[] | "any" = input.origins === undefined ? [] : input.origins === "any" ? "any" : (() => {
    if (!Array.isArray(input.origins)) throw new OrbitError("INVALID_REQUEST", "Policy origins must be an array of origins, or the string \"any\"");
    if (input.origins.length > 64) throw new OrbitError("INVALID_REQUEST", "Name at most 64 origins for one session");
    return [...new Set(input.origins.map(normaliseOrigin))];
  })();
  const allow = input.allow === undefined ? readOnlyPolicy.allow : list(input.allow, "allow");
  // An omitted deny is not an empty deny. The irreversible class covers downloads, launches and
  // every action Orbit does not recognise, so leaving it out of the request must not quietly permit
  // it. Reaching those takes two deliberate statements: name the class in allow AND pass an explicit
  // deny that does not contain it.
  const deny = input.deny === undefined ? [...readOnlyPolicy.deny] : list(input.deny, "deny");
  // Navigation with no origin named cannot be satisfied by any URL, so it is a contradiction rather
  // than a permission. Saying so at creation is better than refusing every navigation later.
  if (allow.includes("navigate") && origins !== "any" && !origins.length)
    throw new OrbitError("INVALID_REQUEST", "Allowing navigate requires naming at least one origin the session may reach, or \"any\" for a session with no real logins");
  const rules = input.rules === undefined ? undefined : (() => {
    if (!Array.isArray(input.rules)) throw new OrbitError("INVALID_REQUEST", "Policy rules must be an array");
    if (input.rules.length > 256) throw new OrbitError("INVALID_REQUEST", "At most 256 rules for one session");
    return input.rules.map(entry => {
      const rule = record(entry);
      if (typeof rule.id !== "string" || !rule.id.trim()) throw new OrbitError("INVALID_REQUEST", "Every rule needs a stable id");
      if (!["allow", "deny", "consult"].includes(String(rule.decision)))
        throw new OrbitError("INVALID_REQUEST", `Rule ${rule.id} needs a decision of allow, deny or consult`);
      const verb = rule.verb;
      if (typeof verb !== "string" && !(Array.isArray(verb) && verb.every(v => typeof v === "string")))
        throw new OrbitError("INVALID_REQUEST", `Rule ${rule.id} needs a verb, or a list of them`);
      // NORMALISED, not merely validated. This line used to be `origins.forEach(normaliseOrigin)`,
      // which threw on a malformed origin and then discarded every normalised value, so the rule was
      // stored with whatever spelling the caller wrote. `ruleMatches` then compared that raw string
      // against a normalised request origin, and the only spelling that could ever match was the
      // canonical one. `example.test`, `https://example.test/` and `HTTPS://example.test` were all
      // accepted, reported back as held, and matched NOTHING: a narrowing rule that fails open while
      // reading as enforced, which is the worst failure mode a policy has.
      const normalisedOrigin = rule.origin === undefined ? undefined
        : Array.isArray(rule.origin) ? rule.origin.map(normaliseOrigin) : normaliseOrigin(rule.origin);
      return {
        id: rule.id, verb: verb as string | string[], decision: rule.decision as Rule["decision"],
        reason: typeof rule.reason === "string" && rule.reason.trim() ? rule.reason : `Rule ${rule.id}.`,
        ...(rule.backend === undefined ? {} : { backend: rule.backend as Rule["backend"] }),
        ...(normalisedOrigin === undefined ? {} : { origin: normalisedOrigin }),
        ...(rule.pathPrefix === undefined ? {} : { pathPrefix: String(rule.pathPrefix) }),
        ...(rule.method === undefined ? {} : { method: String(rule.method) }),
      } satisfies Rule;
    });
  })();
  const advisor = input.advisor === undefined ? undefined : (() => {
    const given = record(input.advisor);
    if (!Array.isArray(given.command) || !given.command.length || given.command.some(part => typeof part !== "string"))
      throw new OrbitError("INVALID_REQUEST", "An advisor needs a command, as an array of strings");
    const first = given.command[0];
    // Absolute, so the broker never resolves an advisor through PATH: that would let whatever the
    // agent host happened to export decide which program approves an action. `startsWith("/")` said
    // that in POSIX terms only, which rejected every valid Windows path and left the advisor
    // impossible to configure there. `isAbsolute` is the same rule in the platform's own terms, and
    // a UNC path is refused because a policy should not consult a program across the network.
    if (typeof first !== "string" || !isAbsolute(first) || first.startsWith("\\\\"))
      throw new OrbitError("INVALID_REQUEST", "An advisor command must name an absolute local executable");
    const timeoutMs = given.timeoutMs === undefined ? 5000 : Number(given.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
      throw new OrbitError("INVALID_REQUEST", "An advisor timeout must be between 100 and 30000 ms");
    return { command: given.command as string[], timeoutMs };
  })();
  return { mode, origins, allow, deny, ...(rules ? { rules } : {}), ...(advisor ? { advisor } : {}) };
}

export type PolicyDecision =
  | { outcome: "allow" }
  /** Refused outright. In autonomous mode this is the end of it: nothing waits for a person. */
  | { outcome: "deny"; reason: string; ruleId?: string; immuneId?: string }
  /** Supervised mode only: a person is asked. An autonomous session never produces this. */
  | { outcome: "ask"; reason: string }
  /**
   * Autonomous only: the advisor subprocess decides. A separate outcome from `ask` on purpose,
   * because `ask` means a person is waiting and overloading it would make the supervised path
   * ambiguous.
   */
  | { outcome: "consult"; reason: string; ruleId: string };

/**
 * Decide one resolved action. `url` is the destination for a navigating action, already resolved by
 * the broker rather than taken from the model's intent, because those are not always the same thing.
 */
function ruleMatches(rule: Rule, actionType: string, url?: string, method?: string): boolean {
  const verbs = Array.isArray(rule.verb) ? rule.verb : [rule.verb];
  if (!verbs.includes(actionType)) return false;
  if (rule.method && (method === undefined || rule.method.toUpperCase() !== method.toUpperCase())) return false;
  if (rule.origin === undefined && rule.pathPrefix === undefined) return true;
  if (url === undefined) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (rule.origin !== undefined) {
    const origins = Array.isArray(rule.origin) ? rule.origin : [rule.origin];
    if (!origins.includes(parsed.origin)) return false;
  }
  if (rule.pathPrefix !== undefined) {
    // Whole segments, so /accounts does not match /accounts-help.
    const wanted = segmentsOf(rule.pathPrefix), actual = segmentsOf(parsed.pathname);
    if (wanted.length > actual.length || wanted.some((segment, index) => actual[index] !== segment)) return false;
  }
  return true;
}

/** deny is stricter than consult, which is stricter than allow. The strictest matching rule wins. */
const severity = { allow: 0, consult: 1, deny: 2 } as const;

export function decide(policy: SessionPolicy, actionType: string, url?: string, method?: string, methodIsImplied = false): PolicyDecision {
  const actionClass = classify(actionType);
  if (policy.deny.includes(actionClass))
    return { outcome: "deny", reason: `The ${actionClass} class is denied for this session and a deny is not overridable.` };
  // Evaluated before every allow, and never routed to the advisor: a model judging a model is the
  // wrong instrument for the actions nobody should take unattended.
  const immune = immuneMatch(actionType, url, method, methodIsImplied);
  if (immune) return { outcome: "deny", reason: immune.reason, immuneId: immune.id };
  if (actionClass === "navigate") {
    // A navigating action with no destination stays inside the session, so the allowlist has nothing
    // to check; open-tab with no url is the blank tab case.
    if (url !== undefined && policy.origins !== "any") {
      let origin: string;
      try { origin = new URL(url).origin; }
      catch { return { outcome: "deny", reason: "That destination is not a usable URL." }; }
      if (!policy.origins.includes(origin))
        return { outcome: "deny", reason: `${origin} is not in this session's origin allowlist, which was fixed when the session was created.` };
    }
  }
  // Rules can lower a decision and never raise one, so they are read only after the class is known
  // to be permitted and only to make it stricter.
  const matched = (policy.rules ?? []).filter(rule => ruleMatches(rule, actionType, url, method));
  const strictest = matched.reduce<Rule | null>((worst, rule) =>
    !worst || severity[rule.decision] > severity[worst.decision] ? rule : worst, null);
  if (strictest?.decision === "deny") return { outcome: "deny", reason: strictest.reason, ruleId: strictest.id };
  if (!policy.allow.includes(actionClass)) {
    const reason = `The ${actionClass} class is not allowed for this session.`;
    return policy.mode === "autonomous" ? { outcome: "deny", reason } : { outcome: "ask", reason };
  }
  if (strictest?.decision === "consult") {
    // With nobody there a consult must resolve to a decision, so a session with no advisor configured
    // refuses rather than quietly allowing what a rule singled out for a second opinion.
    if (!policy.advisor) return { outcome: "deny", reason: `${strictest.reason} No advisor is configured to decide it.`, ruleId: strictest.id };
    return { outcome: "consult", reason: strictest.reason, ruleId: strictest.id };
  }
  return { outcome: "allow" };
}

/**
 * Narrow a policy. Widening is deliberately not offered: there is no function here that adds an
 * origin or an allowed class to a running session, because the value of the allowlist is that a page
 * the agent reads cannot cause it to grow.
 */
export function narrow(policy: SessionPolicy, limits: { origins?: string[]; allow?: ActionClass[] }): SessionPolicy {
  // Narrowing "any" to a named list is a narrowing, so it is allowed; the reverse never is.
  const origins: string[] | "any" = limits.origins
    ? (policy.origins === "any" ? [...limits.origins] : policy.origins.filter(origin => limits.origins?.includes(origin)))
    : policy.origins;
  const allow = limits.allow ? policy.allow.filter(entry => limits.allow?.includes(entry)) : policy.allow;
  return { ...policy, origins, allow };
}

/**
 * One line of what the session did, for a person reading afterwards instead of approving in advance.
 *
 * Redaction is part of the shape, not a later pass. A journal that quoted what was typed would carry
 * passwords, and one that quoted page text would carry the contents of the person's real accounts, so
 * neither is recorded: an action is identified by its class, its type, its destination origin and the
 * size of what it carried.
 */
export type JournalEntry = {
  /** When, so a run can be read back in order after the broker that wrote it is gone. */
  at?: string;
  /** The caller's own id for the action, which is how a retry is told from a second attempt. */
  requestId?: string;
  sequence: number;
  sessionId: string;
  actor: "agent" | "person";
  actionType: string;
  actionClass: ActionClass;
  /** Origin only. A full URL carries identifiers, search terms and tokens in its path and query. */
  origin?: string;
  outcome: "allow" | "deny" | "ask" | "consult";
  reason?: string;
  /** The rule that caused it, verbatim, so a denial can be traced to the line responsible. */
  ruleId?: string;
  /** The immune entry it tripped, if any. Present only on a denial nothing can lift. */
  immuneId?: string;
  /** Who decided a consult: the advisor, or the failure that closed it. */
  decidedBy?: string;
  /** Characters typed, never the characters themselves. */
  inputLength?: number;
  /**
   * The origins the session held AFTER this entry, present only on an entry that changed them.
   *
   * A policy is fixed when a session is created and can only be tightened afterwards, by the person
   * narrowing it or by an immune denial containing the session. Both leave the create line describing
   * a session that no longer exists, so the entry that moved the boundary carries where it moved it to.
   * Without this a reader has to replay every narrowing to know what was in force at a given line.
   */
  afterOrigins?: string[] | "any";
  /** The action classes still allowed after this entry, on the same terms. */
  afterAllow?: ActionClass[];
};

export function journalEntry(input: {
  sequence: number; sessionId: string; actor: "agent" | "person"; actionType: string;
  decision: PolicyDecision; url?: string; inputLength?: number; decidedBy?: string;
  at?: string; requestId?: string; after?: SessionPolicy;
}): JournalEntry {
  let origin: string | undefined;
  if (input.url !== undefined) { try { origin = new URL(input.url).origin; } catch { origin = undefined; } }
  return {
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    sequence: input.sequence, sessionId: input.sessionId, actor: input.actor,
    actionType: input.actionType, actionClass: classify(input.actionType),
    ...(origin ? { origin } : {}),
    outcome: input.decision.outcome,
    ...(input.decision.outcome === "allow" ? {} : { reason: input.decision.reason }),
    ...("ruleId" in input.decision && input.decision.ruleId ? { ruleId: input.decision.ruleId } : {}),
    ...("immuneId" in input.decision && input.decision.immuneId ? { immuneId: input.decision.immuneId } : {}),
    ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }),
    ...(input.inputLength === undefined ? {} : { inputLength: input.inputLength }),
    ...(input.after === undefined ? {} : { afterOrigins: input.after.origins, afterAllow: input.after.allow }),
  };
}
