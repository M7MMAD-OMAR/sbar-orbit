/**
 * Two defects the first real run of `.github/workflows/platform-probes.yml` found, on a GitHub
 * `windows-latest` runner on 19 September 2026. Neither was a Windows defect: both were a
 * development host's assumptions, which only a slower and differently quoted machine could expose.
 *
 * 1. Capture had a hardcoded 3000 ms budget. The runner beat it on the first capture after a cold
 *    navigate, while Playwright was still waiting for fonts, and the agent read back
 *    `{"ok":false,"error":{"code":"BACKEND_ERROR","message":"Request failed"}}`. The real cause,
 *    `TimeoutError: screenshot: Timeout 3000ms exceeded`, reached the broker's stderr and nothing
 *    else. `src/ipc.ts` already names this class: BACKEND_ERROR is unattributable, the journal
 *    records that a method failed and not why.
 *
 * 2. `act` took its action document only as a command line argument, which PowerShell will not
 *    deliver intact. The workflow already routed it through `cmd /c` with doubled quotes because of
 *    that, and it STILL produced `CLI_ERROR: JSON Parse error: Unterminated string` on the runner.
 *
 * These tests run everywhere. The budget and parsing halves need no browser, so they are not
 * skipped on a machine without one, which is the point: the failure was on a platform this
 * project's developer host is not.
 */
import { test, expect } from "bun:test";
// `bunExecutable()`, not the string "bun": on the Windows guest Bun is NOT on PATH, so a bare spawn
// failed and the launcher's error text was then parsed as JSON, reporting a JSON syntax error for what
// was really a missing program. The install path has resolved Bun by location since the port began.
import { bunExecutable } from "../src/install";
import { captureTimeoutMs } from "../src/browser";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `.pathname`. On Windows a file URL's pathname is `/C:/orbit/.../src/cli.ts`,
// with a LEADING SLASH, which is not a path Windows can open: `bun run` reported
// `Command failed: Was there a typo in the url or port?` and the test then parsed that JSON reply
// while expecting the CLI's own. The failure read as a JSON syntax error for what was really a
// malformed path. `fileURLToPath` is the conversion that knows about the drive letter.
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("the capture budget defaults to the 3000 ms it used to hardcode", () => {
  expect(captureTimeoutMs(undefined)).toBe(3000);
  expect(captureTimeoutMs("")).toBe(3000);
});

test("a slower host can raise the capture budget", () => {
  expect(captureTimeoutMs("15000")).toBe(15000);
  expect(captureTimeoutMs("500")).toBe(500);
});

test("the capture budget refuses a value that would break capture rather than trusting it", () => {
  // Playwright reads timeout: 0 as no timeout at all, so a typo would hang a session forever, and a
  // NaN from a non numeric value would do the same. Both are clamped or ignored, not obeyed.
  expect(captureTimeoutMs("0")).toBe(500);
  expect(captureTimeoutMs("-1")).toBe(500);
  expect(captureTimeoutMs("banana")).toBe(3000);
  expect(captureTimeoutMs("99999999")).toBe(120_000);
  expect(Number.isFinite(captureTimeoutMs("banana"))).toBe(true);
});

test("act reads its action document from a file, which no shell can mangle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-act-"));
  try {
    const path = join(directory, "action.json");
    await writeFile(path, JSON.stringify({ type: "navigate", url: "https://example.com/" }));
    // No broker is running on this socket, so the command must get PAST parsing and fail on the
    // CONNECTION. Asserting only "not INVALID_REQUEST" is not enough and was shown not to be: the
    // unfixed code hands `@path` straight to JSON.parse, which throws, which the CLI reports as
    // CLI_ERROR, and that assertion stayed green against code that cannot read a file at all. So
    // the parser's own message is what must be absent.
    const run = Bun.spawnSync([bunExecutable(), "run", cli, "act", "some-session", `@${path}`],
      { env: { ...process.env, ORBIT_SOCKET: join(directory, "absent.sock") }, stdout: "pipe", stderr: "pipe" });
    const reply = JSON.parse(run.stderr.toString().trim() || run.stdout.toString().trim());
    expect(reply.ok).toBe(false);
    expect(reply.error.code).not.toBe("INVALID_REQUEST");
    expect(reply.error.message).not.toContain("JSON Parse error");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("act reads its action document from standard input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-act-"));
  try {
    const run = Bun.spawnSync([bunExecutable(), "run", cli, "act", "some-session", "-"],
      { env: { ...process.env, ORBIT_SOCKET: join(directory, "absent.sock") },
        stdin: new TextEncoder().encode(JSON.stringify({ type: "navigate", url: "https://example.com/" })),
        stdout: "pipe", stderr: "pipe" });
    const reply = JSON.parse(run.stderr.toString().trim() || run.stdout.toString().trim());
    expect(reply.ok).toBe(false);
    expect(reply.error.code).not.toBe("INVALID_REQUEST");
    expect(reply.error.message).not.toContain("JSON Parse error");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a mangled action document says what it could not parse and where it came from", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-act-"));
  try {
    // Exactly what the runner delivered: the closing quote eaten by the shell.
    const run = Bun.spawnSync([bunExecutable(), "run", cli, "act", "some-session", '{"type":"navigate","url":"https://example.com/'],
      { env: { ...process.env, ORBIT_SOCKET: join(directory, "absent.sock") }, stdout: "pipe", stderr: "pipe" });
    const reply = JSON.parse(run.stderr.toString().trim() || run.stdout.toString().trim());
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("INVALID_REQUEST");
    // The message must name the remedy, not just the parser's complaint.
    expect(reply.error.message).toContain("the command line");
    expect(reply.error.message).toContain("@path");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a missing action document is refused by name rather than read as null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-act-"));
  try {
    const absent = join(directory, "not-here.json");
    const run = Bun.spawnSync([bunExecutable(), "run", cli, "act", "some-session", `@${absent}`],
      { env: { ...process.env, ORBIT_SOCKET: join(directory, "absent.sock") }, stdout: "pipe", stderr: "pipe" });
    const reply = JSON.parse(run.stderr.toString().trim() || run.stdout.toString().trim());
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("INVALID_REQUEST");
    expect(reply.error.message).toContain(absent);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
