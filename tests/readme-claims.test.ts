import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The front door has to agree with what was measured.
 *
 * This project's rule is that a capability is claimed at the tier its evidence supports and no higher.
 * The inverse is the same defect wearing the other face: the README said "macOS and Windows remain
 * unmeasured: there is no such machine in this project's reach" for several days after a Windows 11
 * guest was running the suite, installing the published release, and serving a browser session to an
 * agent host over MCP. A stale denial is as wrong as a stale overclaim, and it is worse in one way:
 * nobody files a bug about a capability the front page says does not exist.
 *
 * Checked as text rather than by hand, because the drift was invisible for as long as nobody re-read
 * a paragraph they had already written.
 */
const project = resolve(import.meta.dir, "..");
const readme = await readFile(resolve(project, "README.md"), "utf8");

test("the README does not claim Windows is unmeasured, and points at what was measured", () => {
  // The exact sentence that went stale, and the shapes it would come back as.
  for (const denial of [
    "macOS and Windows remain unmeasured",
    "There is no macOS,\nWindows or non Fedora Linux machine",
    "no macOS, Windows or non Fedora Linux machine",
  ]) expect(readme).not.toContain(denial);

  // And it names the document that carries the evidence, so a reader can check rather than trust.
  expect(readme).toContain("docs/windows-measured.md");
  // Including a skip count, which is the honest half of the figure: a green suite on a platform that
  // skips most of a suite is not a port, and the README has to say so where it says the rest.
  //
  // The SHAPE, not the number. Pinning the literal count made this gate hold the README at a figure
  // its own evidence document had already superseded, and it would have FAILED on the correction: the
  // README said 95 while support-tiers.md and windows-measured.md both said 96 from the same commit.
  // A gate that enforces a stale claim is worse than no gate, on a project whose rule is that a claim
  // sits at the tier its evidence supports.
  expect(readme).toMatch(/\d+ skips? is the honest half/);
});

test("the README names the Windows entry point wherever it names the Linux one", async () => {
  // Every installer invocation a reader could copy. `install.sh` appears in prose too, so this counts
  // fenced commands: a block that tells a Windows reader to run a bash script is the failure.
  const blocks = [...readme.matchAll(/```(?:sh|bash|bat|console)\n([\s\S]*?)```/g)].map(match => match[1] ?? "");
  const installBlocks = blocks.filter(block => /install\.(sh|cmd)/.test(block));
  expect(installBlocks.length).toBeGreaterThan(0);
  expect(installBlocks.some(block => block.includes("install.cmd"))).toBe(true);
  expect(installBlocks.some(block => block.includes("./install.sh"))).toBe(true);

  // The file the Windows block tells people to run has to exist, which is the check that would have
  // caught a README written ahead of the code.
  expect(await Bun.file(resolve(project, "install.cmd")).exists()).toBe(true);
});

test("the README states what Windows does not carry, not only what it does", () => {
  // The three the support tiers call Linux only. A README that lists the wins without the limits is
  // how a `Limited` tier gets read as a full port.
  const marker = readme.indexOf("docs/windows-measured.md");
  expect(marker).toBeGreaterThan(-1);
  // Clamped. A negative `slice` index counts from the end, so if the marker ever moved into the first
  // 900 characters this assertion would quietly widen to the whole file and pass on a README that no
  // longer states the limits anywhere near the evidence.
  const limits = readme.slice(Math.max(0, marker - 900), marker + 900);
  for (const absent of ["private display", "systemd", "Linux capabilities"])
    expect(limits).toContain(absent);
});

test("the README does not claim macOS is unmeasured, and points at what was measured", () => {
  // The same stale denial in its macOS form. It survived several days on the Windows side after a
  // guest was running the suite, and the macOS sentences had exactly the same shape.
  for (const denial of [
    "macOS remains unmeasured",
    "There is no macOS machine in this\nproject's reach",
    "no macOS machine in this project's reach",
  ]) expect(readme).not.toContain(denial);
  expect(readme).toContain("docs/macos-measured.md");
});

test("the README says the macOS budget is advisory wherever it claims macOS works", () => {
  // The one thing a person could reasonably carry over from Linux and be wrong about. Orbit's whole
  // rule is that a capability is claimed at the tier its evidence supports, and a budget that reads
  // like the Linux one while enforcing nothing is the most expensive way to break it. So the word
  // has to appear, and it has to appear near the macOS evidence rather than in a distant footnote.
  const marker = readme.indexOf("docs/macos-measured.md");
  expect(marker).toBeGreaterThan(-1);
  const nearby = readme.slice(Math.max(0, marker - 900), marker + 900);
  expect(nearby).toMatch(/advisory/);
  // And the honest half of the containment figure: the number of processes it was measured against,
  // not merely that nothing survived.
  expect(readme).toMatch(/0 of \d+ Chrome processes/);
});
