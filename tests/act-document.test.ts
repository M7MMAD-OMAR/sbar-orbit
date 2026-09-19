/**
 * `act @path`, attacked as an input channel rather than exercised as a feature.
 *
 * `5576f11` added `@path` and `-` because PowerShell eats quotes, and the fix carried two defects of
 * its own, both found by the adversarial suite:
 *
 *   - the PARSER'S message was put into the error, and Bun quotes the offending token in it, so a
 *     file that could be read but not parsed had its first token echoed to stdout. `act s @secrets.env`
 *     answered with the name and value at the top of that file.
 *   - `Bun.file(path).text()` reads a character device without bound. `act s @/dev/zero` reached
 *     8.4 GiB resident in 8 seconds on Fedora 44, and a FIFO nobody writes to hangs instead.
 *
 * Neither is a privilege boundary: this CLI runs as the person and could read the file anyway. The
 * first is a disclosure into a channel that LEAVES the process, since an agent host captures stdout
 * and a person pastes a failed command into an issue. The second turns a mistyped path into an
 * out-of-memory event on a machine where several agents share one budget.
 *
 * These assert ABSENCE, which is the only assertion that means anything for a disclosure: that the
 * content is not in the message, not that some particular message is.
 */
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/sbar-orbit", import.meta.url));
const run = (args: string[], timeout = 30_000) => {
  const proc = Bun.spawnSync([cli, ...args], { stdout: "pipe", stderr: "pipe", timeout });
  return { out: proc.stdout.toString(), err: proc.stderr.toString(), code: proc.exitCode };
};

test("a file that cannot be parsed does not have its contents echoed back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-act-doc-"));
  try {
    // Shaped like the real thing this protects: a dotenv file whose FIRST token is the secret's name
    // and whose first line carries its value. Both are checked, because the parser quoted the name
    // and a different parser could quote the line.
    const secret = join(dir, "secrets.env");
    await writeFile(secret, "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI_NOT_A_REAL_KEY\nDB_PASSWORD=hunter2\n");
    const { out, err } = run(["act", "no-such-session", `@${secret}`]);
    const everything = out + err;

    // The failure is still REPORTED: this is not a test that would pass if the command silently
    // succeeded, which is the trap an absence assertion falls into.
    expect(everything).toContain("INVALID_REQUEST");
    expect(everything).toContain("is not JSON");
    // And nothing from inside the file appears anywhere in it.
    expect(everything).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(everything).not.toContain("wJalrXUtnFEMI_NOT_A_REAL_KEY");
    expect(everything).not.toContain("DB_PASSWORD");
    expect(everything).not.toContain("hunter2");
    // The parser's message is what carried the token, so its signature is checked directly.
    expect(everything).not.toContain("Unexpected identifier");
    // The PATH is still named, because a person with several files needs to know which one failed,
    // and a path they typed themselves is not a disclosure.
    expect(everything).toContain(secret);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

test("a character device is refused instead of being read without bound", () => {
  // /dev/zero never ends. Before this, the process grew until something killed it; the assertion is
  // that the command comes back at all, quickly, with a named refusal.
  const started = Date.now();
  const { out, err, code } = run(["act", "s", "@/dev/zero"], 20_000);
  const everything = out + err;
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(code).not.toBe(0);
  expect(everything).toContain("INVALID_REQUEST");
  expect(everything).toContain("not a regular file");
});

test("a FIFO nobody writes to is refused rather than hung on", async () => {
  // The quiet form of the same defect: no memory growth, no output, no error, forever. A timeout
  // kill would leave `code` null and an empty message, so the refusal is asserted positively.
  const dir = await mkdtemp(join(tmpdir(), "orbit-act-fifo-"));
  try {
    const fifo = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const { out, err, code } = run(["act", "s", `@${fifo}`], 20_000);
    const everything = out + err;
    expect(code).not.toBeNull();
    expect(everything).toContain("not a regular file");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

test("a regular file that IS valid JSON still reaches the broker", async () => {
  // The control, and the test that stops every assertion above from being satisfied by a CLI that
  // refuses everything. A valid document must get past the parser and fail for a REAL reason: the
  // session does not exist.
  const dir = await mkdtemp(join(tmpdir(), "orbit-act-ok-"));
  try {
    const document = join(dir, "action.json");
    await writeFile(document, JSON.stringify({ type: "observe" }));
    const { out, err } = run(["act", "definitely-not-a-session", `@${document}`]);
    const everything = out + err;
    expect(everything).not.toContain("INVALID_REQUEST");
    expect(everything).not.toContain("is not JSON");
    expect(everything).toContain("SESSION_NOT_FOUND");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

test("an oversized regular file is refused before it is read", async () => {
  // A regular file passes the device check and can still be enormous, so the ceiling is separate.
  //
  // The content is VALID JSON, and that is what makes this test bite. An earlier version filled the
  // file with `x`, which is not JSON, so with the ceiling disabled the file was read in full and
  // refused by the parser instead, whose message also reports a byte count. The test passed either
  // way and was measuring nothing: mutation showed it surviving the removal of the very ceiling it
  // was named for. Valid JSON has only one way to be refused here.
  const dir = await mkdtemp(join(tmpdir(), "orbit-act-big-"));
  try {
    const big = join(dir, "big.json");
    const padding = "y".repeat(1_048_576);
    const body = JSON.stringify({ type: "observe", padding });
    await writeFile(big, body);
    const { out, err } = run(["act", "definitely-not-a-session", `@${big}`]);
    const everything = out + err;
    expect(everything).toContain("INVALID_REQUEST");
    expect(everything).toContain(`${body.length} bytes`);
    expect(everything).toContain("mistyped path");
    // It must be refused for its SIZE, not parsed and passed on: a broker that answers
    // SESSION_NOT_FOUND here means the megabyte went through.
    expect(everything).not.toContain("SESSION_NOT_FOUND");
    // And still nothing from inside it.
    expect(everything).not.toContain("yyyyyyyyyy");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
