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
  // Including the skip count, which is the honest half of the figure: a green suite on a platform that
  // skips 95 tests is not a port, and the README has to say so where it says the rest.
  expect(readme).toMatch(/95 skip/);
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
  const limits = readme.slice(readme.indexOf("docs/windows-measured.md") - 900);
  for (const absent of ["private display", "systemd", "Linux capabilities"])
    expect(limits).toContain(absent);
});
