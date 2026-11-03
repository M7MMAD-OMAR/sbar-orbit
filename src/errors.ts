/** Delivery of this attempt, not a guarantee about earlier attempts or permission to retry. */
export interface ErrorDisposition {
  disposition: { delivery: "not-delivered" | "delivered" | "unknown"; retry: "safe" | "unsafe" };
  suggestion: "correct-request" | "observe-before-retry" | "do-not-retry";
}

export const unknownDisposition: Readonly<ErrorDisposition> = Object.freeze({
  disposition: Object.freeze({ delivery: "unknown", retry: "unsafe" }), suggestion: "observe-before-retry",
});

/** Accept only coherent, content-free tuples. Missing or malformed metadata proves nothing. */
export function normalizeDisposition(value: unknown): ErrorDisposition {
  const fallback = (): ErrorDisposition => ({ disposition: { ...unknownDisposition.disposition }, suggestion: unknownDisposition.suggestion });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback();
  const candidate = value as Record<string, unknown>;
  if (!candidate.disposition || typeof candidate.disposition !== "object" || Array.isArray(candidate.disposition)) return fallback();
  const disposition = candidate.disposition as Record<string, unknown>;
  if (disposition.delivery === "not-delivered" && disposition.retry === "safe" && candidate.suggestion === "correct-request")
    return { disposition: { delivery: "not-delivered", retry: "safe" }, suggestion: "correct-request" };
  if ((disposition.delivery === "not-delivered" || disposition.delivery === "delivered" || disposition.delivery === "unknown") &&
      disposition.retry === "unsafe" && (candidate.suggestion === "observe-before-retry" || candidate.suggestion === "do-not-retry"))
    return { disposition: { delivery: disposition.delivery, retry: "unsafe" }, suggestion: candidate.suggestion };
  return fallback();
}

export class OrbitError extends Error implements ErrorDisposition {
  readonly disposition: Readonly<ErrorDisposition["disposition"]>;
  readonly suggestion: ErrorDisposition["suggestion"];
  constructor(public code: string, message: string, public diagnosticId?: string, metadata?: unknown) {
    super(message);
    const normalized = normalizeDisposition(metadata);
    this.disposition = Object.freeze(normalized.disposition);
    this.suggestion = normalized.suggestion;
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrbitError("INVALID_REQUEST", "Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 16384) throw new OrbitError("INVALID_REQUEST", `Invalid ${field}`);
  return value;
}
