import { OrbitError, record } from "./errors";

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
  fill: "write", click: "write", "close-tab": "write", paste: "write", text: "write", key: "write",
  pointer: "write", window: "write", launch: "irreversible", download: "irreversible",
};

export function classify(actionType: string): ActionClass {
  const known = classOfAction[actionType];
  // An action Orbit does not recognise is treated as the most consequential class, not the least.
  // A vocabulary grows, and the failure of a default should be a refusal, not a silent permit.
  return known ?? "irreversible";
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
  return { mode, origins, allow, deny };
}

export type PolicyDecision =
  | { outcome: "allow" }
  /** Refused outright. In autonomous mode this is the end of it: nothing waits for a person. */
  | { outcome: "deny"; reason: string }
  /** Supervised mode only: a person is asked. An autonomous session never produces this. */
  | { outcome: "ask"; reason: string };

/**
 * Decide one resolved action. `url` is the destination for a navigating action, already resolved by
 * the broker rather than taken from the model's intent, because those are not always the same thing.
 */
export function decide(policy: SessionPolicy, actionType: string, url?: string): PolicyDecision {
  const actionClass = classify(actionType);
  if (policy.deny.includes(actionClass))
    return { outcome: "deny", reason: `The ${actionClass} class is denied for this session and a deny is not overridable.` };
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
  if (policy.allow.includes(actionClass)) return { outcome: "allow" };
  const reason = `The ${actionClass} class is not allowed for this session.`;
  return policy.mode === "autonomous" ? { outcome: "deny", reason } : { outcome: "ask", reason };
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
  sequence: number;
  sessionId: string;
  actor: "agent" | "person";
  actionType: string;
  actionClass: ActionClass;
  /** Origin only. A full URL carries identifiers, search terms and tokens in its path and query. */
  origin?: string;
  outcome: "allow" | "deny" | "ask";
  reason?: string;
  /** Characters typed, never the characters themselves. */
  inputLength?: number;
};

export function journalEntry(input: {
  sequence: number; sessionId: string; actor: "agent" | "person"; actionType: string;
  decision: PolicyDecision; url?: string; inputLength?: number;
}): JournalEntry {
  let origin: string | undefined;
  if (input.url !== undefined) { try { origin = new URL(input.url).origin; } catch { origin = undefined; } }
  return {
    sequence: input.sequence, sessionId: input.sessionId, actor: input.actor,
    actionType: input.actionType, actionClass: classify(input.actionType),
    ...(origin ? { origin } : {}),
    outcome: input.decision.outcome,
    ...(input.decision.outcome === "allow" ? {} : { reason: input.decision.reason }),
    ...(input.inputLength === undefined ? {} : { inputLength: input.inputLength }),
  };
}
