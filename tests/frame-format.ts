import { expect } from "bun:test";

/** A frame must carry the format it declares, so the viewer and MCP hosts can trust mimeType. */
export function expectDeclaredImage(frame: { image: string; mimeType?: string }, mimeType: string) {
  const bytes = Buffer.from(frame.image, "base64");
  if (frame.mimeType !== undefined) expect(frame.mimeType).toBe(mimeType);
  if (mimeType === "image/jpeg") expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  else expect(bytes.subarray(1, 4).toString()).toBe("PNG");
}
