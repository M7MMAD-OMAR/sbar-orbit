import { expect } from "bun:test";

/** A frame must carry the format it declares, so the viewer and MCP hosts can trust mimeType. */
export function expectDeclaredImage(frame: { image: string; mimeType?: string }, mimeType: string) {
  const bytes = Buffer.from(frame.image, "base64");
  if (frame.mimeType !== undefined) expect(frame.mimeType).toBe(mimeType);
  if (mimeType === "image/jpeg") expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  else expect(bytes.subarray(1, 4).toString()).toBe("PNG");
}

/** Dimensions read from the encoded bytes, so a frame cannot claim a size it did not capture at. */
export function jpegSize(image: string): { width: number; height: number } {
  const bytes = Buffer.from(image, "base64");
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]!;
    const length = bytes.readUInt16BE(at + 2);
    // Start of frame markers carry the dimensions; every other segment is skipped by its length.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new Error("No JPEG frame header found");
}
