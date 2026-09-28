import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateStagedCodexCandidate, writeStagedCodexCandidateManifest } from "../src/native-codex-candidate";

async function fixture() {
  const root = await mkdtemp("/var/tmp/orbit-codex-candidate-test-");
  const app = join(root, "app");
  const source = join(root, "source");
  const feature = join(app, ".codex-linux", "features", "shared-app-server-socket");
  await mkdir(join(app, "resources"), { recursive: true, mode: 0o700 });
  await mkdir(feature, { recursive: true, mode: 0o700 });
  await mkdir(join(source, "resources"), { recursive: true, mode: 0o700 });
  const executable = join(app, "ChatGPT");
  await writeFile(executable, "fixture desktop binary", { mode: 0o700 });
  await writeFile(join(app, "version"), "42.3.0", { mode: 0o600 });
  await writeFile(join(app, "resources", "app.asar"), "patched fixture ASAR", { mode: 0o600 });
  await writeFile(join(app, "resources", "codex"), "fixture CLI", { mode: 0o700 });
  await writeFile(join(feature, "orphan-reaper.js"), "fixture reaper", { mode: 0o600 });
  await writeFile(join(feature, "sidebar-state-bridge.js"), "fixture bridge", { mode: 0o600 });
  await writeFile(join(source, "ChatGPT"), "fixture desktop binary", { mode: 0o700 });
  await writeFile(join(source, "version"), "42.3.0", { mode: 0o600 });
  await writeFile(join(source, "resources", "app.asar"), "original fixture ASAR", { mode: 0o600 });
  return { root, app, source, executable };
}

test("broker-pinned Codex manifest verifies the complete private candidate tree", async () => {
  const f = await fixture();
  try {
    const { manifestPath, manifestSha256 } = await writeStagedCodexCandidateManifest(f.executable, f.source);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.files["app/resources/codex"]).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(manifest.files)).toHaveLength(6);
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source)).resolves.toBeUndefined();
    await expect(validateStagedCodexCandidate(f.executable, "0".repeat(64), f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Codex candidate rejects changed ASAR and unlisted files after pinning", async () => {
  const f = await fixture();
  try {
    const { manifestSha256 } = await writeStagedCodexCandidateManifest(f.executable, f.source);
    await writeFile(join(f.app, "resources", "app.asar"), "modified fixture ASAR");
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    await writeFile(join(f.app, "unexpected.js"), "extra code");
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source))
      .rejects.toThrow(/tree differs/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Codex candidate rejects linked and shared paths before reading its manifest", async () => {
  const f = await fixture();
  try {
    const { manifestSha256 } = await writeStagedCodexCandidateManifest(f.executable, f.source);
    await symlink(join(f.app, "version"), join(f.app, "linked-version"));
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    await rm(join(f.app, "linked-version"));
    await link(join(f.app, "version"), join(f.app, "linked-version"));
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    await rm(join(f.app, "linked-version"));
    await chmod(f.root, 0o755);
    await expect(validateStagedCodexCandidate(f.executable, manifestSha256, f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Codex candidate rejects an unpatched ASAR and a path outside its private root", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.app, "resources", "app.asar"), "original fixture ASAR");
    await expect(writeStagedCodexCandidateManifest(f.executable, f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(validateStagedCodexCandidate(join(f.root, "other", "ChatGPT"), "0".repeat(64), f.source))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
