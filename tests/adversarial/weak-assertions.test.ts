/**
 * WEAK ASSERTIONS IN THE EXISTING SUITE, each one shown to stay green against broken code.
 *
 * The project's own rule is that a test which has not run against the unfixed code has not shown that
 * it catches anything. `expect(...).rejects.toBeDefined()` and `expect(x).not.toBe(y)` are the two
 * shapes that can be green against code that is wrong in a different way than the one excluded: a
 * negative on an enumerated value rules out one of many wrong answers, and `toBeDefined()` on a
 * rejection accepts ANY error including one thrown before the subject was reached.
 *
 * The tests below are not replacements for the existing ones and do not touch them. They are the
 * positive assertions those tests are missing, added here so the gap is closed while it is reported.
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditProcessScope } from "../../src/process-scope";

/**
 * `tests/process-scope.test.ts` ends on `await expect(auditProcessScope(42, root)).rejects.toBeDefined()`
 * after replacing a `cgroup` FILE with a directory, which makes `readFile` throw `EISDIR`. That is a
 * real path and the assertion covers it. What the assertion does NOT cover is the other throw in the
 * same function, the one guarding the child list itself:
 *
 *   if (!/^\d+$/.test(token)) throw new Error("Invalid process child list");
 *
 * Mutating that line to `if (false)` leaves `tests/process-scope.test.ts` at 1 pass, 0 fail, verified
 * with `git diff --stat` showing the edit landed. The check is there because a `children` file is read
 * from `/proc` and every token becomes a pid that is signalled or audited, so a token that is not a
 * number must not be pushed as `NaN`.
 *
 * This is the positive form: the rejection is identified by its MESSAGE, so an error from anywhere
 * else in the function cannot satisfy it.
 */
test("a non numeric token in a process child list is refused by name, not merely by throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "adversarial-proc-"));
  await mkdir(join(root, "self"));
  await writeFile(join(root, "self", "cgroup"), "0::/expected\n");
  await mkdir(join(root, "42", "task", "42"), { recursive: true });
  await writeFile(join(root, "42", "cgroup"), "0::/expected\n");
  // A token that is not a pid. Unguarded this becomes `Number("../../etc")`, which is NaN, and then a
  // pid the caller audits or signals.
  await writeFile(join(root, "42", "task", "42", "children"), "43 ../../etc 44");

  // Named, not merely defined: the EISDIR path the existing test exercises would also satisfy a
  // `toBeDefined()` here and says nothing about this guard.
  await expect(auditProcessScope(42, root)).rejects.toThrow("Invalid process child list");

  // And the control, so this is a test of the token rather than of the fixture being unreadable: the
  // same tree with numeric tokens audits cleanly.
  await writeFile(join(root, "42", "task", "42", "children"), "43");
  await mkdir(join(root, "43", "task", "43"), { recursive: true });
  await writeFile(join(root, "43", "cgroup"), "0::/expected\n");
  await writeFile(join(root, "43", "task", "43", "children"), "");
  const audit = await auditProcessScope(42, root);
  expect(audit.checked).toBe(2);
  expect(audit.escaped).toEqual([]);
});

/**
 * The other shape, recorded as an assertion about the CODES rather than about one of them.
 *
 * `tests/browser-crash.test.ts:95` and `tests/native-crash.test.ts:48` both use
 * `rejects.toBeDefined()` for the call against a dead broker, and `tests/launcher.test.ts:41` uses it
 * for a fetch to a socket nobody is listening on. In all three the subject is "this fails", and a
 * connection refused, a parse failure and an assertion inside the test body all satisfy it equally.
 *
 * The fresh broker's answer is asserted properly in `browser-crash.test.ts` a line later
 * (`SESSION_NOT_FOUND`), so the guard there is real. What has no positive form anywhere is the
 * enumeration itself: `src/errors.ts` and the diagnostics allowlist both carry a closed set of codes,
 * and an error escaping with a code outside it is reported to an agent as `BACKEND_ERROR: Request
 * failed`, which the project's own comments call the unattributable failure. This pins the set.
 */
test("every error code the broker can return is in the diagnostics allowlist", async () => {
  const diagnostics = await Bun.file(new URL("../../src/diagnostics.ts", import.meta.url)).text();
  const allowlisted = new Set([...diagnostics.matchAll(/'([A-Z_]{4,})'/g)].map(match => match[1]));
  expect(allowlisted.size).toBeGreaterThan(10);

  // Every code the product throws, read from the source rather than from a list a test maintains,
  // because a list a test maintains is a list that drifts.
  const sources = ["session", "policy", "browser", "fedora", "chrome", "clone", "profiles", "egress", "restore", "advisor"];
  const thrown = new Set<string>();
  for (const name of sources) {
    const text = await Bun.file(new URL(`../../src/${name}.ts`, import.meta.url)).text();
    for (const match of text.matchAll(/new OrbitError\("([A-Z_]+)"/g)) thrown.add(match[1]!);
  }
  expect(thrown.size).toBeGreaterThan(8);

  // A code the broker throws and diagnostics does not know is recorded as BACKEND_ERROR, so the
  // journal says a method failed and not why. Reported as the set rather than as one example.
  //
  // This list USED to carry seven codes, and the finding it recorded is now fixed: `LIMIT_REACHED`,
  // thrown by the 32 session, 10000 action, 64 tab and 32 application ceilings, was absent from the
  // allowlist while `SESSION_LIMIT` and `RESOURCE_LIMIT`, which nothing throws, were present. The
  // ceilings a busy broker actually hits were recorded as the unattributable BACKEND_ERROR that
  // `src/ipc.ts` names. Measured through the real Diagnostics class before the fix, and again after.
  //
  // The expectation is now EMPTY rather than deleted, because empty is the assertion: any code this
  // project starts throwing without listing fails here, which is what this test was written for.
  const unknown = [...thrown].filter(code => !allowlisted.has(code)).sort();
  expect(unknown).toEqual([]);
  // And the other side of the same drift, also fixed: the allowlist no longer carries codes nothing
  // throws. A phantom entry is what made the absence hard to see, since the list LOOKED like it
  // covered limits. tests/diagnostic-codes.test.ts holds this across the whole of src/**; here it is
  // pinned for the ten modules this file reads.
  for (const orphan of ["SESSION_LIMIT", "RESOURCE_LIMIT"]) {
    expect(allowlisted.has(orphan)).toBe(false);
  }
});
