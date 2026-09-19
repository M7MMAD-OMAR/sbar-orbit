import { test, expect } from "bun:test";
import { assertWritableTarget } from "../src/observation-output";
import { OrbitError } from "../src/errors";

/**
 * The output path shapes Windows accepts and Orbit must not.
 *
 * `open(path, "wx")` was the whole validator. It refuses an existing file and refuses to follow a
 * symlink, and on a Windows 11 guest it was MEASURED to accept all of the following, each of which
 * writes somewhere the caller did not name:
 *
 *     ACCEPTED: "C:\\orbit\\adstest\\notes.txt:hidden"
 *     ACCEPTED: "NUL"
 *     ACCEPTED: "CON"
 *     ACCEPTED: "C:\\orbit\\adstest\\trail.png "
 *     ACCEPTED: "C:\\orbit\\adstest\\dot.png."
 *
 * and after that run `Get-Item notes.txt -Stream *` reported two streams, `:$DATA` at 22 bytes and
 * `hidden` at 8, with `dir` showing only `notes.txt`. So the alternate data stream is not reasoned
 * from NTFS documentation, it was written onto an existing file and then read back.
 *
 * The validator is platform-gated, because a colon is legal in a POSIX file name and refusing it on
 * Linux would break real paths. That gate is what these tests have to work around: they call the
 * validator directly and skip the Windows-only assertions off Windows rather than pretending a Linux
 * run measured them.
 */

const windowsOnly = process.platform !== "win32";

test.skipIf(windowsOnly)("an alternate data stream on the person's own file is refused", () => {
  // The attack: the host file exists, so nothing is overwritten and `wx` is satisfied, while the bytes
  // land in a stream that `dir` and Explorer do not show.
  expect(() => assertWritableTarget("C:\\Users\\someone\\notes.txt:hidden")).toThrow(OrbitError);
  // A drive-relative path with a stream is the same attack without the drive prefix.
  expect(() => assertWritableTarget("\\shots\\frame.png:stash")).toThrow(OrbitError);
});

test.skipIf(windowsOnly)("reserved device names are refused, with or without an extension", () => {
  for (const name of ["NUL", "CON", "PRN", "AUX", "COM1", "LPT9", "nul", "Con"])
    expect(() => assertWritableTarget(`C:\\shots\\${name}`)).toThrow(OrbitError);
  // `NUL.png` reaches the device just as `NUL` does, which is why the stem is what gets tested.
  for (const name of ["NUL.png", "CON.jpeg", "com3.png"])
    expect(() => assertWritableTarget(`C:\\shots\\${name}`)).toThrow(OrbitError);
});

test.skipIf(windowsOnly)("a trailing dot or space is refused, because Windows strips it silently", () => {
  // Windows creates `frame.png`, so the file written is not the path validated and not the path
  // reported back to the caller.
  expect(() => assertWritableTarget("C:\\shots\\frame.png ")).toThrow(OrbitError);
  expect(() => assertWritableTarget("C:\\shots\\frame.png.")).toThrow(OrbitError);
  // A directory segment counts too: the stripping applies at every level.
  expect(() => assertWritableTarget("C:\\shots \\frame.png")).toThrow(OrbitError);
});

test.skipIf(windowsOnly)("an ordinary Windows path is still accepted", () => {
  // The drive prefix has a colon in it, so a validator that simply banned colons would refuse every
  // absolute Windows path. This is the case that catches that mistake.
  const ordinary = "C:\\Users\\someone\\Pictures\\frame.png";
  expect(assertWritableTarget(ordinary)).toBe(ordinary);
  expect(assertWritableTarget("C:\\shots\\connection.png")).toBe("C:\\shots\\connection.png");
  // `CONS` is not `CON`: only the exact device names are reserved.
  expect(assertWritableTarget("C:\\shots\\CONS.png")).toBe("C:\\shots\\CONS.png");
});

test.skipIf(!windowsOnly)("on POSIX a colon is a legal file name and stays legal", () => {
  // Gating the rule on the platform is deliberate, and this asserts the gate rather than assuming it:
  // refusing a colon on Linux would break paths people really use.
  const posix = "/tmp/shots/frame:1.png";
  expect(assertWritableTarget(posix)).toBe(posix);
  expect(assertWritableTarget("/tmp/NUL")).toBe("/tmp/NUL");
});
