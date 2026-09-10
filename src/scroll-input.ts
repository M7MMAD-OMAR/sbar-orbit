import { OrbitError, record } from "./errors";

export type ScrollInput = { type: "scroll"; x: number; y: number; deltaY: number };

/** Wheel steps are shared; each backend maps them to its own input protocol. */
export function parseScrollInput(value: unknown): ScrollInput {
  const input = record(value);
  if (input.type !== "scroll" || !Number.isInteger(input.x) || !Number.isInteger(input.y)
    || Number(input.x) < 0 || Number(input.x) >= 1280 || Number(input.y) < 0 || Number(input.y) >= 800
    || !Number.isInteger(input.deltaY) || Number(input.deltaY) === 0 || Math.abs(Number(input.deltaY)) > 20)
    throw new OrbitError("INVALID_REQUEST", "Scroll requires viewport coordinates and nonzero integer wheel steps from -20 to 20");
  return { type: "scroll", x: Number(input.x), y: Number(input.y), deltaY: Number(input.deltaY) };
}
