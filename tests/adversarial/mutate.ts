#!/usr/bin/env bun
/**
 * The mutation sweep for tests/adversarial/, run one mutation at a time.
 *
 * Two rules the sweep enforces on itself, because both failure modes look exactly like a surviving
 * mutant:
 *
 *   1. A mutation that does not APPLY is reported as SKIP(anchor), never as a survivor. The anchor is
 *      matched against the source as spelled, and `git diff --stat` is consulted after the write to
 *      prove the file actually changed.
 *   2. The file is restored with `git checkout --` and the tree is proven clean of it before the next
 *      row runs, so one row cannot contaminate the next.
 */
import { $ } from "bun";

/**
 * An edit is one anchor and its replacement. A row carries a LIST of them, because two of these
 * invariants are held in two places at once and removing either alone is defence in depth doing its
 * job rather than a defect: a row that mutated only one would be recorded as a survivor and would be
 * lying about the code. Where a row has two edits, each was also run alone first and the single edit
 * survivor is recorded in the sweep's own notes.
 */
type Edit = { file: string; anchor: string; replacement: string };
type Row = { invariant: string; edits: Edit[]; expect: string[]; note?: string };

const rows: Row[] = [
  {
    invariant: "the browser gets no reach onto the person's Wayland or X display",
    edits: [{ file: "src/chrome.ts", anchor: `![\"DISPLAY\", \"WAYLAND_DISPLAY\", \"WAYLAND_SOCKET\", \"XAUTHORITY\"].includes(key))) as Record<string, string>;`, replacement: `true)) as Record<string, string>;` }],
    expect: ["tests/adversarial/escape.test.ts"],
  },
  {
    invariant: "the browser never reaches the person's session bus",
    edits: [{ file: "src/chrome.ts", anchor: `env.DBUS_SESSION_BUS_ADDRESS = options.sessionBus ?? \`unix:path=\${profile}/no-session-bus\`;`, replacement: `env.DBUS_SESSION_BUS_ADDRESS = options.sessionBus ?? process.env.DBUS_SESSION_BUS_ADDRESS ?? "";` }],
    expect: ["tests/adversarial/escape.test.ts"],
  },
  {
    invariant: "a profile key is leased to exactly one session",
    edits: [{ file: "src/session.ts", anchor: `if (this.leases.has(lease)) throw new OrbitError("PROFILE_BUSY", "Profile key is leased to another session");`, replacement: `if (false) throw new OrbitError("PROFILE_BUSY", "Profile key is leased to another session");` }],
    expect: ["tests/adversarial/parallel-sessions.test.ts"],
  },
  {
    invariant: "a repeated request id performs one action",
    edits: [{ file: "src/session.ts", anchor: `      return existing.result;`, replacement: `      if (false) return existing.result;` }],
    expect: ["tests/adversarial/parallel-sessions.test.ts"],
  },
  {
    invariant: "a policy only ever narrows",
    edits: [{ file: "src/policy.ts", anchor: `  const allow = limits.allow ? policy.allow.filter(entry => limits.allow?.includes(entry)) : policy.allow;`, replacement: `  const allow = limits.allow ? [...new Set([...policy.allow, ...limits.allow])] : policy.allow;` }],
    expect: ["tests/adversarial/policy-ratchet.test.ts"],
  },
  {
    invariant: "narrowing does not mutate the module default the next session starts from",
    edits: [{ file: "src/policy.ts", anchor: `  const deny = input.deny === undefined ? [...readOnlyPolicy.deny] : list(input.deny, "deny");`, replacement: `  const deny = input.deny === undefined ? readOnlyPolicy.deny : list(input.deny, "deny");` }],
    expect: ["tests/adversarial/policy-ratchet.test.ts"],
  },
  {
    // The first attempt at this row added a `url` field beside `inputLength` and SURVIVED, for a
    // reason that is about the mutation and not about the test: a `fill` action carries no `url`, so
    // the added field was always undefined. The invariant lives in the origin-only extraction, so
    // that is what is mutated.
    invariant: "the journal records a destination as an origin and never as a full URL",
    edits: [{ file: "src/policy.ts", anchor: `  if (input.url !== undefined) { try { origin = new URL(input.url).origin; } catch { origin = undefined; } }`, replacement: `  if (input.url !== undefined) { origin = input.url; }` }],
    expect: ["tests/adversarial/reaping-and-secrets.test.ts"],
  },
  {
    invariant: "the durable journal file is private to this user",
    edits: [{ file: "src/session.ts", anchor: `    return appendFile(session.journalPath, \`\${JSON.stringify(entry)}\\n\`, { mode: 0o600 }).catch(() => {});`, replacement: `    return appendFile(session.journalPath, \`\${JSON.stringify(entry)}\\n\`, { mode: 0o644 }).catch(() => {});` }],
    expect: ["tests/adversarial/reaping-and-secrets.test.ts"],
  },
  {
    // Also a pair, and also the code being right. The profile is removed by `reap`'s release chain AND
    // again by `stop()`, which the source calls belt and braces. Verified separately: the release
    // chain alone, SURVIVED; the `stop()` call alone, SURVIVED; both, KILLED.
    invariant: "a session's profile and restore points do not outlive it, in two independent layers",
    edits: [
      { file: "src/session.ts",
        anchor: `          .finally(() => rm(profile, { recursive: true, force: true }).catch(() => {}));`,
        replacement: `          .finally(() => Promise.resolve());` },
      { file: "src/session.ts",
        anchor: `      await rm(session.profile, { recursive: true, force: true }).catch(() => {});`,
        replacement: `      await Promise.resolve();` },
    ],
    expect: ["tests/adversarial/reaping-and-secrets.test.ts"],
  },
  {
    // Recorded with BOTH layers mutated, because either one alone SURVIVES and that is the code being
    // right rather than the test being weak: `run()` hashes the session id on the way in, and
    // `report()` rebuilds every field from an allowlist on the way out, where `/^[a-f0-9]{16}$/`
    // rejects a 36 character uuid. Removing the hash alone leaves the read side dropping the raw
    // value; removing the read check alone leaves a hash to print. Verified separately: hash only,
    // SURVIVED; read check only, SURVIVED; both, KILLED.
    invariant: "the diagnostics report carries a hashed session id, in two independent layers",
    edits: [
      { file: "src/diagnostics.ts",
        anchor: `const hash = (value: unknown) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;`,
        replacement: `const hash = (value: unknown) => typeof value === 'string' ? value : undefined;` },
      { file: "src/diagnostics.ts",
        anchor: `              ...(/^[a-f0-9]{16}$/.test(String(e.session)) ? { session: String(e.session) } : {}),`,
        replacement: `              ...(e.session === undefined ? {} : { session: String(e.session) }),` },
    ],
    expect: ["tests/adversarial/reaping-and-secrets.test.ts"],
  },
  {
    invariant: "the capture budget never reaches the browser as zero or infinite",
    edits: [{ file: "src/browser.ts", anchor: `  return Math.min(120_000, Math.max(500, Math.round(requested)));`, replacement: `  return Math.round(requested);` }],
    expect: ["tests/adversarial/cli-document.test.ts"],
  },
  {
    invariant: "a non numeric capture budget is ignored rather than read as NaN",
    edits: [{ file: "src/browser.ts", anchor: `  if (!raw || !Number.isFinite(requested)) return 3000;`, replacement: `  if (!raw) return 3000;` }],
    expect: ["tests/adversarial/cli-document.test.ts"],
  },
  {
    invariant: "an action document that is not there is refused by name, never read as null",
    edits: [{ file: "src/cli.ts", anchor: `    catch { throw new OrbitError("INVALID_REQUEST", \`No action document at \${path}\`); }`, replacement: `    catch { raw = "null"; }` }],
    expect: ["tests/adversarial/cli-document.test.ts"],
  },
  {
    invariant: "observation is policed like any other action",
    edits: [{ file: "src/session.ts", anchor: `    const decision = decide(session.policy, "observe");`, replacement: `    const decision = { outcome: "allow" } as ReturnType<typeof decide>;` }],
    expect: ["tests/adversarial/policy-ratchet.test.ts", "tests/adversarial/parallel-sessions.test.ts"],
  },
];

const clean = async (files: string[]) => {
  for (const file of new Set(files)) {
    await $`git checkout -- ${file}`.quiet();
    const status = (await $`git status --porcelain -- ${file}`.text()).trim();
    if (status) throw new Error(`Could not restore ${file}: ${status}`);
  }
};

const only = process.argv[2];
for (const row of rows) {
  if (only && !row.invariant.includes(only)) continue;
  const files = row.edits.map(edit => edit.file);
  let missing = false;
  for (const edit of row.edits) {
    const source = await Bun.file(edit.file).text();
    if (!source.includes(edit.anchor)) {
      console.log(`SKIP(anchor)  ${row.invariant}  |  anchor not found in ${edit.file}: ${edit.anchor.slice(0, 60)}`);
      missing = true;
      break;
    }
    await Bun.write(edit.file, source.replace(edit.anchor, edit.replacement));
  }
  if (missing) { await clean(files); continue; }
  // The rule this sweep enforces on itself: a mutation that did not land is not a survivor. A perl
  // one liner whose anchor never matched left a suite green and looked exactly like a survivor, so the
  // diff is consulted rather than trusted.
  const landed = (await $`git diff --stat -- ${files}`.text()).trim();
  const changed = Number(/(\d+) insertion/.exec(landed)?.[1] ?? 0);
  if (!landed || changed < row.edits.length) {
    await clean(files);
    console.log(`SKIP(anchor)  ${row.invariant}  |  expected ${row.edits.length} changed lines, diff says: ${landed || "nothing"}`);
    continue;
  }
  try {
    const run = await $`bun test ${row.expect}`.nothrow().quiet();
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    const failed = /\n\s*(\d+) fail/.exec(output)?.[1] ?? "0";
    const first = output.split("\n").find(line => line.includes("(fail)"))?.trim() ?? "";
    const message = output.split("\n").find(line => line.startsWith("error:"))?.trim() ?? "";
    console.log(`${Number(failed) > 0 ? "KILLED" : "SURVIVED"}  ${row.invariant}\n    ${row.edits.length} edit(s) in ${[...new Set(files)].join(", ")}\n    ${failed} fail  ${first}\n    ${message}`);
  } finally {
    await clean(files);
  }
}