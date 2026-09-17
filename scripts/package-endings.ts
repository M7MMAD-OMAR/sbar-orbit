/**
 * Batch files leave the packager with CRLF endings, the way `.gitattributes` gives them to a checkout.
 *
 * `.gitattributes` says `*.cmd text eol=crlf`, but that governs CHECKOUT. `scripts/package.ts` reads
 * raw bytes from the git index, where the file is stored with LF, so the published archive shipped
 * `install.cmd` and `bin/sbar-orbit.cmd` with 0 CRLF and 45 bare LF. That was measured by unpacking
 * the real release on a Windows guest, not inferred: see docs/windows-measured.md section 22.
 *
 * cmd.exe reads a batch file byte by byte, and a multi line `( )` block in an LF only file is where
 * that goes wrong. It happens to work today only because both files were written without such a
 * block, deliberately. That is a landmine rather than a design: the next person to add one would
 * break the published release while every git checkout, and every test, kept passing.
 *
 * Its own module so a test can import it without running the packager, which writes to a fixed
 * output directory and refuses to overwrite an existing archive.
 */
export function windowsLineEndings(path: string, bytes: Buffer): Buffer {
  if (!path.endsWith(".cmd") && !path.endsWith(".bat")) return bytes;
  // Normalise first, so a file already stored with CRLF is not doubled into blank lines.
  return Buffer.from(bytes.toString("binary").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "binary");
}

/**
 * The lines of `text` that end in a bare LF, which is what a batch file must not ship with.
 *
 * Here rather than in each test, because this is the same definition `windowsLineEndings` is written
 * against, and a test that spells it out separately can drift from the rule it is checking.
 */
export function bareLineFeeds(text: string) {
  return text.split("\n").filter(line => line.length && !line.endsWith("\r"));
}

