/**
 * Chrome's native messaging framing, as bytes rather than as a library call.
 *
 * The extension side never sees this: `chrome.runtime.connectNative` hands the service worker
 * parsed JSON. The host program on the other end of the pipe does see it, and so does anything
 * that wants to test the wire without a browser, which is the whole reason it is a module here.
 *
 * Two facts that are easy to get wrong and impossible to notice when they are wrong, because a
 * mis-framed message is silence rather than an error:
 *
 *   The length prefix is four bytes in NATIVE byte order, not network order. A big endian constant
 *   works on nothing this project runs on and would look correct in review.
 *
 *   Chrome's own limit is one megabyte per message from a host to an extension. The cap below is
 *   this project's choice to apply the same ceiling in both directions, not a platform fact.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;

/** Decided at runtime, because the correct answer is whatever this machine is. */
export const nativeLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export type FrameRead =
  | { ok: true; messages: unknown[]; rest: Uint8Array }
  | { ok: false; code: "MALFORMED_ENVELOPE" | "FRAME_TOO_LARGE"; detail: string };

export function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES) throw new RangeError(`Frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  const framed = new Uint8Array(4 + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, nativeLittleEndian);
  framed.set(body, 4);
  return framed;
}

/**
 * Read every whole message in the buffer and hand back what is left over. A stream delivers
 * whatever the kernel had, so a partial frame is the ordinary case and not a failure: it is
 * returned in `rest` for the next read to complete.
 */
export function decodeFrames(buffer: Uint8Array): FrameRead {
  const messages: unknown[] = [];
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  while (buffer.length - offset >= 4) {
    const length = view.getUint32(offset, nativeLittleEndian);
    // A length this side cannot honour is refused rather than buffered, because waiting for the
    // remainder of a frame that will never be accepted is how a reader is made to hold memory.
    if (length > MAX_FRAME_BYTES) return { ok: false, code: "FRAME_TOO_LARGE", detail: `Frame declares ${length} bytes` };
    if (buffer.length - offset - 4 < length) break;
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); }
    catch { return { ok: false, code: "MALFORMED_ENVELOPE", detail: "Frame body is not JSON" }; }
    messages.push(parsed);
    offset += 4 + length;
  }
  return { ok: true, messages, rest: buffer.subarray(offset) };
}
