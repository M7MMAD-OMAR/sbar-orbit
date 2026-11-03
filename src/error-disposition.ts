import { OrbitError, normalizeDisposition, type ErrorDisposition } from "./errors";

/** Only use at an audited boundary before any action from this request was admitted. */
export const preflightDisposition: Readonly<ErrorDisposition> = Object.freeze({
  disposition: Object.freeze({ delivery: "not-delivered", retry: "safe" }), suggestion: "correct-request",
});

/** Policy refusal is not permission to replay, even when no native input was delivered. */
export const refusedDisposition: Readonly<ErrorDisposition> = Object.freeze({
  disposition: Object.freeze({ delivery: "not-delivered", retry: "unsafe" }), suggestion: "do-not-retry",
});

/** Never copy raw exception fields or derive retry safety from an error code. */
export function errorPayload(error: unknown, fallbackCode: string, fallbackMessage: string) {
  return {
    code: error instanceof OrbitError ? error.code : fallbackCode,
    message: error instanceof OrbitError ? error.message : fallbackMessage,
    ...(error instanceof OrbitError && error.diagnosticId !== undefined ? { diagnosticId: error.diagnosticId } : {}),
    ...normalizeDisposition(error instanceof OrbitError ? error : undefined),
  };
}
