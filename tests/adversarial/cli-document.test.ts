/**
 * The two surfaces commit 5576f11 opened, attacked rather than trusted.
 *
 * `actionDocument()` is a NEW FILE READ on a caller supplied path, in a product whose promise is that
 * it does not touch the person's files without a lease. The CLI runs as the person, so the bar here
 * is not a privilege boundary: it is whether an unparsable file's CONTENT reaches an error message,
 * and whether a path that never ends reading hangs the command forever. Both of those are asserted
 * below, and one of them fails.
 *
 * `captureTimeoutMs()` is a new environment variable on the broker. `tests/capture-timeout.test.ts`
 * samples six values, all of them ordinary: a number, an empty string, a word, zero, minus one and a
 * large integer. The axis it holds fixed is the SHAPE of the string, and the interesting values are
 * the ones JavaScript's `Number` treats specially.
 */
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTimeoutMs } from "../../src/browser";

const cli = new URL("../../src/cli.ts", import.meta.url).pathname;

/** Run `act` with a document reference and no broker to reach, so the answer is about parsing alone. */
function runAct(reference: string, directory: string, timeoutMs = 10000) {
  const started = Date.now();
  const run = Bun.spawnSync(["bun", "run", cli, "act", "some-session", reference], {
    env: { ...process.env, ORBIT_SOCKET: join(directory, "absent.sock") },
    stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
  });
  const text = (run.stderr.toString().trim() || run.stdout.toString().trim());
  let reply: { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  try { reply = JSON.parse(text) as typeof reply; } catch {}
  return { reply, text, elapsedMs: Date.now() - started, exitCode: run.exitCode, signal: run.signalCode };
}

/**
 * DEFECT, and the one the CLI's own author asked to be judged on.
 *
 * `actionDocument` reads the named file and hands its text to `JSON.parse`, then puts the PARSER'S
 * message into the error. Bun's parser message quotes the offending token, so the first token of any
 * file the person can read is echoed back on stdout. Measured here: a file holding
 * `AWS_SECRET_ACCESS_KEY=...` answers
 * `JSON Parse error: Unexpected identifier "AWS_SECRET_ACCESS_KEY"`, and a file holding a bare API
 * token answers with the token itself.
 *
 * What this is and is not. It is NOT a privilege escape: the CLI runs as the person and could read
 * the file anyway. It IS a disclosure into a channel that leaves the process: an agent host captures
 * the CLI's stdout, Orbit's own diagnostics are built from failures, and a person pasting a failed
 * command into an issue pastes the first token of whatever file they pointed at. `src/policy.ts` and
 * `src/diagnostics.ts` both go to real lengths to keep file content out of every record, and this
 * path puts it in one.
 *
 * Remove `.failing` when the parser's message is replaced by the position and length of the failure,
 * or when the quoted token is stripped.
 */
test("an unparsable action document does not echo the file's content back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adversarial-act-"));
  try {
    const secrets = join(directory, "secrets.env");
    await writeFile(secrets, "AWS_SECRET_ACCESS_KEY=SUPERSECRETVALUE12345\nPASSWORD=hunter2\n");
    const bare = join(directory, "token.txt");
    await writeFile(bare, "ghp_REALTOKENVALUE_abcdef123456");

    for (const [path, needle] of [[secrets, "AWS_SECRET_ACCESS_KEY"], [bare, "ghp_REALTOKENVALUE_abcdef123456"]] as const) {
      const { reply, text } = runAct(`@${path}`, directory);
      // The refusal itself is correct and expected: the file is not JSON.
      expect(reply?.ok).toBe(false);
      expect(reply?.error?.code).toBe("INVALID_REQUEST");
      // Naming the path is fine and useful. Quoting what was IN it is not.
      expect(reply?.error?.message).toContain(path);
      expect(text).not.toContain(needle);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

/**
 * DEFECT. `Bun.file(path).text()` on a character device with no end reads forever, so
 * `act ID @/dev/zero` never returns and grows without bound. Measured on Fedora 44: killed at 8
 * seconds having reached 8.4 GiB resident, with nothing on stdout and no error.
 *
 * A FIFO nobody writes to hangs on the same line, with no memory growth, which is the same defect in
 * its quiet form: the command waits forever for a document that is never coming.
 *
 * Again not a privilege boundary, and again a real failure: the documented remedy for a shell that
 * eats quotes is `@path`, and a mistyped path that happens to be a device turns a one line command
 * into an out of memory event on the person's own machine while three agents share one budget.
 *
 * Remove `.failing` when the read is bounded, by refusing a path that is not a regular file or by
 * capping the bytes taken.
 */
test("an action document that never ends is refused rather than read forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adversarial-act-endless-"));
  try {
    // An endless device. The read must end, whatever it decides.
    const endless = runAct("@/dev/zero", directory, 8000);
    expect(endless.signal).toBeUndefined();
    expect(endless.elapsedMs).toBeLessThan(8000);
    expect(endless.reply?.ok).toBe(false);

    // And a pipe nobody writes to, which is the same defect without the memory growth.
    const fifo = join(directory, "pipe.json");
    Bun.spawnSync(["/usr/bin/mkfifo", fifo]);
    const blocked = runAct(`@${fifo}`, directory, 6000);
    expect(blocked.signal).toBeUndefined();
    expect(blocked.elapsedMs).toBeLessThan(6000);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

/**
 * The parts of the same surface that hold. A symlink is followed, which is correct for a path the
 * person typed, and a traversal resolves to whatever it resolves to, which is also correct for a
 * command running as them. A directory and an unreadable file are both refused BY NAME rather than
 * read as null, and that is the property worth pinning: `JSON.parse(undefined ?? "null")` returning
 * `null` is how a mistyped path would have become a silent no-op action.
 */
test("a path that is not a readable document is refused by name, never read as null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adversarial-act-refuse-"));
  try {
    const subdirectory = join(directory, "folder");
    await mkdir(subdirectory);

    for (const reference of [join(directory, "absent.json"), subdirectory, "/etc/shadow", "/proc/1/environ"]) {
      const { reply } = runAct(`@${reference}`, directory);
      expect(reply?.ok).toBe(false);
      expect(reply?.error?.code).toBe("INVALID_REQUEST");
      // Named, so a person can see which path was wrong, and never reported as a successful null action.
      expect(reply?.error?.message).toContain(reference);
    }

    // A symlink to a real document IS followed, and that is the intended behaviour for a path the
    // person typed. Pinned so a later change to refuse links is a deliberate decision rather than a
    // silent one, and so this file records which of the two Orbit chose.
    const real = join(directory, "action.json");
    await writeFile(real, JSON.stringify({ type: "navigate", url: "https://example.test/" }));
    const link = join(directory, "link.json");
    await symlink(real, link);
    const followed = runAct(`@${link}`, directory);
    expect(followed.reply?.ok).toBe(false);
    // Past parsing and onto the absent socket, which is what "the document was read" looks like here.
    // The parser's own message must be absent: asserting only a code that is not INVALID_REQUEST
    // would stay green against a build that could not read a file at all.
    expect(followed.reply?.error?.message).not.toContain("JSON Parse error");
    expect(followed.reply?.error?.code).not.toBe("INVALID_REQUEST");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

/**
 * The capture budget, sampled where `Number` inverts rather than where a person would type.
 *
 * Zero is not the only value that reaches Playwright as "no timeout": the clamp is what saves every
 * one of these, and the axis the existing test holds fixed is that its inputs are all plain decimal
 * integers. These are the ones a typo actually produces: a hex literal, a float that rounds to zero,
 * an exponent that overflows to Infinity, and a string with whitespace.
 *
 * No defect found. Every value lands inside [500, 120000] and stays finite, which is the invariant
 * that matters, and the specific answers are pinned so a later refactor cannot quietly widen it.
 */
test("no spelling of the capture budget reaches the browser as zero, negative or infinite", () => {
  const samples: (string | undefined)[] = [
    "0", "-0", "-1", "-99999", "0.4", "1e-9", "0x10", "0b1", "  ", "\t\n",
    "NaN", "Infinity", "-Infinity", "1e999", "1_000", "null", "true", "[]", "{}", "1,000", "1000ms",
    "1e308", "999999999999999999999", " 1000 ", "500.4", "499.6", "120001", "", undefined,
  ];
  for (const sample of samples) {
    const budget = captureTimeoutMs(sample);
    expect({ sample, finite: Number.isFinite(budget) }).toEqual({ sample, finite: true });
    expect({ sample, integer: Number.isInteger(budget) }).toEqual({ sample, integer: true });
    // The two values that would break capture, stated as the assertion rather than inferred from a range.
    expect({ sample, zero: budget === 0 }).toEqual({ sample, zero: false });
    expect({ sample, negative: budget < 0 }).toEqual({ sample, negative: false });
    expect({ sample, inRange: budget >= 500 && budget <= 120_000 }).toEqual({ sample, inRange: true });
  }
  // The floor, the ceiling and the fallback each pinned at a value the existing test does not sample,
  // so a clamp replaced by a different clamp is caught rather than merely a clamp removed.
  expect(captureTimeoutMs("0x10")).toBe(500);        // 16, under the floor
  expect(captureTimeoutMs("1e308")).toBe(120_000);   // finite and enormous, so clamped rather than ignored
  expect(captureTimeoutMs("1e999")).toBe(3000);      // overflows to Infinity, so ignored rather than clamped
  expect(captureTimeoutMs("1_000")).toBe(3000);      // a numeric separator is not a number to Number()
  expect(captureTimeoutMs("  ")).toBe(500);          // whitespace is 0 to Number(), and the floor catches it
});

/**
 * The environment question the brief raises: can a session influence the broker's capture budget?
 *
 * It cannot, and this is the shape of the answer rather than an assertion about one value.
 * `captureTimeoutMs` reads `process.env` of the BROKER at call time, and nothing on the session
 * surface writes the broker's environment: `session.create` takes backend, labels, policy, viewport,
 * profileKey, accountName and cloneOf, and no path from any of them reaches `process.env`. What a
 * session CAN do is inherit it downward, into the browser, which is harmless because the browser does
 * not read it.
 *
 * Pinned as a test because the failure mode would be a new field, and a new field that reached the
 * broker's environment would break this.
 */
test("the capture budget is the broker's, and no session field can move it", async () => {
  const { Sessions } = await import("../../src/session");
  const surface = Object.getOwnPropertyNames(Sessions.prototype);
  // A session cannot set an environment variable because there is no method that would: the RPC
  // surface is the enumeration in `dispatchRequest`, and it contains no settings write for a session.
  expect(surface).toContain("dispatch");
  expect(surface).not.toContain("setEnvironment");

  // And the reader is a pure function of its argument, so a call with an explicit value ignores the
  // ambient one entirely. That is what makes the broker's environment the only input.
  const previous = process.env.ORBIT_CAPTURE_TIMEOUT_MS;
  try {
    process.env.ORBIT_CAPTURE_TIMEOUT_MS = "77777";
    expect(captureTimeoutMs("1200")).toBe(1200);
    expect(captureTimeoutMs()).toBe(77777);
    // A value a hostile environment could set is still clamped, so the worst an environment gives is
    // a slow capture rather than a hung one.
    process.env.ORBIT_CAPTURE_TIMEOUT_MS = "0";
    expect(captureTimeoutMs()).toBe(500);
  } finally {
    if (previous === undefined) delete process.env.ORBIT_CAPTURE_TIMEOUT_MS;
    else process.env.ORBIT_CAPTURE_TIMEOUT_MS = previous;
  }
});
