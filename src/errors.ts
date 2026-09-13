export class OrbitError extends Error {
  constructor(public code: string, message: string, public diagnosticId?: string) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrbitError("INVALID_REQUEST", "Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 16384) throw new OrbitError("INVALID_REQUEST", `Invalid ${field}`);
  return value;
}
