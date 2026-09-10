import { OrbitError, record } from "./errors";

/**
 * Session surface size. A session starts at the default and can be resized, because an application
 * that needs room is unusable in a small window and a bigger surface costs capture time on every
 * frame. The cap is a total pixel count rather than per dimension, so an unusual shape is allowed
 * while the cost of a frame stays bounded. See docs/resources.md for the measured curve.
 */
export const defaultViewport = { width: 1280, height: 800 };
export const viewportLimits = { minimum: 320, maximum: 3840, pixels: 1920 * 1200 };

export interface Viewport { width: number; height: number }

export function parseViewport(value: unknown): Viewport {
  const size = record(value);
  const side = (input: unknown, name: string) => {
    if (!Number.isInteger(input) || Number(input) < viewportLimits.minimum || Number(input) > viewportLimits.maximum)
      throw new OrbitError("INVALID_REQUEST", `Session ${name} must be a whole number of pixels from ${viewportLimits.minimum} to ${viewportLimits.maximum}`);
    return Number(input);
  };
  const width = side(size.width, "width"), height = side(size.height, "height");
  if (width * height > viewportLimits.pixels)
    throw new OrbitError("INVALID_REQUEST", `Session surface is capped at ${viewportLimits.pixels} pixels, which is 1920 by 1200; every frame is captured and encoded at this size`);
  return { width, height };
}

/** Coordinates are validated against the session's current surface, not a fixed size. */
export function requireInside(size: Viewport, x: unknown, y: unknown): { x: number; y: number } {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= size.width || y >= size.height)
    throw new OrbitError("INVALID_REQUEST", `Coordinates outside the session surface of ${size.width} by ${size.height}`);
  return { x, y };
}
