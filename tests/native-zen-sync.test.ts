import { afterEach, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietZenSync } from "../src/native-zen-sync";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-zen-sync-"));
  roots.push(root);
  const source = join(root, "source");
  const clone = join(root, "clone");
  await mkdir(source);
  await mkdir(clone);
  return { root, source, clone };
}

test("quiets only the private copy while retaining website state", async () => {
  const { source, clone } = await fixture();
  const account = '{"version":1,"accountData":{"uid":"synthetic","sessionToken":"synthetic"}}';
  const prefs = 'user_pref("services.sync.username", "synthetic");\n';
  for (const directory of [source, clone]) {
    await writeFile(join(directory, "signedInUser.json"), account);
    await writeFile(join(directory, "user.js"), prefs);
    await writeFile(join(directory, "cookies.sqlite"), "site-cookie-marker");
  }

  await quietZenSync(clone, source);

  expect(await Bun.file(join(clone, "signedInUser.json")).exists()).toBe(false);
  expect(await readFile(join(clone, "user.js"), "utf8"))
    .toBe(`${prefs}\nuser_pref("services.sync.username", "");\n`);
  expect(await readFile(join(clone, "cookies.sqlite"), "utf8")).toBe("site-cookie-marker");
  expect(await readFile(join(source, "signedInUser.json"), "utf8")).toBe(account);
  expect(await readFile(join(source, "user.js"), "utf8")).toBe(prefs);
  expect(await readFile(join(source, "cookies.sqlite"), "utf8")).toBe("site-cookie-marker");
});

test("rejects the source directory as the clone", async () => {
  const { source } = await fixture();
  await writeFile(join(source, "signedInUser.json"), "source-account");
  await expect(quietZenSync(source, source)).rejects.toThrow();
  expect(await readFile(join(source, "signedInUser.json"), "utf8")).toBe("source-account");
});

test("rejects a symlinked account record before unlinking it", async () => {
  const { source, clone } = await fixture();
  await writeFile(join(source, "signedInUser.json"), "source-account");
  await symlink(join(source, "signedInUser.json"), join(clone, "signedInUser.json"));
  await expect(quietZenSync(clone, source)).rejects.toThrow();
  expect((await lstat(join(clone, "signedInUser.json"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(source, "signedInUser.json"), "utf8")).toBe("source-account");
});

test("rejects a symlinked user.js without writing to the source", async () => {
  const { source, clone } = await fixture();
  await writeFile(join(source, "user.js"), "source-prefs");
  await symlink(join(source, "user.js"), join(clone, "user.js"));
  await expect(quietZenSync(clone, source)).rejects.toThrow();
  expect(await readFile(join(source, "user.js"), "utf8")).toBe("source-prefs");
});

test("rejects a hardlinked user.js without writing to the source", async () => {
  const { source, clone } = await fixture();
  await writeFile(join(source, "user.js"), "source-prefs");
  await link(join(source, "user.js"), join(clone, "user.js"));
  await expect(quietZenSync(clone, source)).rejects.toThrow();
  expect(await readFile(join(source, "user.js"), "utf8")).toBe("source-prefs");
});
